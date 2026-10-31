//! Preview/apply and DDL against PostgreSQL. Runs only when AHSANDB_TEST_PG is set; every test works
//! in its own `ahsandb_t_<rand>` schema, dropped at the end.
mod common;

use std::collections::BTreeMap;

use ahsandb_lib::db::{Manager, Pool, preview};
use ahsandb_lib::ddl;
use ahsandb_lib::error::AppError;
use ahsandb_lib::model::*;
use common::*;
use serde_json::json;

const D: Driver = Driver::Postgres;

fn pg() -> Option<Connection> {
    from_env("AHSANDB_TEST_PG", D)
}

async fn temp_schema(mgr: &Manager, pool: &Pool, c: &Connection) -> String {
    let s = format!("ahsandb_t_{}", rand_suffix());
    rows(mgr, pool, c, &format!("CREATE SCHEMA {s}; SELECT 1")).await;
    s
}

async fn drop_schema(mgr: &Manager, pool: &Pool, c: &Connection, s: &str) {
    rows(mgr, pool, c, &format!("DROP SCHEMA {s} CASCADE; SELECT 1")).await;
}

fn col(name: &str, ty: &str, nullable: bool) -> ColumnDef {
    ColumnDef { name: name.into(), original_name: None, type_name: ty.into(), nullable, default: None, auto_increment: false }
}

#[tokio::test]
async fn apply_rules_and_literals() {
    let Some(c) = pg() else { return };
    let (mgr, pool) = open(&c).await;
    let s = temp_schema(&mgr, &pool, &c).await;
    rows(&mgr, &pool, &c, &format!("CREATE TABLE {s}.t (id int PRIMARY KEY, name text, n int); INSERT INTO {s}.t VALUES (1, 'a', 1), (2, 'b', 2); SELECT 1")).await;

    let tricky = ["it's", r"back\slash", r"\'", "unicode ✓ 日本語 🚀", "line1\nline2\ttab", "'; DROP TABLE x;--", "\"dq\"", "", "$$ $x$"];
    let inserts: Vec<RowChange> = tricky
        .iter()
        .enumerate()
        .map(|(i, v)| RowChange::Insert { values: BTreeMap::from([("id".into(), json!(100 + i)), ("name".into(), json!(v))]) })
        .collect();
    apply_ok(&mgr, &pool, &c, ddl::plan_row_changes(D, &s, "t", &inserts).unwrap()).await;
    let got = rows(&mgr, &pool, &c, &format!("SELECT name FROM {s}.t WHERE id >= 100 ORDER BY id")).await;
    assert_eq!(got.into_iter().map(|mut r| r.remove(0)).collect::<Vec<_>>(), tricky.iter().map(|v| json!(v)).collect::<Vec<_>>());

    // expect_rows mismatch → rollback of the earlier valid update.
    let key = |id: i64| BTreeMap::from([("id".to_string(), json!(id))]);
    let changes = [
        RowChange::Update { key: key(1), values: BTreeMap::from([("name".into(), json!("changed"))]) },
        RowChange::Delete { key: key(999) },
    ];
    let r = apply_plan(&mgr, &pool, &c, ddl::plan_row_changes(D, &s, "t", &changes).unwrap()).await.unwrap();
    assert_eq!((r.executed, r.failed.as_ref().unwrap().index, r.rolled_back), (1, 1, true));
    assert!(r.failed.unwrap().message.starts_with("Expected 1 row, got 0"));
    assert_eq!(rows(&mgr, &pool, &c, &format!("SELECT name FROM {s}.t WHERE id = 1")).await[0][0], json!("a"));

    // Non-numeric text into an int column: database error, nothing committed.
    let changes = [
        RowChange::Insert { values: BTreeMap::from([("id".into(), json!(3)), ("n".into(), json!("7"))]) },
        RowChange::Update { key: key(1), values: BTreeMap::from([("n".into(), json!("abc"))]) },
    ];
    let r = apply_plan(&mgr, &pool, &c, ddl::plan_row_changes(D, &s, "t", &changes).unwrap()).await.unwrap();
    assert!(r.rolled_back && r.failed.as_ref().unwrap().message.contains("invalid input syntax"), "{r:?}");
    assert_eq!(rows(&mgr, &pool, &c, &format!("SELECT count(*) FROM {s}.t WHERE id = 3")).await[0][0], json!(0));

    // Numeric text as a string literal is cast by the server; NULL key → IS NULL (matches nothing here).
    let ok = [RowChange::Update { key: key(2), values: BTreeMap::from([("n".into(), json!("42"))]) }];
    apply_ok(&mgr, &pool, &c, ddl::plan_row_changes(D, &s, "t", &ok).unwrap()).await;
    assert_eq!(rows(&mgr, &pool, &c, &format!("SELECT n FROM {s}.t WHERE id = 2")).await[0][0], json!(42));

    // Rules: unknown id, read-only, production.
    assert!(matches!(preview::apply(&mgr, &pool, &c, "nope", true).await, Err(AppError::NotFound(_))));
    let p = preview::store(&mgr, &c.id, ddl::plan_drop(D, ObjectKind::Table, &s, "t").unwrap()).await.unwrap();
    let ro = Connection { read_only: true, ..c.clone() };
    assert!(matches!(preview::apply(&mgr, &pool, &ro, &p.id, true).await, Err(AppError::ReadOnly(_))));
    let prod = Connection { env: Env::Prod, ..c.clone() };
    assert!(matches!(preview::apply(&mgr, &pool, &prod, &p.id, false).await, Err(AppError::NeedsConfirmation(v)) if v == p.statements));
    let r = preview::apply(&mgr, &pool, &prod, &p.id, true).await.unwrap();
    assert!(r.failed.is_none());
    assert!(matches!(ddl::load_table(&pool, &s, "t").await, Err(AppError::NotFound(_))));
    drop_schema(&mgr, &pool, &c, &s).await;
}

