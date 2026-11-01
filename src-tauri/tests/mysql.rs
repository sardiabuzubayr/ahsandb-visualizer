//! Runs only when AHSANDB_TEST_MYSQL is set (seeded by scripts/seed/mysql.sql). Works for MySQL and MariaDB.
mod common;

use std::time::{Duration, Instant};

use ahsandb_lib::db::{self, exec, meta, page};
use ahsandb_lib::error::AppError;
use ahsandb_lib::model::*;
use common::*;
use serde_json::json;

fn my() -> Option<Connection> {
    from_env("AHSANDB_TEST_MYSQL", Driver::Mariadb)
}

#[tokio::test]
async fn connect_and_auth() {
    let Some(c) = my() else { return };
    let (_, version) = db::connect(&c, None, None).await.unwrap();
    assert!(version.starts_with("MariaDB ") || version.starts_with("MySQL "), "{version}");
    assert!(!version.contains('-'), "{version}");
    let bad = Connection { user: Some("no_such_user_ahsan".into()), ..c.clone() };
    assert!(matches!(db::connect(&bad, Some("wrong"), None).await, Err(AppError::Auth(_))));
}

#[tokio::test]
async fn value_encoding() {
    let Some(c) = my() else { return };
    let (mgr, pool) = open(&c).await;
    let r = rows(&mgr, &pool, &c, "SELECT NULL, '', 9007199254740993, 42, CAST(12345678901234567890.123456789 AS DECIMAL(30,9)), \
        TRUE, TIMESTAMP '2026-01-02 03:04:05', DATE '2026-01-02', X'DEADBEEF', 1.5e0, CAST(18446744073709551615 AS UNSIGNED), \
        CAST('abc' AS CHAR) COLLATE utf8mb4_bin").await;
    assert_eq!(r[0], vec![json!(null), json!(""), json!("9007199254740993"), json!(42), json!("12345678901234567890.123456789"),
        json!(1), json!("2026-01-02 03:04:05"), json!("2026-01-02"), json!("\\xdeadbeef"), json!(1.5), json!("18446744073709551615"), json!("abc")]);

    let res = exec(&mgr, &pool, &c, "SELECT o.id, o.note, o.total, o.paid, p.receipt FROM orders o LEFT JOIN payments p ON p.order_id = o.id ORDER BY o.id").await.unwrap();
    let rows = &res[0].rows;
    assert_eq!(rows[0], vec![json!(1), json!(null), json!("1250000.00"), json!(1), json!("\\xdeadbeef")]);
    assert_eq!(rows[4][1], json!(""));
    assert!(res[0].columns[2].numeric);
}

#[tokio::test]
async fn scripts_errors_truncation_enforcement() {
    let Some(c) = my() else { return };
    let (mgr, pool) = open(&c).await;
    let res = exec(&mgr, &pool, &c, "SELECT 1; SELECT nosuch FROM orders; SELECT 2").await.unwrap();
    assert_eq!(res.len(), 2);
    assert!(res[1].error.as_ref().unwrap().message.contains("nosuch"));

    let res = db::exec::execute(&mgr, &pool, &c, "SELECT * FROM orders", false, 2, "t").await.unwrap();
    assert_eq!(res[0].rows.len(), 2);
    assert!(res[0].truncated);
    // The drained connection keeps working.
    assert_eq!(rows(&mgr, &pool, &c, "SELECT COUNT(*) FROM orders").await[0][0], json!(5));
    let res = exec(&mgr, &pool, &c, "SELECT id, status FROM orders WHERE 1 = 0").await.unwrap();
    assert_eq!(res[0].columns.len(), 2);

    let table = format!("ahsan_tmp_{}", std::process::id());
    let prod = Connection { env: Env::Prod, ..c.clone() };
    let script = format!("CREATE TABLE {table} (id int); INSERT INTO {table} VALUES (1), (2); SELECT COUNT(*) FROM {table}; DROP TABLE {table}");
    match exec(&mgr, &pool, &prod, &script).await {
        Err(AppError::NeedsConfirmation(w)) => assert_eq!(w.len(), 3),
        other => panic!("{other:?}"),
    }
    let res = db::exec::execute(&mgr, &pool, &prod, &script, true, 1000, "t").await.unwrap();
    assert!(res.iter().all(|r| r.error.is_none()), "{res:?}");
    assert_eq!(res[1].affected, Some(2));
    assert_eq!(res[2].rows[0][0], json!(2));

    let ro = Connection { read_only: true, ..c.clone() };
    let (mgr, pool) = open(&ro).await;
    assert!(matches!(exec(&mgr, &pool, &ro, &script).await, Err(AppError::ReadOnly(w)) if w.len() == 3));
    assert_eq!(rows(&mgr, &pool, &ro, "SELECT @@session.tx_read_only").await[0][0], json!(1));
}

