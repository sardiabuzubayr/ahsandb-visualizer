//! Preview/apply and DDL against MySQL/MariaDB. Runs only when AHSANDB_TEST_MYSQL is set; tables are
//! named `ahsandb_t_<rand>_x` and dropped at the end.
mod common;

use std::collections::BTreeMap;

use ahsandb_lib::db::{Manager, Pool, preview};
use ahsandb_lib::ddl;
use ahsandb_lib::error::AppError;
use ahsandb_lib::model::*;
use common::*;
use serde_json::json;

const D: Driver = Driver::Mariadb;

fn my() -> Option<Connection> {
    from_env("AHSANDB_TEST_MYSQL", D)
}

fn db_name(c: &Connection) -> String {
    c.database.clone().unwrap_or_default()
}

async fn cleanup(mgr: &Manager, pool: &Pool, c: &Connection, tables: &[String]) {
    for t in tables {
        rows(mgr, pool, c, &format!("DROP TABLE IF EXISTS `{t}`; SELECT 1")).await;
    }
}

fn col(name: &str, ty: &str, nullable: bool) -> ColumnDef {
    ColumnDef { name: name.into(), original_name: None, type_name: ty.into(), nullable, default: None, auto_increment: false }
}

/// MariaDB < 10.5 / MySQL < 8.0.19 report integer display widths (`int(11)`).
fn no_widths(mut t: TableDef) -> TableDef {
    for c in &mut t.columns {
        for (w, base) in [("bigint(20)", "bigint"), ("int(11)", "int")] {
            if c.type_name == w {
                c.type_name = base.into();
            }
        }
    }
    normalized(&t, true)
}

#[tokio::test]
async fn apply_rules_literals_and_partial_ddl() {
    let Some(c) = my() else { return };
    let (mgr, pool) = open(&c).await;
    let db = db_name(&c);
    let pre = format!("ahsandb_t_{}", rand_suffix());
    let (t, a, b) = (format!("{pre}_t"), format!("{pre}_a"), format!("{pre}_b"));
    rows(&mgr, &pool, &c, &format!("CREATE TABLE `{t}` (id int PRIMARY KEY, name text, n int); INSERT INTO `{t}` VALUES (1, 'a', 1), (2, 'b', 2); SELECT 1")).await;

    let tricky = ["it's", r"back\slash", r"\'", r"\\n", "unicode ✓ 日本語", "line1\nline2\ttab", "'; DROP TABLE x;--", "\"dq\"", "", "%_"];
    let inserts: Vec<RowChange> = tricky
        .iter()
        .enumerate()
        .map(|(i, v)| RowChange::Insert { values: BTreeMap::from([("id".into(), json!(100 + i)), ("name".into(), json!(v))]) })
        .collect();
    let plan = ddl::plan_row_changes(D, &db, &t, &inserts).unwrap();
    assert!(plan.transactional);
    apply_ok(&mgr, &pool, &c, plan).await;
    let got = rows(&mgr, &pool, &c, &format!("SELECT name FROM `{t}` WHERE id >= 100 ORDER BY id")).await;
    assert_eq!(got.into_iter().map(|mut r| r.remove(0)).collect::<Vec<_>>(), tricky.iter().map(|v| json!(v)).collect::<Vec<_>>());

    // Updating to the same value still counts as 1 row (FOUND_ROWS), then a missing key rolls it all back.
    let key = |id: i64| BTreeMap::from([("id".to_string(), json!(id))]);
    let same = [RowChange::Update { key: key(1), values: BTreeMap::from([("name".into(), json!("a"))]) }];
    apply_ok(&mgr, &pool, &c, ddl::plan_row_changes(D, &db, &t, &same).unwrap()).await;
    let changes = [
        RowChange::Update { key: key(1), values: BTreeMap::from([("name".into(), json!("changed"))]) },
        RowChange::Update { key: key(999), values: BTreeMap::from([("name".into(), json!("x"))]) },
    ];
    let r = apply_plan(&mgr, &pool, &c, ddl::plan_row_changes(D, &db, &t, &changes).unwrap()).await.unwrap();
    assert_eq!((r.executed, r.failed.as_ref().unwrap().index, r.rolled_back), (1, 1, true));
    assert_eq!(rows(&mgr, &pool, &c, &format!("SELECT name FROM `{t}` WHERE id = 1")).await[0][0], json!("a"));
    let ins = [RowChange::Insert { values: BTreeMap::new() }, RowChange::Delete { key: key(2) }];
    let plan = ddl::plan_row_changes(D, &db, &format!("{t}_none"), &ins).unwrap();
    assert!(plan.destructive);
    assert!(apply_plan(&mgr, &pool, &c, plan).await.unwrap().failed.is_some());

    // Rules.
    assert!(matches!(preview::apply(&mgr, &pool, &c, "nope", true).await, Err(AppError::NotFound(_))));
    let p = preview::store(&mgr, &c.id, ddl::plan_drop(D, ObjectKind::Table, &db, &t).unwrap()).await.unwrap();
    assert!(!p.transactional && p.destructive);
    let prod = Connection { env: Env::Prod, ..c.clone() };
    assert!(matches!(preview::apply(&mgr, &pool, &prod, &p.id, false).await, Err(AppError::NeedsConfirmation(_))));
    let ro = Connection { read_only: true, ..c.clone() };
    assert!(matches!(preview::apply(&mgr, &pool, &ro, &p.id, true).await, Err(AppError::ReadOnly(_))));

    // Non-transactional DDL: stops at the failure, earlier statements stay applied.
    let ta = TableDef {
        schema: db.clone(),
        name: a.clone(),
        columns: vec![col("id", "int", false)],
        primary_key: vec!["id".into()],
        foreign_keys: vec![],
        indexes: vec![],
        checks: vec![],
    };
    let tb = TableDef { name: b.clone(), columns: vec![col("id", "no_such_type", false)], ..ta.clone() };
    let tc = TableDef { name: format!("{pre}_c"), ..ta.clone() };
    let plan = ddl::plan_schema_changes(D, &[a.clone(), b.clone(), tc.name.clone()].iter().zip([ta, tb, tc]).map(|(_, t)| TableChange { original: None, target: Some(t) }).collect::<Vec<_>>()).unwrap();
    assert!(!plan.transactional);
    assert_eq!(plan.warnings, ["MySQL/MariaDB applies DDL statement by statement; a failure leaves earlier statements applied"]);
    let r = apply_plan(&mgr, &pool, &c, plan).await.unwrap();
    assert_eq!((r.executed, r.failed.as_ref().map(|f| f.index), r.rolled_back), (1, Some(1), false));
    assert!(ddl::load_table(&pool, &db, &a).await.is_ok());
    assert!(matches!(ddl::load_table(&pool, &db, &format!("{pre}_c")).await, Err(AppError::NotFound(_))));

    cleanup(&mgr, &pool, &c, &[t, a, b]).await;
}