#[tokio::test]
async fn load_seed_tables() {
    let Some(c) = pg() else { return };
    let (_mgr, pool) = open(&c).await;
    let o = ddl::load_table(&pool, "public", "orders").await.unwrap();
    let cols: Vec<_> = o.columns.iter().map(|c| (c.name.as_str(), c.type_name.as_str(), c.nullable, c.default.as_deref(), c.auto_increment)).collect();
    assert_eq!(cols, [
        ("id", "bigint", false, None, true),
        ("customer_id", "bigint", false, None, false),
        ("status", "text", false, None, false),
        ("total", "numeric(14,2)", false, None, false),
        ("note", "text", true, None, false),
        ("meta", "jsonb", true, None, false),
        ("paid", "boolean", false, Some("false"), false),
        ("created_at", "timestamp with time zone", false, Some("now()"), false),
    ]);
    assert_eq!(o.primary_key, ["id"]);
    assert_eq!(o.foreign_keys, [ForeignKeyDef {
        name: Some("orders_customer_id_fkey".into()),
        columns: vec!["customer_id".into()],
        ref_schema: None,
        ref_table: "customers".into(),
        ref_columns: vec!["id".into()],
        on_delete: None,
        on_update: None,
    }]);
    assert!(o.indexes.is_empty() && o.checks.is_empty());
    let i = ddl::load_table(&pool, "public", "order_items").await.unwrap();
    assert_eq!(i.foreign_keys.iter().map(|f| f.ref_table.as_str()).collect::<Vec<_>>(), ["orders", "products"]);
    assert_eq!(i.columns[4].type_name, "numeric(14,2)");
    let same = ddl::plan_schema_changes(D, &[TableChange { original: Some(i.clone()), target: Some(i) }]).unwrap();
    assert!(same.statements.is_empty(), "{:?}", same.statements);
    assert!(matches!(ddl::load_table(&pool, "public", "v_open_orders").await, Err(AppError::NotFound(_))));
}

