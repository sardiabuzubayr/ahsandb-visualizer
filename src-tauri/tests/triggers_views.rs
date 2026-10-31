//! Triggers, views, sequence/event DDL against real servers. PG/MySQL parts run only when
//! AHSANDB_TEST_PG / AHSANDB_TEST_MYSQL are set; PG works in a temp schema, MariaDB on uniquely named
//! objects, SQLite on a temp file — all removed at the end.
mod common;

use std::future::Future;
use std::panic::AssertUnwindSafe;

use ahsandb_lib::db::{self, Pool, meta};
use ahsandb_lib::ddl;
use ahsandb_lib::error::AppError;
use ahsandb_lib::model::*;
use ahsandb_lib::objects::{triggers, views};
use common::*;
use futures::FutureExt;

fn uniq() -> String {
    format!("ahsandb_t_{}", rand_suffix())
}

/// Runs SQL on the text protocol, panicking on error.
async fn raw(pool: &Pool, sql: &str) {
    let r = match pool {
        Pool::Pg(p) => sqlx::raw_sql(sql).execute(p).await.map(|_| ()),
        Pool::My(p) => sqlx::raw_sql(sql).execute(p).await.map(|_| ()),
        Pool::Lite(p) => sqlx::raw_sql(sql).execute(p).await.map(|_| ()),
    };
    r.unwrap_or_else(|e| panic!("{sql}: {e}"));
}

/// Runs `body`, then `cleanup` even if `body` panicked.
async fn with_cleanup(body: impl Future<Output = ()>, cleanup: impl Future<Output = ()>) {
    let res = AssertUnwindSafe(body).catch_unwind().await;
    cleanup.await;
    if let Err(p) = res {
        std::panic::resume_unwind(p);
    }
}

fn is_not_found<T>(r: Result<T, AppError>) -> bool {
    matches!(r, Err(AppError::NotFound(_)))
}

fn is_not_supported<T>(r: Result<T, AppError>) -> bool {
    matches!(r, Err(AppError::NotSupported(_)))
}

/// Create → load equal → edit/rename/move → load equal, old name gone → drop → not found.
async fn trigger_roundtrip(c: &Connection, pool: &Pool, created: Trigger, edited: Trigger) {
    let (mgr, d, schema) = (db::Manager::default(), c.driver, created.schema.clone());
    apply_ok(&mgr, pool, c, triggers::plan_trigger(d, None, Some(&created)).unwrap()).await;
    let loaded = triggers::load_trigger(pool, &schema, &created.name).await.unwrap();
    assert_eq!(loaded, created);
    apply_ok(&mgr, pool, c, triggers::plan_trigger(d, Some(&loaded), Some(&edited)).unwrap()).await;
    let loaded = triggers::load_trigger(pool, &schema, &edited.name).await.unwrap();
    assert_eq!(loaded, edited);
    if edited.name != created.name {
        assert!(is_not_found(triggers::load_trigger(pool, &schema, &created.name).await));
    }
    apply_ok(&mgr, pool, c, triggers::plan_trigger(d, Some(&loaded), None).unwrap()).await;
    assert!(is_not_found(triggers::load_trigger(pool, &schema, &edited.name).await));
}

