//! Preview/apply and DDL generation against a temp SQLite file.
mod common;

use std::collections::BTreeMap;

use ahsandb_lib::db::{self, preview};
use ahsandb_lib::ddl;
use ahsandb_lib::error::AppError;
use ahsandb_lib::model::*;
use common::*;
use serde_json::json;

const D: Driver = Driver::Sqlite;

async fn temp_db(seed: &str) -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.db");
    db::create_sqlite_file(path.to_str().unwrap()).await.unwrap();
    let c = Connection { file: Some(path.to_str().unwrap().into()), ..conn(D) };
    let (mgr, pool) = open(&c).await;
    let db::Pool::Lite(p) = &*pool else { unreachable!() };
    sqlx::raw_sql(seed).execute(p).await.unwrap();
    drop(mgr);
    (dir, c)
}

pub fn tricky() -> Vec<&'static str> {
    vec!["it's", r"back\slash", r"\'", "unicode ✓ 日本語 🚀", "line1\nline2\ttab", "'; DROP TABLE x;--", "\"dq\"", "", "%_"]
}

fn key(id: i64) -> BTreeMap<String, Cell> {
    BTreeMap::from([("id".to_string(), json!(id))])
}

#[tokio::test]
async fn apply_rules_and_literals() {
    let (_dir, c) = temp_db("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INT); INSERT INTO t VALUES (1, 'a', 1), (2, 'b', 2);").await;
    let (mgr, pool) = open(&c).await;

    // Literal round trip.
    let inserts: Vec<RowChange> = tricky()
        .iter()
        .enumerate()
        .map(|(i, s)| RowChange::Insert { values: BTreeMap::from([("id".into(), json!(100 + i)), ("name".into(), json!(s))]) })
        .chain([RowChange::Insert { values: BTreeMap::from([("id".into(), json!(200)), ("name".into(), json!(null))]) }])
        .collect();
    apply_ok(&mgr, &pool, &c, ddl::plan_row_changes(D, "main", "t", &inserts).unwrap()).await;
    let got = rows(&mgr, &pool, &c, "SELECT name FROM t WHERE id >= 100 ORDER BY id").await;
    let mut want: Vec<Cell> = tricky().iter().map(|s| json!(s)).collect();
    want.push(json!(null));
    assert_eq!(got.into_iter().map(|mut r| r.remove(0)).collect::<Vec<_>>(), want);
    assert_eq!(rows(&mgr, &pool, &c, "SELECT count(*) FROM sqlite_master WHERE name = 'x' OR name = 't'").await[0][0], json!(1));

    // expect_rows mismatch: the valid first update is rolled back too; the preview stays for a retry.
    let changes = vec![
        RowChange::Update { key: key(1), values: BTreeMap::from([("name".into(), json!("changed"))]) },
        RowChange::Update { key: key(999), values: BTreeMap::from([("name".into(), json!("ghost"))]) },
    ];
    let p = preview::store(&mgr, &c.id, ddl::plan_row_changes(D, "main", "t", &changes).unwrap()).await.unwrap();
    assert!(p.transactional && !p.destructive);
    let r = preview::apply(&mgr, &pool, &c, &p.id, false).await.unwrap();
    let f = r.failed.as_ref().unwrap();
    assert_eq!((r.executed, f.index, r.rolled_back), (1, 1, true));
    assert_eq!(f.message, "Expected 1 row, got 0 — the row changed or was deleted");
    assert_eq!(rows(&mgr, &pool, &c, "SELECT name FROM t WHERE id = 1").await[0][0], json!("a"));
    assert!(mgr.previews.lock().await.contains_key(&p.id));

    // Unknown id, and an id from another connection.
    let gone = preview::apply(&mgr, &pool, &c, "nope", false).await;
    assert!(matches!(gone, Err(AppError::NotFound(m)) if m.contains("review the SQL again")));
    let other = Connection { id: "other".into(), ..c.clone() };
    assert!(matches!(preview::apply(&mgr, &pool, &other, &p.id, false).await, Err(AppError::NotFound(_))));

    // Read-only and production rules (nothing runs; the preview survives).
    let del = [RowChange::Delete { key: key(2) }];
    let p = preview::store(&mgr, &c.id, ddl::plan_row_changes(D, "main", "t", &del).unwrap()).await.unwrap();
    assert!(p.destructive);
    let ro = Connection { read_only: true, ..c.clone() };
    assert!(matches!(preview::apply(&mgr, &pool, &ro, &p.id, true).await, Err(AppError::ReadOnly(s)) if s == p.statements));
    let prod = Connection { env: Env::Prod, ..c.clone() };
    assert!(matches!(preview::apply(&mgr, &pool, &prod, &p.id, false).await, Err(AppError::NeedsConfirmation(s)) if s == [r#"DELETE FROM "t" WHERE "id" = 2"#]));
    assert_eq!(rows(&mgr, &pool, &c, "SELECT count(*) FROM t WHERE id = 2").await[0][0], json!(1));
    let r = preview::apply(&mgr, &pool, &prod, &p.id, true).await.unwrap();
    assert!(r.failed.is_none() && r.executed == 1 && !r.rolled_back);
    assert_eq!(rows(&mgr, &pool, &c, "SELECT count(*) FROM t WHERE id = 2").await[0][0], json!(0));
    // Applied previews are gone.
    assert!(matches!(preview::apply(&mgr, &pool, &prod, &p.id, true).await, Err(AppError::NotFound(_))));

    // Empty plan.
    let empty = preview::store(&mgr, &c.id, preview::Plan::default()).await;
    assert!(matches!(empty, Err(AppError::Query(m)) if m == "Nothing to apply"));
}

const SEED: &str = "
CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'pending', total NUMERIC(14,2) NOT NULL, note TEXT, CONSTRAINT total_pos CHECK (total >= 0));
CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders ON DELETE CASCADE,
  qty INTEGER NOT NULL CHECK (qty > 0), price NUMERIC NOT NULL, sku TEXT UNIQUE);
CREATE INDEX order_items_order_idx ON order_items (order_id, qty);
CREATE VIEW v_items AS SELECT o.id, i.qty FROM orders o JOIN order_items i ON i.order_id = o.id;
INSERT INTO customers (name) VALUES ('A'), ('B');
INSERT INTO orders (customer_id, total, note) VALUES (1, 10, 'x'), (2, 20, NULL);
INSERT INTO order_items (order_id, qty, price, sku) VALUES (1, 2, 5, 's1'), (1, 1, 3, 's2'), (2, 4, 5, NULL);
";

#[tokio::test]
async fn load_seed_tables() {
    let (_dir, c) = temp_db(SEED).await;
    let (_mgr, pool) = open(&c).await;
    let o = ddl::load_table(&pool, "main", "orders").await.unwrap();
    assert_eq!(o.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "customer_id", "status", "total", "note"]);
    assert!(o.columns[0].auto_increment && o.columns.iter().all(|c| c.original_name.as_deref() == Some(c.name.as_str())));
    assert_eq!(o.columns[2].default.as_deref(), Some("'pending'"));
    assert!(!o.columns[2].nullable && o.columns[4].nullable);
    assert_eq!(o.columns[3].type_name, "NUMERIC(14,2)");
    assert_eq!(o.primary_key, ["id"]);
    assert_eq!(o.foreign_keys.len(), 1);
    assert_eq!((o.foreign_keys[0].ref_table.as_str(), o.foreign_keys[0].ref_columns.clone()), ("customers", vec!["id".to_string()]));
    assert_eq!(o.checks, [CheckDef { name: Some("total_pos".into()), expression: "total >= 0".into() }]);

    let i = ddl::load_table(&pool, "", "order_items").await.unwrap();
    assert!(!i.columns[0].auto_increment);
    // `REFERENCES orders` without columns resolves to the parent PK.
    assert_eq!(i.foreign_keys[0].ref_columns, ["id"]);
    assert_eq!(i.foreign_keys[0].on_delete.as_deref(), Some("CASCADE"));
    assert_eq!(i.checks[0].expression, "qty > 0");
    let names: Vec<_> = i.indexes.iter().map(|x| (x.name.as_str(), x.unique, x.columns.clone())).collect();
    assert_eq!(names, [
        ("order_items_order_idx", false, vec!["order_id".to_string(), "qty".to_string()]),
        ("sqlite_autoindex_order_items_1", true, vec!["sku".to_string()]),
    ]);
    // Loaded definition as target = nothing to do.
    let same = ddl::plan_schema_changes(D, &[TableChange { original: Some(i.clone()), target: Some(i) }]).unwrap();
    assert!(same.statements.is_empty(), "{:?}", same.statements);
    assert!(matches!(ddl::load_table(&pool, "main", "nope").await, Err(AppError::NotFound(_))));
    assert!(matches!(ddl::load_table(&pool, "main", "v_items").await, Err(AppError::NotFound(_))));
}