#[tokio::test]
async fn create_alter_drop_roundtrip() {
    let Some(c) = pg() else { return };
    let (mgr, pool) = open(&c).await;
    let s = temp_schema(&mgr, &pool, &c).await;
    let parent = TableDef {
        schema: s.clone(),
        name: "parent".into(),
        columns: vec![ColumnDef { auto_increment: true, ..col("id", "bigint", false) }, col("code", "character varying(20)", false)],
        primary_key: vec!["id".into()],
        foreign_keys: vec![],
        indexes: vec![IndexDef { name: "parent_code_key".into(), columns: vec!["code".into()], unique: true }],
        checks: vec![],
    };
    let child = TableDef {
        name: "child".into(),
        columns: vec![
            col("id", "integer", false),
            col("parent_id", "bigint", true),
            ColumnDef { default: Some("'x'::text".into()), ..col("note", "text", true) },
            col("qty", "integer", true),
            col("old", "text", true),
        ],
        primary_key: vec!["id".into()],
        indexes: vec![],
        checks: vec![CheckDef { name: Some("qty_pos".into()), expression: "qty > 0".into() }],
        ..parent.clone()
    };
    let create = [TableChange { original: None, target: Some(child.clone()) }, TableChange { original: None, target: Some(parent.clone()) }];
    let plan = ddl::plan_schema_changes(D, &create).unwrap();
    assert!(plan.transactional && plan.warnings.is_empty());
    apply_ok(&mgr, &pool, &c, plan).await;
    for t in [&parent, &child] {
        assert_eq!(normalized(&ddl::load_table(&pool, &s, &t.name).await.unwrap(), true), normalized(t, true));
    }
    rows(&mgr, &pool, &c, &format!("INSERT INTO {s}.parent (code) VALUES ('p'); INSERT INTO {s}.child VALUES (1, 1, 'n', 5, 'o'); SELECT 1")).await;

    // Rename table + column, change type and nullability/default, add FK and index, drop a column, change PK.
    let o = ddl::load_table(&pool, &s, "child").await.unwrap();
    let mut t = o.clone();
    t.name = "kid".into();
    t.columns[2].name = "remark".into();
    t.columns[2].default = None;
    t.columns[3].type_name = "bigint".into();
    t.columns[3].nullable = false;
    t.columns.retain(|c| c.name != "old");
    t.primary_key = vec!["id".into(), "qty".into()];
    t.foreign_keys = vec![ForeignKeyDef {
        name: None,
        columns: vec!["parent_id".into()],
        ref_schema: None,
        ref_table: "parent".into(),
        ref_columns: vec!["id".into()],
        on_delete: Some("CASCADE".into()),
        on_update: None,
    }];
    t.indexes = vec![IndexDef { name: "kid_parent_idx".into(), columns: vec!["parent_id".into(), "remark".into()], unique: false }];
    let plan = ddl::plan_schema_changes(D, &[TableChange { original: Some(o), target: Some(t.clone()) }]).unwrap();
    assert!(plan.destructive);
    apply_ok(&mgr, &pool, &c, plan).await;
    let loaded = ddl::load_table(&pool, &s, "kid").await.unwrap();
    t.foreign_keys[0].name = Some("kid_parent_id_fkey".into());
    assert_eq!(normalized(&loaded, true), normalized(&t, true));
    assert_eq!(rows(&mgr, &pool, &c, &format!("SELECT remark, qty FROM {s}.kid")).await, [vec![json!("n"), json!(5)]]);
    // The new FK cascades.
    rows(&mgr, &pool, &c, &format!("DELETE FROM {s}.parent; SELECT 1")).await;
    assert_eq!(rows(&mgr, &pool, &c, &format!("SELECT count(*) FROM {s}.kid")).await[0][0], json!(0));

    // Turning identity off/on and dropping the index + FK.
    let o = loaded;
    let mut t = o.clone();
    t.foreign_keys.clear();
    t.indexes.clear();
    t.columns[0].auto_increment = true;
    apply_ok(&mgr, &pool, &c, ddl::plan_schema_changes(D, &[TableChange { original: Some(o), target: Some(t.clone()) }]).unwrap()).await;
    assert_eq!(normalized(&ddl::load_table(&pool, &s, "kid").await.unwrap(), true), normalized(&t, true));

    // A failing statement mid-way rolls the whole PG plan back.
    let o = ddl::load_table(&pool, &s, "kid").await.unwrap();
    let mut bad = o.clone();
    bad.columns[1].name = "renamed".into();
    bad.columns.push(col("x", "no_such_type", true));
    let r = apply_plan(&mgr, &pool, &c, ddl::plan_schema_changes(D, &[TableChange { original: Some(o.clone()), target: Some(bad) }]).unwrap()).await.unwrap();
    assert!(r.rolled_back && r.failed.is_some());
    assert_eq!(normalized(&ddl::load_table(&pool, &s, "kid").await.unwrap(), true), normalized(&o, true));

    let drop = [TableChange { original: Some(parent), target: None }, TableChange { original: Some(o), target: None }];
    apply_ok(&mgr, &pool, &c, ddl::plan_schema_changes(D, &drop).unwrap()).await;
    assert!(matches!(ddl::load_table(&pool, &s, "kid").await, Err(AppError::NotFound(_))));
    drop_schema(&mgr, &pool, &c, &s).await;
}
