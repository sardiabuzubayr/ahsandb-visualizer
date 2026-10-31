mod common;

use ahsandb_lib::db::{self, Running, exec, meta, page};
use ahsandb_lib::error::AppError;
use ahsandb_lib::model::*;
use common::*;
use serde_json::json;

const SEED: &str = r#"
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, city TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), status TEXT NOT NULL,
  total NUMERIC NOT NULL, note TEXT, paid BOOLEAN NOT NULL DEFAULT 0);
CREATE TABLE payments (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders, amount REAL, receipt BLOB);
CREATE TABLE "Order Items" (id INTEGER PRIMARY KEY, "we""ird col" TEXT);
INSERT INTO customers (name, email, city) VALUES ('PT Sinar Jaya Abadi','halo@sinarjaya.example','Surabaya'),
  ('CV Maju Bersama','info@majubersama.example','Bandung'), ('Toko Mekar Sari',NULL,'Bandung'), ('UD Berkah Tani','','Malang');
INSERT INTO orders (customer_id, status, total, note, paid) VALUES (1,'shipped',1250000.5,NULL,1),(2,'pending',3480000,'JNE',0),
  (3,'paid',845500.5,NULL,1),(4,'pending',12900000,'',0),(1,'cancelled',610000,'',0);
INSERT INTO payments (order_id, amount, receipt) VALUES (1, 1250000.5, X'DEADBEEF'), (3, 845500.5, NULL);
INSERT INTO "Order Items" ("we""ird col") VALUES ('b'), ('a'), ('c');
CREATE VIEW v_open_orders AS SELECT id, total FROM orders WHERE status = 'pending';
"#;

async fn seeded() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shop.db");
    db::create_sqlite_file(path.to_str().unwrap()).await.unwrap();
    let c = Connection { file: Some(path.to_str().unwrap().into()), ..conn(Driver::Sqlite) };
    let (mgr, pool) = open(&c).await;
    let res = exec(&mgr, &pool, &c, SEED).await.unwrap();
    assert!(res.iter().all(|r| r.error.is_none()), "{res:?}");
    // The splitter cuts SQLite trigger bodies at the inner `;`, so create the trigger directly.
    let db::Pool::Lite(p) = &*pool else { unreachable!() };
    sqlx::raw_sql("CREATE TRIGGER trg_orders_touch AFTER INSERT ON orders BEGIN SELECT 1; END").execute(p).await.unwrap();
    (dir, c)
}

#[tokio::test]
async fn create_file_and_missing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("new.db");
    let p = path.to_str().unwrap();
    let missing = Connection { file: Some(p.into()), ..conn(Driver::Sqlite) };
    assert!(matches!(db::connect(&missing, None, None).await, Err(AppError::Io(m)) if m.contains("File not found")));
    db::create_sqlite_file(p).await.unwrap();
    assert!(path.exists());
    assert!(matches!(db::create_sqlite_file(p).await, Err(AppError::Io(_))));
    let nested = dir.path().join("nope/x.db");
    assert!(matches!(db::create_sqlite_file(nested.to_str().unwrap()).await, Err(AppError::Io(_))));
    let (_, version) = db::connect(&missing, None, None).await.unwrap();
    assert!(version.starts_with("SQLite 3."), "{version}");
}

#[tokio::test]
async fn values_and_scripts() {
    let (_dir, c) = seeded().await;
    let (mgr, pool) = open(&c).await;
    let r = rows(&mgr, &pool, &c, "SELECT NULL, '', 9007199254740993, 42, 1.5, X'DEADBEEF', 'text'").await;
    assert_eq!(r[0], vec![json!(null), json!(""), json!("9007199254740993"), json!(42), json!(1.5), json!("\\xdeadbeef"), json!("text")]);
    let r = rows(&mgr, &pool, &c, "SELECT note, receipt FROM orders LEFT JOIN payments p ON p.order_id = orders.id ORDER BY orders.id").await;
    assert_eq!(r[0], vec![json!(null), json!("\\xdeadbeef")]);
    assert_eq!(r[3][0], json!(""));

    // Multi-statement stops at the first error and keeps earlier results.
    let res = exec(&mgr, &pool, &c, "SELECT 1; SELECT nosuch FROM orders; SELECT 2").await.unwrap();
    assert_eq!(res.len(), 2);
    assert!(res[0].error.is_none());
    assert!(res[1].error.as_ref().unwrap().message.contains("nosuch"));

    // Truncation and affected rows.
    let res = db::exec::execute(&mgr, &pool, &c, "SELECT * FROM orders", false, 2, "r").await.unwrap();
    assert_eq!(res[0].rows.len(), 2);
    assert!(res[0].truncated);
    assert_eq!(res[0].columns[0].name, "id");
    let res = exec(&mgr, &pool, &c, "UPDATE orders SET note = note WHERE status = 'pending'").await.unwrap();
    assert_eq!(res[0].affected, Some(2));
    // Empty result still has columns (describe).
    let res = exec(&mgr, &pool, &c, "SELECT id, status FROM orders WHERE 0").await.unwrap();
    assert_eq!(res[0].columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "status"]);
    assert_eq!(res[0].affected, None);
    assert!(exec(&mgr, &pool, &c, "  -- nothing\n").await.unwrap().is_empty());
}