/// Create → change query → rename → reload matches → drop. Servers rewrite the query, so "matches" means
/// a re-save of the loaded text loads back identically and contains the marker.
async fn view_roundtrip(c: &Connection, pool: &Pool, schema: &str, name: &str, first: &str, second: &str, marker: &str) {
    let (mgr, d) = (db::Manager::default(), c.driver);
    let v = ViewDef { schema: schema.into(), name: name.into(), query: format!("{first} ;\n") };
    apply_ok(&mgr, pool, c, views::plan_view(d, None, &v).unwrap()).await;
    let loaded = views::load_view(pool, schema, name).await.unwrap();
    assert!(!loaded.query.ends_with(';') && !loaded.query.is_empty(), "{}", loaded.query);
    let changed = ViewDef { query: second.into(), ..loaded.clone() };
    apply_ok(&mgr, pool, c, views::plan_view(d, Some(&loaded), &changed).unwrap()).await;
    let loaded = views::load_view(pool, schema, name).await.unwrap();
    assert!(loaded.query.contains(marker), "{}", loaded.query);
    let renamed = ViewDef { name: format!("{name}_r"), ..loaded.clone() };
    apply_ok(&mgr, pool, c, views::plan_view(d, Some(&loaded), &renamed).unwrap()).await;
    assert_eq!(views::load_view(pool, schema, &renamed.name).await.unwrap(), renamed);
    assert!(is_not_found(views::load_view(pool, schema, name).await));
    apply_ok(&mgr, pool, c, ddl::plan_drop(d, ObjectKind::View, schema, &renamed.name).unwrap()).await;
    assert!(is_not_found(views::load_view(pool, schema, &renamed.name).await));
}

// ---------- PostgreSQL ----------

fn pg() -> Option<Connection> {
    from_env("AHSANDB_TEST_PG", Driver::Postgres)
}

#[tokio::test]
async fn pg_seed_objects() {
    let Some(c) = pg() else { return };
    let (_mgr, pool) = open(&c).await;
    let t = triggers::load_trigger(&pool, "public", "trg_orders_touch").await.unwrap();
    assert_eq!((t.table.as_str(), t.timing.as_str(), t.events.as_slice(), t.for_each_row), ("orders", "BEFORE", &["INSERT".to_string()][..], true));
    assert!(t.condition.is_none());
    assert!(t.body == "trg_touch()" || t.body == "public.trg_touch()", "{}", t.body);
    assert!(is_not_found(triggers::load_trigger(&pool, "public", "nope").await));
    let v = views::load_view(&pool, "public", "v_open_orders").await.unwrap();
    assert!(v.query.starts_with("SELECT") && v.query.contains("'pending'"), "{}", v.query);
    assert!(is_not_found(views::load_view(&pool, "public", "nope").await));
    assert!(is_not_supported(views::object_ddl(&pool, ObjectKind::Event, "public", "x").await));
    assert!(is_not_supported(views::object_ddl(&pool, ObjectKind::View, "public", "v_open_orders").await));
}