#[tokio::test]
async fn cancel_sleep() {
    let Some(c) = my() else { return };
    let (mgr, pool) = open(&c).await;
    let started = Instant::now();
    let (res, cancelled) = tokio::join!(db::exec::execute(&mgr, &pool, &c, "SELECT SLEEP(30)", false, 1000, "sleep"), async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        exec::cancel(&mgr, "sleep").await
    });
    cancelled.unwrap();
    assert!(started.elapsed() < Duration::from_secs(3));
    // An interrupted SLEEP returns 1 instead of failing on some servers.
    let res = res.unwrap();
    match &res[0].error {
        Some(e) => assert_eq!(e.message, "Query cancelled"),
        None => assert_eq!(res[0].rows[0][0], json!(1)),
    }
    assert_eq!(rows(&mgr, &pool, &c, "SELECT 1").await[0][0], json!(1));
}

#[tokio::test]
async fn metadata_and_paging() {
    let Some(c) = my() else { return };
    let (mgr, pool) = open(&c).await;
    let db_name = c.database.clone().unwrap();
    let tree = meta::schema_tree(&pool, &c).await.unwrap();
    let ids = tree_ids(&c, &tree);
    for s in ["/tables/orders", "/views/v_open_orders", "/functions/fn_order_total", "/procedures/close_paid_orders", "/triggers/trg_orders_touch"] {
        assert!(has_suffix(&ids, &format!("{db_name}{s}")), "{s} in {ids:?}");
    }
    assert_eq!(tree[0].label, db_name);

    let cols = meta::table_columns(&pool, &db_name, "orders").await.unwrap();
    assert!(cols[0].pk && cols[0].numeric);
    assert!(cols[1].fk && !cols[1].pk);

    let er = meta::er_model(&pool, &db_name).await.unwrap();
    assert_eq!(er.tables.len(), 5);
    assert!(er.relations.iter().any(|r| r.id == "orders.customer_id->customers" && r.to_column == "id"));

    let comp = meta::completion_schema(&pool, &c).await.unwrap();
    assert!(comp["orders"].contains(&"customer_id".to_string()));

    let desc = Some(OrderBy { column: "id".into(), desc: true });
    let p = page::table_page(&pool, &db_name, "orders", desc.clone(), None, 0, 2).await.unwrap();
    assert_eq!(p.rows.iter().map(|r| r[0].clone()).collect::<Vec<_>>(), [json!(5), json!(4)]);
    assert!(p.has_more);
    let p = page::table_page(&pool, &db_name, "orders", desc, None, 4, 2).await.unwrap();
    assert_eq!(p.rows.len(), 1);
    assert!(!p.has_more);
    let bad = Some(OrderBy { column: "nope".into(), desc: false });
    assert!(matches!(page::table_page(&pool, &db_name, "orders", bad, None, 0, 2).await, Err(AppError::Query(_))));

    // Identifiers with spaces and backticks are quoted.
    let table = format!("ahsan weird `{}`", std::process::id());
    let q = table.replace('`', "``");
    rows(&mgr, &pool, &c, &format!("CREATE TABLE `{q}` (`we``ird col` varchar(5)); INSERT INTO `{q}` VALUES ('b'), ('a'); SELECT 1")).await;
    let weird = Some(OrderBy { column: "we`ird col".into(), desc: false });
    let p = page::table_page(&pool, &db_name, &table, weird, None, 0, 10).await;
    rows(&mgr, &pool, &c, &format!("DROP TABLE `{q}`")).await;
    assert_eq!(p.unwrap().rows, vec![vec![json!("a")], vec![json!("b")]]);
}

#[tokio::test]
async fn enum_column_values() {
    let Some(c) = my() else { return };
    let (mgr, pool) = open(&c).await;
    let db_name = c.database.clone().unwrap();
    let t = format!("ahsandb_t_{}", rand_suffix());
    exec(&mgr, &pool, &c, &format!("CREATE TABLE {t} (id int PRIMARY KEY, mood ENUM('sad', 'it''s ok', 'a,b'), note text)")).await.unwrap();
    let cols = meta::table_columns(&pool, &db_name, &t).await;
    exec(&mgr, &pool, &c, &format!("DROP TABLE {t}")).await.unwrap();
    let cols = cols.unwrap();
    assert_eq!(cols[1].enum_values, ["sad", "it's ok", "a,b"]);
    assert!(cols[0].enum_values.is_empty() && cols[2].enum_values.is_empty());
}