#[tokio::test]
async fn load_seed_tables() {
    let Some(c) = my() else { return };
    let (_mgr, pool) = open(&c).await;
    let db = db_name(&c);
    let o = no_widths(ddl::load_table(&pool, &db, "orders").await.unwrap());
    let cols: Vec<_> = o.columns.iter().map(|c| (c.name.as_str(), c.type_name.as_str(), c.nullable, c.default.as_deref(), c.auto_increment)).collect();
    assert_eq!(cols[..4], [
        ("id", "bigint", false, None, true),
        ("customer_id", "bigint", false, None, false),
        ("status", "varchar(20)", false, None, false),
        ("total", "decimal(14,2)", false, None, false),
    ]);
    assert_eq!((cols[4].0, cols[4].2, cols[4].3), ("note", true, None));
    assert_eq!(cols[5], ("paid", "tinyint(1)", false, Some("0"), false));
    assert!(cols[6].3.unwrap().to_lowercase().starts_with("current_timestamp"), "{:?}", cols[6]);
    assert_eq!(o.primary_key, ["id"]);
    assert_eq!(o.foreign_keys.len(), 1);
    assert_eq!((o.foreign_keys[0].ref_table.as_str(), o.foreign_keys[0].on_delete.as_deref()), ("customers", None));
    // The index MySQL made for the FK is not listed.
    assert!(o.indexes.is_empty(), "{:?}", o.indexes);
    let i = ddl::load_table(&pool, &db, "order_items").await.unwrap();
    assert_eq!(i.foreign_keys.iter().map(|f| f.ref_table.as_str()).collect::<Vec<_>>(), ["orders", "products"]);
    let same = ddl::plan_schema_changes(D, &[TableChange { original: Some(i.clone()), target: Some(i) }]).unwrap();
    assert!(same.statements.is_empty(), "{:?}", same.statements);
    assert!(matches!(ddl::load_table(&pool, &db, "v_open_orders").await, Err(AppError::NotFound(_))));
}