#[tokio::test]
async fn pg_triggers_views_sequences() {
    let Some(c) = pg() else { return };
    let (_mgr, pool) = open(&c).await;
    let (s, s2) = (uniq(), uniq());
    raw(&pool, &format!(
        "CREATE SCHEMA {s}; CREATE SCHEMA {s2};
         CREATE TABLE {s}.t (id int, n text); CREATE TABLE {s}.t2 (id int);
         CREATE FUNCTION {s}.f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;"
    ))
    .await;
    with_cleanup(
        async {
            let created = Trigger {
                schema: s.clone(),
                name: "trg x".into(),
                table: "t".into(),
                timing: "BEFORE".into(),
                events: vec!["INSERT".into(), "UPDATE".into()],
                for_each_row: true,
                condition: Some("new.n IS NOT NULL".into()),
                body: format!("{s}.f()"),
            };
            let edited = Trigger {
                name: "trg\"y".into(),
                table: "t2".into(),
                timing: "AFTER".into(),
                events: vec!["TRUNCATE".into()],
                for_each_row: false,
                condition: None,
                ..created.clone()
            };
            trigger_roundtrip(&c, &pool, created, edited).await;

            view_roundtrip(&c, &pool, &s, "v", &format!("SELECT id FROM {s}.t"), &format!("SELECT id, n FROM {s}.t WHERE id > 41"), "41").await;
            raw(&pool, &format!("CREATE MATERIALIZED VIEW {s}.mv AS SELECT 1 AS x")).await;
            assert!(is_not_supported(views::load_view(&pool, &s, "mv").await));

            // Sequence DDL re-runs in another schema.
            raw(&pool, &format!(
                "CREATE SEQUENCE {s}.seq AS integer INCREMENT BY 5 MINVALUE 3 START WITH 10 CACHE 2 CYCLE OWNED BY {s}.t.id;
                 SELECT nextval('{s}.seq'); CREATE TABLE {s2}.t (id int);"
            ))
            .await;
            let ddl = views::object_ddl(&pool, ObjectKind::Sequence, &s, "seq").await.unwrap();
            let q = format!("\"{s}\"");
            // pg_sequences.last_value is the last value written to disk: with CACHE 2 it runs ahead (15).
            assert_eq!(
                ddl,
                format!(
                    "CREATE SEQUENCE {q}.\"seq\" AS integer INCREMENT BY 5 MINVALUE 3 MAXVALUE 2147483647 START WITH 10 CACHE 2 CYCLE;\n\
                     ALTER SEQUENCE {q}.\"seq\" OWNED BY {s}.t.id;\n\
                     -- SELECT setval('{q}.\"seq\"', 15);"
                )
            );
            raw(&pool, &ddl.replace(&s, &s2)).await;
            let copy = views::object_ddl(&pool, ObjectKind::Sequence, &s2, "seq").await.unwrap();
            assert_eq!(copy, ddl.replace(&s, &s2).lines().take(2).collect::<Vec<_>>().join("\n"));
            let mgr = db::Manager::default();
            apply_ok(&mgr, &pool, &c, ddl::plan_drop(c.driver, ObjectKind::Sequence, &s2, "seq").unwrap()).await;
            assert!(is_not_found(views::object_ddl(&pool, ObjectKind::Sequence, &s2, "seq").await));
        },
        async {
            raw(&pool, &format!("DROP SCHEMA IF EXISTS {s} CASCADE; DROP SCHEMA IF EXISTS {s2} CASCADE")).await;
        },
    )
    .await;
}

// ---------- MySQL / MariaDB ----------

fn my() -> Option<Connection> {
    from_env("AHSANDB_TEST_MYSQL", Driver::Mariadb)
}

const DB: &str = "ahsandb_test";

#[tokio::test]
async fn my_seed_trigger() {
    let Some(c) = my() else { return };
    let (_mgr, pool) = open(&c).await;
    let t = triggers::load_trigger(&pool, DB, "trg_orders_touch").await.unwrap();
    assert_eq!((t.table.as_str(), t.timing.as_str(), t.events.as_slice(), t.for_each_row), ("orders", "BEFORE", &["INSERT".to_string()][..], true));
    assert!(t.body.starts_with("BEGIN") && t.body.ends_with("END"), "{}", t.body);
    assert!(is_not_found(triggers::load_trigger(&pool, DB, "nope").await));
    assert!(is_not_found(views::load_view(&pool, DB, "nope").await));
    assert!(is_not_supported(views::object_ddl(&pool, ObjectKind::Sequence, DB, "x").await));
}

#[tokio::test]
async fn my_triggers_and_views() {
    let Some(c) = my() else { return };
    let (_mgr, pool) = open(&c).await;
    let (t1, t2, v) = (uniq(), uniq(), uniq());
    raw(&pool, &format!("CREATE TABLE {DB}.{t1} (id int, note varchar(20)); CREATE TABLE {DB}.{t2} (id int)")).await;
    with_cleanup(
        async {
            let created = Trigger {
                schema: DB.into(),
                name: format!("{t1}_trg"),
                table: t1.clone(),
                timing: "BEFORE".into(),
                events: vec!["INSERT".into()],
                for_each_row: true,
                condition: None,
                body: "BEGIN\n  SET NEW.note = 'a;b';\nEND".into(),
            };
            // MariaDB: rename + move to another table (DROP + CREATE OR REPLACE).
            let edited = Trigger {
                name: format!("{t1}_trg2"),
                table: t2.clone(),
                timing: "AFTER".into(),
                events: vec!["DELETE".into()],
                body: "BEGIN\n  DO 1;\nEND".into(),
                ..created.clone()
            };
            trigger_roundtrip(&c, &pool, created.clone(), edited).await;
            // MySQL path (DROP + CREATE) works on MariaDB too.
            let mysql = Connection { driver: Driver::Mysql, ..c.clone() };
            let changed = Trigger { events: vec!["UPDATE".into()], ..created.clone() };
            trigger_roundtrip(&mysql, &pool, created, changed).await;

            view_roundtrip(&c, &pool, DB, &v, "SELECT id FROM orders", "SELECT id, status FROM orders WHERE id > 41", "41").await;
        },
        async {
            raw(&pool, &format!("DROP TABLE IF EXISTS {DB}.{t1}, {DB}.{t2}; DROP VIEW IF EXISTS {DB}.{v}, {DB}.{v}_r")).await;
        },
    )
    .await;
}