#[tokio::test]
async fn rebuild_keeps_data_and_fk_enforcement() {
    let (_dir, c) = temp_db(SEED).await;
    let (mgr, pool) = open(&c).await;
    // Rebuild the parent of a CASCADE FK: child rows must survive (FKs are off during the rebuild).
    let o = ddl::load_table(&pool, "main", "orders").await.unwrap();
    let mut t = o.clone();
    t.columns[4].type_name = "VARCHAR(50)".into();
    t.columns[4].nullable = false;
    t.columns[4].default = Some("''".into());
    let plan = ddl::plan_schema_changes(D, &[TableChange { original: Some(o.clone()), target: Some(t.clone()) }]).unwrap();
    assert_eq!(plan.warnings, ["Table orders will be rebuilt (its triggers are not kept)"]);
    // NULL note can't go into NOT NULL: whole rebuild fails and rolls back, FKs back on.
    let r = apply_plan(&mgr, &pool, &c, plan).await.unwrap();
    assert!(r.rolled_back && r.failed.as_ref().unwrap().message.contains("NOT NULL"), "{r:?}");
    assert_eq!(rows(&mgr, &pool, &c, "SELECT count(*) FROM order_items").await[0][0], json!(3));
    t.columns[4].nullable = true;
    apply_ok(&mgr, &pool, &c, ddl::plan_schema_changes(D, &[TableChange { original: Some(o), target: Some(t.clone()) }]).unwrap()).await;
    assert_eq!(rows(&mgr, &pool, &c, "SELECT count(*) FROM order_items").await[0][0], json!(3));
    assert_eq!(rows(&mgr, &pool, &c, "SELECT count(*) FROM v_items").await[0][0], json!(3));
    assert_eq!(rows(&mgr, &pool, &c, "SELECT note FROM orders ORDER BY id").await, [vec![json!("x")], vec![json!(null)]]);
    assert_eq!(normalized(&ddl::load_table(&pool, "main", "orders").await.unwrap(), false), normalized(&t, false));
    // Autoincrement continues after the rebuild.
    rows(&mgr, &pool, &c, "INSERT INTO orders (customer_id, total) VALUES (1, 5)").await;
    assert_eq!(rows(&mgr, &pool, &c, "SELECT max(id) FROM orders").await[0][0], json!(3));

    // Child: rename + type change + new FK + index on renamed column.
    let o = ddl::load_table(&pool, "main", "order_items").await.unwrap();
    let mut t = o.clone();
    t.columns[3].name = "unit_price".into();
    t.columns[2].type_name = "BIGINT".into();
    t.columns.push(ColumnDef { name: "customer_id".into(), original_name: None, type_name: "INTEGER".into(), nullable: true, default: None, auto_increment: false });
    t.foreign_keys.push(ForeignKeyDef {
        name: Some("items_customer_fk".into()),
        columns: vec!["customer_id".into()],
        ref_schema: None,
        ref_table: "customers".into(),
        ref_columns: vec!["id".into()],
        on_delete: None,
        on_update: None,
    });
    t.indexes.push(IndexDef { name: "items_price_idx".into(), columns: vec!["unit_price".into()], unique: false });
    apply_ok(&mgr, &pool, &c, ddl::plan_schema_changes(D, &[TableChange { original: Some(o), target: Some(t.clone()) }]).unwrap()).await;
    assert_eq!(rows(&mgr, &pool, &c, "SELECT sum(unit_price * qty) FROM order_items").await[0][0], json!(33));
    let loaded = ddl::load_table(&pool, "main", "order_items").await.unwrap();
    // The UNIQUE auto-index comes back as a regular unique index with a generated name.
    t.indexes[1].name = "order_items_sku_key".into();
    assert_eq!(normalized(&loaded, false), normalized(&t, false));
    // FK enforcement is back on, and the new FK is enforced.
    let bad = exec(&mgr, &pool, &c, "INSERT INTO order_items (order_id, qty, unit_price, customer_id) VALUES (1, 1, 1, 99)").await.unwrap();
    assert!(bad[0].error.as_ref().unwrap().message.contains("FOREIGN KEY"), "{bad:?}");
    assert_eq!(rows(&mgr, &pool, &c, "PRAGMA foreign_keys").await[0][0], json!(1));

    // An FK the existing data violates: foreign_key_check fails the rebuild.
    let o = loaded;
    let mut t = o.clone();
    t.foreign_keys.push(ForeignKeyDef {
        name: None,
        columns: vec!["qty".into()],
        ref_schema: None,
        ref_table: "customers".into(),
        ref_columns: vec!["id".into()],
        on_delete: None,
        on_update: None,
    });
    let r = apply_plan(&mgr, &pool, &c, ddl::plan_schema_changes(D, &[TableChange { original: Some(o.clone()), target: Some(t) }]).unwrap()).await.unwrap();
    let f = r.failed.unwrap();
    assert!(f.message.starts_with("Foreign key check failed"), "{}", f.message);
    assert!(r.rolled_back);
    assert_eq!(normalized(&ddl::load_table(&pool, "main", "order_items").await.unwrap(), false), normalized(&o, false));
}

