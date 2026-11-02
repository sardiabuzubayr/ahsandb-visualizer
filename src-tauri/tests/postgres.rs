//! Runs only when AHSANDB_TEST_PG is set (seeded by scripts/seed/postgres.sql).
mod common;

use std::time::{Duration, Instant};

use ahsandb_lib::db::{self, exec, meta, page};
use ahsandb_lib::error::AppError;
use ahsandb_lib::model::*;
use common::*;
use serde_json::json;

fn pg() -> Option<Connection> {
    from_env("AHSANDB_TEST_PG", Driver::Postgres)
}

#[tokio::test]
async fn connect_and_auth() {
    let Some(c) = pg() else { return };
    let (_, version) = db::connect(&c, None, None).await.unwrap();
    assert!(version.starts_with("PostgreSQL 1"), "{version}");
    // Local trust auth accepts any password, so check an unknown role instead.
    let bad = Connection { user: Some("no_such_role_ahsan".into()), ..c.clone() };
    assert!(matches!(db::connect(&bad, Some("x"), None).await, Err(AppError::Auth(_))));
}

#[tokio::test]
async fn value_encoding() {
    let Some(c) = pg() else { return };
    let (mgr, pool) = open(&c).await;
    let r = rows(&mgr, &pool, &c, r#"SELECT NULL::text, ''::text, 9007199254740993::int8, 42::int4,
        12345678901234567890.123456789::numeric, true, '{"a": [1, 2]}'::jsonb, '2026-01-02 03:04:05.5+00'::timestamptz,
        '2026-01-02'::date, '\xdeadbeef'::bytea, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid, 1.5::float8, 'NaN'::float8,
        decode(repeat('ab', 100), 'hex')"#).await;
    let r = &r[0];
    assert_eq!(r[..7], [json!(null), json!(""), json!("9007199254740993"), json!(42), json!("12345678901234567890.123456789"), json!("true"), json!(r#"{"a":[1,2]}"#)]);
    let ts = r[7].as_str().unwrap();
    assert!(ts.starts_with("2026-01-02") && ts.contains("04:05.5"), "{ts}");
    assert_eq!(r[8..13], [json!("2026-01-02"), json!("\\xdeadbeef"), json!("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"), json!(1.5), json!("NaN")]);
    assert_eq!(r[13], json!(format!("\\x{} (100 bytes)", "ab".repeat(64))));

    let res = exec(&mgr, &pool, &c, "SELECT id, note, total, meta, paid FROM orders ORDER BY id").await.unwrap();
    let cols: Vec<_> = res[0].columns.iter().map(|c| (c.type_name.as_str(), c.numeric)).collect();
    assert_eq!(cols, [("int8", true), ("text", false), ("numeric", true), ("jsonb", false), ("bool", false)]);
    let rows = &res[0].rows;
    assert_eq!(rows.len(), 5);
    assert_eq!(rows[0][1], json!(null));
    assert_eq!(rows[4][1], json!(""));
    assert_eq!(rows[2][2], json!("845500.50"));
}

#[tokio::test]
async fn scripts_errors_truncation_enforcement() {
    let Some(c) = pg() else { return };
    let (mgr, pool) = open(&c).await;
    let res = exec(&mgr, &pool, &c, "SELECT 1; SELECT nosuch FROM orders; SELECT 2").await.unwrap();
    assert_eq!(res.len(), 2);
    let err = res[1].error.as_ref().unwrap();
    assert!(err.message.contains("nosuch"), "{}", err.message);
    assert_eq!(err.position, Some(8));
    assert_eq!(err.code.as_deref(), Some("42703"));

    let res = db::exec::execute(&mgr, &pool, &c, "SELECT * FROM orders", false, 2, "t").await.unwrap();
    assert_eq!(res[0].rows.len(), 2);
    assert!(res[0].truncated);
    let res = exec(&mgr, &pool, &c, "SELECT * FROM orders WHERE false").await.unwrap();
    assert_eq!(res[0].columns.len(), 8);
    assert_eq!(res[0].affected, None);

    let prod = Connection { env: Env::Prod, ..c.clone() };
    let script = "CREATE TEMP TABLE ahsan_tmp (id int); INSERT INTO ahsan_tmp VALUES (1), (2); SELECT count(*) FROM ahsan_tmp; DROP TABLE ahsan_tmp";
    match exec(&mgr, &pool, &prod, script).await {
        Err(AppError::NeedsConfirmation(w)) => assert_eq!(w.len(), 3),
        other => panic!("{other:?}"),
    }
    let res = db::exec::execute(&mgr, &pool, &prod, script, true, 1000, "t").await.unwrap();
    assert!(res.iter().all(|r| r.error.is_none()), "{res:?}");
    assert_eq!(res[1].affected, Some(2));
    assert_eq!(res[2].rows[0][0], json!(2));

    let ro = Connection { read_only: true, ..c.clone() };
    let (mgr, pool) = open(&ro).await;
    assert!(matches!(exec(&mgr, &pool, &ro, script).await, Err(AppError::ReadOnly(w)) if w.len() == 3));
    // Second guard: the session itself is read-only.
    assert_eq!(rows(&mgr, &pool, &ro, "SHOW transaction_read_only").await[0][0], json!("on"));
}

#[tokio::test]
async fn cancel_sleep() {
    let Some(c) = pg() else { return };
    let (mgr, pool) = open(&c).await;
    let started = Instant::now();
    let (res, cancelled) = tokio::join!(db::exec::execute(&mgr, &pool, &c, "SELECT pg_sleep(30)", false, 1000, "sleep"), async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        exec::cancel(&mgr, "sleep").await
    });
    cancelled.unwrap();
    assert!(started.elapsed() < Duration::from_secs(3));
    let res = res.unwrap();
    assert_eq!(res[0].error.as_ref().unwrap().message, "Query cancelled");
    assert!(mgr.running.lock().await.is_empty());
    assert_eq!(rows(&mgr, &pool, &c, "SELECT 1").await[0][0], json!(1));
}

#[tokio::test]
async fn metadata_and_paging() {
    let Some(c) = pg() else { return };
    let (_mgr, pool) = open(&c).await;
    let tree = meta::schema_tree(&pool, &c).await.unwrap();
    // Tables carry their size (data + indexes); views and routines don't.
    let all = flatten(&tree);
    let orders = all.iter().find(|n| n.kind == NodeKind::Table && n.label == "orders").expect("orders node");
    assert!(orders.size.is_some_and(|b| b > 0), "table size: {:?}", orders.size);
    assert!(all.iter().filter(|n| n.kind == NodeKind::View).all(|n| n.size.is_none()));
    let ids = tree_ids(&c, &tree);
    for s in ["/public/tables/orders", "/public/views/v_open_orders", "/public/functions/fn_order_total",
        "/public/procedures/close_paid_orders", "/public/triggers/trg_orders_touch", "/public/sequences/orders_id_seq"] {
        assert!(has_suffix(&ids, s), "{s}");
    }
    assert!(!ids.iter().any(|i| i.contains("pg_catalog")));
    let roles = tree.iter().find(|n| n.id == format!("{}/roles", c.id)).expect("roles node");
    assert!(roles.count.unwrap() > 0);

    let cols = meta::table_columns(&pool, "public", "orders").await.unwrap();
    assert!(cols[0].pk && cols[0].numeric);
    assert!(cols[1].fk && !cols[1].pk);
    assert_eq!(cols[5].type_name, "jsonb");

    let er = meta::er_model(&pool, "public").await.unwrap();
    assert_eq!(er.tables.len(), 5);
    assert!(er.relations.iter().any(|r| r.id == "orders.customer_id->customers" && r.to_column == "id"));
    assert!(er.relations.iter().any(|r| r.id == "order_items.product_id->products"));

    let comp = meta::completion_schema(&pool, &c).await.unwrap();
    assert!(comp["orders"].contains(&"customer_id".to_string()));

    let desc = Some(OrderBy { column: "total".into(), desc: true });
    let p = page::table_page(&pool, "public", "orders", desc.clone(), None, 0, 2).await.unwrap();
    assert_eq!(p.rows.iter().map(|r| r[3].clone()).collect::<Vec<_>>(), [json!("12900000.00"), json!("3480000.00")]);
    assert!(p.has_more);
    let p = page::table_page(&pool, "public", "orders", desc, None, 4, 2).await.unwrap();
    assert_eq!(p.rows.len(), 1);
    assert!(!p.has_more);
    let bad = Some(OrderBy { column: "nope".into(), desc: false });
    assert!(matches!(page::table_page(&pool, "public", "orders", bad, None, 0, 2).await, Err(AppError::Query(_))));
}

#[tokio::test]
async fn enum_column_values() {
    let Some(c) = pg() else { return };
    let (mgr, pool) = open(&c).await;
    // Own schema: other tests count the tables in `public` concurrently.
    let s = format!("ahsandb_t_{}", rand_suffix());
    exec(&mgr, &pool, &c, &format!("CREATE SCHEMA {s}; CREATE TYPE {s}.mood AS ENUM ('sad', 'it''s ok', 'happy'); CREATE TABLE {s}.t (id int PRIMARY KEY, mood {s}.mood, note text)")).await.unwrap();
    let cols = meta::table_columns(&pool, &s, "t").await;
    exec(&mgr, &pool, &c, &format!("DROP SCHEMA {s} CASCADE")).await.unwrap();
    let cols = cols.unwrap();
    assert_eq!(cols[1].enum_values, ["sad", "it's ok", "happy"]);
    assert!(cols[0].enum_values.is_empty() && cols[2].enum_values.is_empty());
}