#[tokio::test]
async fn my_event_ddl_tree_and_drop() {
    let Some(c) = my() else { return };
    let (mgr, pool) = open(&c).await;
    let e = uniq();
    raw(&pool, &format!("CREATE EVENT {DB}.{e} ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1")).await;
    with_cleanup(
        async {
            let ddl = views::object_ddl(&pool, ObjectKind::Event, DB, &e).await.unwrap();
            assert!(ddl.starts_with("CREATE") && ddl.contains(&format!("EVENT `{e}`")) && ddl.ends_with(';'), "{ddl}");
            let tree = meta::schema_tree(&pool, &c).await.unwrap();
            let node = flatten(&tree).into_iter().find(|n| n.id.ends_with(&format!("/{DB}/events/{e}"))).expect("event node");
            assert_eq!((node.kind, node.schema.as_deref()), (NodeKind::Event, Some(DB)));
            apply_ok(&mgr, &pool, &c, ddl::plan_drop(c.driver, ObjectKind::Event, DB, &e).unwrap()).await;
            assert!(views::object_ddl(&pool, ObjectKind::Event, DB, &e).await.is_err());
        },
        async {
            raw(&pool, &format!("DROP EVENT IF EXISTS {DB}.{e}")).await;
        },
    )
    .await;
}

// ---------- SQLite ----------

#[tokio::test]
async fn sqlite_triggers_and_views() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.db");
    db::create_sqlite_file(path.to_str().unwrap()).await.unwrap();
    let c = Connection { file: Some(path.to_str().unwrap().into()), ..conn(Driver::Sqlite) };
    let (_mgr, pool) = open(&c).await;
    raw(&pool, "CREATE TABLE t (id INTEGER, n TEXT); CREATE TABLE log (msg TEXT);").await;
    let created = Trigger {
        schema: "main".into(),
        name: "trg \"x\"".into(),
        table: "t".into(),
        timing: "AFTER".into(),
        events: vec!["INSERT".into()],
        for_each_row: true,
        condition: Some("NEW.id > 0".into()),
        body: "BEGIN\n  INSERT INTO log VALUES ('END;');\nEND".into(),
    };
    let edited = Trigger { name: "trg2".into(), timing: "BEFORE".into(), events: vec!["DELETE".into()], condition: None, ..created.clone() };
    trigger_roundtrip(&c, &pool, created, edited).await;
    view_roundtrip(&c, &pool, "main", "v", "SELECT id FROM t", "SELECT id, n FROM t WHERE id > 41", "41").await;
    assert!(is_not_found(views::load_view(&pool, "main", "v").await));
    assert!(is_not_found(triggers::load_trigger(&pool, "main", "nope").await));
    assert!(is_not_supported(views::object_ddl(&pool, ObjectKind::Sequence, "main", "s").await));
    assert!(is_not_supported(views::object_ddl(&pool, ObjectKind::Event, "main", "e").await));
    let tree = meta::schema_tree(&pool, &c).await.unwrap();
    assert!(!flatten(&tree).iter().any(|n| n.id.ends_with("/events")));
}