#[tokio::test]
async fn create_alter_drop_roundtrip() {
    let Some(c) = my() else { return };
    let (mgr, pool) = open(&c).await;
    let db = db_name(&c);
    let pre = format!("ahsandb_t_{}", rand_suffix());
    let (pn, cn, kn) = (format!("{pre}_parent"), format!("{pre}_child"), format!("{pre}_kid"));
    let parent = TableDef {
        schema: db.clone(),
        name: pn.clone(),
        columns: vec![ColumnDef { auto_increment: true, ..col("id", "bigint", false) }, col("code", "varchar(20)", false)],
        primary_key: vec!["id".into()],
        foreign_keys: vec![],
        indexes: vec![IndexDef { name: "parent_code_key".into(), columns: vec!["code".into()], unique: true }],
        checks: vec![],
    };
    let child = TableDef {
        name: cn.clone(),
        columns: vec![
            col("id", "int", false),
            col("parent_id", "bigint", true),
            ColumnDef { default: Some("'x'".into()), ..col("note", "varchar(50)", true) },
            col("qty", "int", true),
            col("old", "text", true),
        ],
        primary_key: vec!["id".into()],
        indexes: vec![],
        checks: vec![CheckDef { name: Some("qty_pos".into()), expression: "qty > 0".into() }],
        ..parent.clone()
    };
    let create = [TableChange { original: None, target: Some(child.clone()) }, TableChange { original: None, target: Some(parent.clone()) }];
    apply_ok(&mgr, &pool, &c, ddl::plan_schema_changes(D, &create).unwrap()).await;
    for t in [&parent, &child] {
        assert_eq!(no_widths(ddl::load_table(&pool, &db, &t.name).await.unwrap()), no_widths((*t).clone()));
    }
    rows(&mgr, &pool, &c, &format!("INSERT INTO `{pn}` (code) VALUES ('p'); INSERT INTO `{cn}` VALUES (1, 1, 'n', 5, 'o'); SELECT 1")).await;

    let o = ddl::load_table(&pool, &db, &cn).await.unwrap();
    let mut t = o.clone();
    t.name = kn.clone();
    t.columns[2].name = "remark".into();
    t.columns[2].default = None;
    t.columns[3].type_name = "bigint".into();
    t.columns[3].nullable = false;
    t.columns.retain(|c| c.name != "old");
    t.primary_key = vec!["id".into(), "qty".into()];
    t.foreign_keys = vec![ForeignKeyDef {
        name: Some("kid_parent_fk".into()),
        columns: vec!["parent_id".into()],
        ref_schema: None,
        ref_table: pn.clone(),
        ref_columns: vec!["id".into()],
        on_delete: Some("CASCADE".into()),
        on_update: None,
    }];
    t.indexes = vec![IndexDef { name: "kid_parent_idx".into(), columns: vec!["parent_id".into(), "remark".into()], unique: false }];
    let plan = ddl::plan_schema_changes(D, &[TableChange { original: Some(o), target: Some(t.clone()) }]).unwrap();
    assert!(plan.destructive && !plan.transactional);
    apply_ok(&mgr, &pool, &c, plan).await;
    let loaded = ddl::load_table(&pool, &db, &kn).await.unwrap();
    assert_eq!(no_widths(loaded.clone()), no_widths(t.clone()));
    assert_eq!(rows(&mgr, &pool, &c, &format!("SELECT remark, qty FROM `{kn}`")).await, [vec![json!("n"), json!(5)]]);
    rows(&mgr, &pool, &c, &format!("DELETE FROM `{pn}`; SELECT 1")).await;
    assert_eq!(rows(&mgr, &pool, &c, &format!("SELECT count(*) FROM `{kn}`")).await[0][0], json!(0));

    // Drop FK + index, auto-increment on.
    let mut t = loaded.clone();
    t.foreign_keys.clear();
    t.indexes.clear();
    t.columns[0].auto_increment = true;
    apply_ok(&mgr, &pool, &c, ddl::plan_schema_changes(D, &[TableChange { original: Some(loaded), target: Some(t.clone()) }]).unwrap()).await;
    assert_eq!(no_widths(ddl::load_table(&pool, &db, &kn).await.unwrap()), no_widths(t.clone()));

    let drop = [TableChange { original: Some(parent), target: None }, TableChange { original: Some(t), target: None }];
    apply_ok(&mgr, &pool, &c, ddl::plan_schema_changes(D, &drop).unwrap()).await;
    assert!(matches!(ddl::load_table(&pool, &db, &kn).await, Err(AppError::NotFound(_))));
    cleanup(&mgr, &pool, &c, &[pn, cn, kn]).await;
}