#[tokio::test]
async fn enforcement_and_cancel() {
    let (_dir, c) = seeded().await;
    let prod = Connection { env: Env::Prod, ..c.clone() };
    let (mgr, pool) = open(&prod).await;
    let sql = "SELECT 1; DELETE FROM orders WHERE id = 99";
    match exec(&mgr, &pool, &prod, sql).await {
        Err(AppError::NeedsConfirmation(w)) => assert_eq!(w.len(), 1),
        other => panic!("{other:?}"),
    }
    let res = db::exec::execute(&mgr, &pool, &prod, sql, true, 1000, "r").await.unwrap();
    assert_eq!(res[1].affected, Some(0));

    let ro = Connection { read_only: true, ..c.clone() };
    let (mgr, pool) = open(&ro).await;
    assert!(matches!(exec(&mgr, &pool, &ro, sql).await, Err(AppError::ReadOnly(w)) if w.len() == 1));
    assert_eq!(rows(&mgr, &pool, &ro, "SELECT count(*) FROM orders").await[0][0], json!(5));

    assert!(exec::cancel(&mgr, "finished").await.is_ok());
    mgr.running.lock().await.insert("live".into(), Running { conn_id: ro.id.clone(), server_id: None });
    assert!(matches!(exec::cancel(&mgr, "live").await, Err(AppError::NotSupported(_))));
}

#[tokio::test]
async fn metadata_and_paging() {
    let (_dir, c) = seeded().await;
    let (_mgr, pool) = open(&c).await;
    let tree = meta::schema_tree(&pool, &c).await.unwrap();
    let ids = tree_ids(&c, &tree);
    for s in ["/main/tables/orders", "/main/tables/Order Items", "/main/views/v_open_orders", "/main/triggers/trg_orders_touch"] {
        assert!(has_suffix(&ids, s), "{s} in {ids:?}");
    }
    assert!(!has_suffix(&ids, "/functions"));
    assert!(tree[0].size.is_some_and(|b| b > 0), "database size");
    let tables = flatten(&tree).into_iter().find(|n| n.id.ends_with("/tables")).unwrap();
    assert_eq!(tables.count, Some(4));
    assert_eq!(tables.children.as_ref().unwrap()[0].schema.as_deref(), Some("main"));

    let cols = meta::table_columns(&pool, "main", "orders").await.unwrap();
    assert!(cols[0].pk && cols[0].numeric && !cols[0].fk);
    assert!(cols[1].fk && !cols[1].pk);

    let er = meta::er_model(&pool, "main").await.unwrap();
    assert_eq!(er.tables.len(), 4);
    let rel = er.relations.iter().find(|r| r.id == "orders.customer_id->customers").unwrap();
    assert_eq!(rel.to_column, "id");
    // FK without explicit column points at the parent's primary key.
    assert!(er.relations.iter().any(|r| r.id == "payments.order_id->orders" && r.to_column == "id"));

    let comp = meta::completion_schema(&pool, &c).await.unwrap();
    assert!(comp["orders"].contains(&"customer_id".to_string()));
    assert!(comp.contains_key("v_open_orders"));

    let desc = Some(OrderBy { column: "id".into(), desc: true });
    let p = page::table_page(&pool, "main", "orders", desc.clone(), None, 0, 2).await.unwrap();
    assert_eq!(p.rows.iter().map(|r| r[0].clone()).collect::<Vec<_>>(), [json!(5), json!(4)]);
    assert!(p.has_more);
    assert!(p.columns[0].pk);
    let p = page::table_page(&pool, "main", "orders", desc, None, 4, 2).await.unwrap();
    assert_eq!(p.rows.len(), 1);
    assert!(!p.has_more);
    let bad = Some(OrderBy { column: "id; DROP TABLE orders".into(), desc: false });
    assert!(matches!(page::table_page(&pool, "main", "orders", bad, None, 0, 2).await, Err(AppError::Query(m)) if m.contains("Unknown column")));
    // WHERE filter (data viewer / FK jump): applied, and refused when it smuggles in another statement.
    let p = page::table_page(&pool, "main", "orders", None, Some("id IN (2, 3) -- comment"), 0, 10).await.unwrap();
    assert_eq!(p.rows.len(), 2);
    for evil in ["1=1; DROP TABLE orders", "1=1); DELETE FROM orders; SELECT (1"] {
        let r = page::table_page(&pool, "main", "orders", None, Some(evil), 0, 10).await;
        assert!(matches!(r, Err(AppError::Query(m)) if m.contains("single condition")), "{evil}");
    }
    assert_eq!(page::table_page(&pool, "main", "orders", None, None, 0, 10).await.unwrap().rows.len(), 5);
    let weird = Some(OrderBy { column: "we\"ird col".into(), desc: false });
    let p = page::table_page(&pool, "main", "Order Items", weird, None, 0, 10).await.unwrap();
    assert_eq!(p.rows.iter().map(|r| r[1].clone()).collect::<Vec<_>>(), [json!("a"), json!("b"), json!("c")]);
}