#[tokio::test]
async fn create_alter_drop_roundtrip() {
    let (_dir, c) = temp_db("SELECT 1;").await;
    let (mgr, pool) = open(&c).await;
    let col = |name: &str, ty: &str, nullable: bool| ColumnDef {
        name: name.into(),
        original_name: None,
        type_name: ty.into(),
        nullable,
        default: None,
        auto_increment: false,
    };
    let parent = TableDef {
        schema: "main".into(),
        name: "parent".into(),
        columns: vec![ColumnDef { auto_increment: true, ..col("id", "INTEGER", false) }, col("code", "TEXT", false)],
        primary_key: vec!["id".into()],
        foreign_keys: vec![],
        indexes: vec![IndexDef { name: "parent_code".into(), columns: vec!["code".into()], unique: true }],
        checks: vec![],
    };
    let child = TableDef {
        name: "child".into(),
        columns: vec![col("id", "INTEGER", false), col("parent_id", "INTEGER", true), col("note", "TEXT", true), col("old", "TEXT", true)],
        primary_key: vec!["id".into()],
        foreign_keys: vec![ForeignKeyDef {
            name: None,
            columns: vec!["parent_id".into()],
            ref_schema: None,
            ref_table: "parent".into(),
            ref_columns: vec!["id".into()],
            on_delete: Some("CASCADE".into()),
            on_update: None,
        }],
        indexes: vec![],
        checks: vec![CheckDef { name: Some("id_pos".into()), expression: "id > 0".into() }],
        ..parent.clone()
    };
    let create = [TableChange { original: None, target: Some(child.clone()) }, TableChange { original: None, target: Some(parent.clone()) }];
    apply_ok(&mgr, &pool, &c, ddl::plan_schema_changes(D, &create).unwrap()).await;
    for t in [&parent, &child] {
        assert_eq!(normalized(&ddl::load_table(&pool, "main", &t.name).await.unwrap(), false), normalized(t, false));
    }
    rows(&mgr, &pool, &c, "INSERT INTO parent (code) VALUES ('p'); INSERT INTO child VALUES (1, 1, 'n', 'o')").await;

    // Native alter: rename column, add column, add index, drop an unreferenced column.
    let o = ddl::load_table(&pool, "main", "child").await.unwrap();
    let mut t = o.clone();
    t.columns[2].name = "remark".into();
    t.columns.retain(|c| c.name != "old");
    t.columns.push(ColumnDef { default: Some("0".into()), ..col("qty", "INT", false) });
    t.indexes.push(IndexDef { name: "child_qty".into(), columns: vec!["qty".into()], unique: false });
    let plan = ddl::plan_schema_changes(D, &[TableChange { original: Some(o), target: Some(t.clone()) }]).unwrap();
    assert!(plan.warnings.is_empty() && plan.destructive, "{plan:?}");
    apply_ok(&mgr, &pool, &c, plan).await;
    assert_eq!(normalized(&ddl::load_table(&pool, "main", "child").await.unwrap(), false), normalized(&t, false));
    assert_eq!(rows(&mgr, &pool, &c, "SELECT remark, qty FROM child").await, [vec![json!("n"), json!(0)]]);

    let drop = [TableChange { original: Some(parent), target: None }, TableChange { original: Some(t), target: None }];
    let plan = ddl::plan_schema_changes(D, &drop).unwrap();
    assert!(plan.destructive);
    apply_ok(&mgr, &pool, &c, plan).await;
    assert!(matches!(ddl::load_table(&pool, "main", "child").await, Err(AppError::NotFound(_))));
    assert!(matches!(ddl::load_table(&pool, "main", "parent").await, Err(AppError::NotFound(_))));

    // plan_drop on a view.
    rows(&mgr, &pool, &c, "CREATE VIEW v AS SELECT 1 AS x").await;
    apply_ok(&mgr, &pool, &c, ddl::plan_drop(D, ObjectKind::View, "main", "v").unwrap()).await;
    assert_eq!(rows(&mgr, &pool, &c, "SELECT count(*) FROM sqlite_master WHERE name = 'v'").await[0][0], json!(0));
}
