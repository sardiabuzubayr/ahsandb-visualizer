//! Export engine: dump → import round trips and data export. SQLite tests always run;
//! PG/MariaDB run when AHSANDB_TEST_PG / AHSANDB_TEST_MYSQL are set. Seeds are only read; dumps load
//! into temp databases `ahsandb_t_<rand>` that are dropped at the end (also when an assertion fails).
mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use ahsandb_lib::db::{self, Manager, Pool};
use ahsandb_lib::model::*;
use ahsandb_lib::transfer::JobCtx;
use ahsandb_lib::transfer::export::{export_data, export_database};
use common::*;

/// Runs `body` in its own task so a failed assertion still reaches `cleanup`, then re-raises it.
async fn guarded(body: impl Future<Output = ()> + Send + 'static, cleanup: impl Future<Output = ()>) {
    let outcome = tokio::spawn(body).await;
    cleanup.await;
    if let Err(e) = outcome {
        std::panic::resume_unwind(e.into_panic());
    }
}

/// Imports a script the way the SQL import does: split for the driver (`db::exec` uses `sql::split`),
/// every statement on one connection, stopping at the first error.
async fn run_script(mgr: &Manager, pool: &Pool, c: &Connection, script: &str) {
    if !script.trim().is_empty() {
        rows(mgr, pool, c, script).await;
    }
}

async fn scalar(pool: &Pool, sql: &str) -> i64 {
    match pool {
        Pool::Pg(p) => sqlx::query_scalar(sql).fetch_one(p).await,
        Pool::My(p) => sqlx::query_scalar(sql).fetch_one(p).await,
        Pool::Lite(p) => sqlx::query_scalar(sql).fetch_one(p).await,
    }
    .unwrap_or_else(|e| panic!("{sql}: {e}"))
}

fn dump_opts(schema: &str, path: &Path, content: DumpContent) -> ExportDatabaseOptions {
    ExportDatabaseOptions {
        schema: schema.into(),
        objects: vec![],
        content,
        transaction: true,
        drop_existing: true,
        batch_size: 2,
        gzip: false,
        path: path.to_str().unwrap().into(),
    }
}

fn data_opts(source: DataSource, format: DataFormat, path: &Path) -> ExportDataOptions {
    ExportDataOptions {
        source,
        format,
        path: path.to_str().unwrap().into(),
        delimiter: None,
        header: true,
        batch_size: Some(2),
        table_name: None,
    }
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

fn part(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.part", path.display()))
}

/// Dumps `schema` of `src` and returns the script, checking the job result and progress.
async fn dump(pool: &Pool, c: &Connection, opts: &ExportDatabaseOptions) -> String {
    let (ctx, progress) = JobCtx::for_test();
    let done = export_database(pool, c, opts, &ctx).await;
    assert!(done.ok && !done.cancelled, "{}", done.message);
    assert_eq!(done.message, opts.path);
    assert!(!part(Path::new(&opts.path)).exists());
    if opts.content != DumpContent::Structure {
        assert!(!progress.lock().unwrap().is_empty());
    }
    read(Path::new(&opts.path))
}

/// Seed tables of the PG/MariaDB fixture (scripts/seed).
const SEED_TABLES: [&str; 5] = ["customers", "products", "orders", "order_items", "payments"];

/// Table data in `src` and `dst`: same row counts; same content for `same_content` tables.
async fn compare_tables(src: (&Manager, &Pool, &Connection), dst: (&Manager, &Pool, &Connection), same_content: &[&str]) -> i64 {
    let mut total = 0;
    for t in SEED_TABLES {
        let n = scalar(src.1, &format!("SELECT count(*) FROM {t}")).await;
        assert_eq!(n, scalar(dst.1, &format!("SELECT count(*) FROM {t}")).await, "rows of {t}");
        total += n;
        if same_content.contains(&t) {
            let sql = format!("SELECT * FROM {t} ORDER BY id");
            assert_eq!(rows(src.0, src.1, src.2, &sql).await, rows(dst.0, dst.1, dst.2, &sql).await, "content of {t}");
        }
    }
    total
}

// ---------- PostgreSQL ----------

#[tokio::test]
async fn postgres_dump_round_trip_and_data_export() {
    let Some(c) = from_env("AHSANDB_TEST_PG", Driver::Postgres) else { return };
    let tmp = format!("ahsandb_t_{}", rand_suffix());
    let (_mgr, admin) = open(&c).await;
    let Pool::Pg(p) = &*admin else { panic!("not PostgreSQL") };
    sqlx::query(&format!("CREATE DATABASE {tmp}")).execute(p).await.unwrap();
    guarded(pg_body(c.clone(), tmp.clone()), async {
        sqlx::query(&format!("DROP DATABASE IF EXISTS {tmp} WITH (FORCE)")).execute(p).await.expect("cleanup");
    })
    .await;
}

async fn pg_body(c: Connection, tmp: String) {
    let (smgr, src) = open(&c).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dump.sql");
    let script = dump(&src, &c, &dump_opts("public", &path, DumpContent::Both)).await;
    assert!(script.starts_with("-- AhsanDB dump\n-- Connection: test\n-- Schema: public\n"), "{script}");
    // FKs come after the data, as ALTERs; owned (serial) sequences are not dumped separately.
    let (insert, fk) = (script.find("INSERT INTO").unwrap(), script.find("ADD CONSTRAINT").unwrap());
    assert!(insert < fk && !script.contains("CREATE SEQUENCE"), "{script}");

    let target = Connection { id: "test-target".into(), database: Some(tmp.clone()), ..c.clone() };
    let (dmgr, dst) = open(&target).await;
    run_script(&dmgr, &dst, &target, &script).await;
    let total = compare_tables((&smgr, &src, &c), (&dmgr, &dst, &target), &SEED_TABLES).await;
    for (sql, n) in [
        ("SELECT count(*) FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_open_orders'", 1),
        ("SELECT count(*) FROM pg_proc WHERE proname IN ('fn_order_total', 'close_paid_orders', 'trg_touch')", 3),
        ("SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_orders_touch'", 1),
        ("SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace", 4),
        ("SELECT count(*) FROM v_open_orders", 2),
    ] {
        assert_eq!(scalar(&dst, sql).await, n, "{sql}");
    }
    // setval: the next generated id follows the copied rows.
    let max = scalar(&src, "SELECT max(id) FROM customers").await;
    assert_eq!(scalar(&dst, "INSERT INTO customers (name) VALUES ('new') RETURNING id").await, max + 1);
    run_script(&dmgr, &dst, &target, "DELETE FROM customers WHERE name = 'new'").await;
    // DROP IF EXISTS makes the script re-runnable over its own output.
    run_script(&dmgr, &dst, &target, &script).await;
    let (ctx, _) = JobCtx::for_test();
    let again = export_database(&src, &c, &dump_opts("public", &path, DumpContent::Both), &ctx).await;
    assert_eq!(again.succeeded as i64, total);
    compare_tables((&smgr, &src, &c), (&dmgr, &dst, &target), &["orders"]).await;

    // Structure only / data only.
    let structure = dump(&src, &c, &dump_opts("public", &path, DumpContent::Structure)).await;
    assert!(structure.contains("CREATE TABLE") && !structure.contains("INSERT INTO") && !structure.contains("setval"));
    let data = dump(&src, &c, &dump_opts("public", &path, DumpContent::Data)).await;
    assert!(data.contains("INSERT INTO") && data.contains("setval") && !data.contains("CREATE "), "{data}");

    data_exports(&src, &c, (&dmgr, &dst, &target), "public", "CREATE TABLE orders_copy (LIKE orders)").await;
}

async fn run(src: &Pool, c: &Connection, opts: ExportDataOptions) -> (JobDone, String) {
    let (ctx, _) = JobCtx::for_test();
    (export_data(src, c, &opts, &ctx).await, opts.path)
}

/// Data export of the seed `orders` table: CSV (header + 5 rows), JSON (5 objects), SQL loaded into a copy
/// table in the temp database, read query, refused write query.
async fn data_exports(src: &Pool, c: &Connection, dst: (&Manager, &Pool, &Connection), schema: &str, create_copy: &str) {
    let dir = tempfile::tempdir().unwrap();
    let orders = || DataSource::Table { schema: schema.into(), table: "orders".into() };

    let (done, path) = run(src, c, data_opts(orders(), DataFormat::Csv, &dir.path().join("orders.csv"))).await;
    assert!(done.ok && done.succeeded == 5, "{}", done.message);
    let csv = read(Path::new(&path));
    let lines: Vec<&str> = csv.split_terminator("\r\n").collect();
    assert_eq!(lines.len(), 6, "{csv}");
    assert!(lines[0].starts_with("id,customer_id,status,total,note"), "{}", lines[0]);

    let (done, path) = run(src, c, data_opts(orders(), DataFormat::Json, &dir.path().join("orders.json"))).await;
    assert!(done.ok, "{}", done.message);
    let json = read(Path::new(&path));
    assert!(json.starts_with("[\n{\"id\":1,\"customer_id\":1,"), "{json}");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v.as_array().unwrap().len(), 5);

    let opts = ExportDataOptions { table_name: Some("orders_copy".into()), ..data_opts(orders(), DataFormat::Sql, &dir.path().join("orders.sql")) };
    let (done, path) = run(src, c, opts).await;
    assert!(done.ok, "{}", done.message);
    let sql = read(Path::new(&path));
    assert_eq!(sql.matches("INSERT INTO").count(), 3, "batches of 2: {sql}");
    run_script(dst.0, dst.1, dst.2, &format!("{create_copy};\n{sql}")).await;
    assert_eq!(scalar(dst.1, "SELECT count(*) FROM orders_copy").await, 5);

    let query = DataSource::Query { sql: "SELECT id, status FROM orders WHERE total > 1000000 ORDER BY id;".into() };
    let (done, path) = run(src, c, ExportDataOptions { header: false, delimiter: Some(";".into()), ..data_opts(query, DataFormat::Csv, &dir.path().join("q.csv")) }).await;
    assert!(done.ok, "{}", done.message);
    assert_eq!(read(Path::new(&path)), "1;shipped\r\n2;pending\r\n4;pending\r\n");

    for sql in ["DELETE FROM orders", "SELECT 1; DELETE FROM orders"] {
        let path = dir.path().join("w.csv");
        let (done, _) = run(src, c, data_opts(DataSource::Query { sql: sql.into() }, DataFormat::Csv, &path)).await;
        assert!(!done.ok && done.message == "Only read queries can be exported", "{sql}: {}", done.message);
        assert!(!path.exists() && !part(&path).exists());
    }
    assert_eq!(scalar(src, "SELECT count(*) FROM orders").await, 5, "seed untouched");
}

// ---------- MariaDB ----------

#[tokio::test]
async fn mariadb_dump_round_trip_and_data_export() {
    let Some(c) = from_env("AHSANDB_TEST_MYSQL", Driver::Mariadb) else { return };
    let tmp = format!("ahsandb_t_{}", rand_suffix());
    let (_mgr, admin) = open(&c).await;
    let Pool::My(p) = &*admin else { panic!("not MySQL") };
    sqlx::query(&format!("CREATE DATABASE `{tmp}`")).execute(p).await.unwrap();
    guarded(my_body(c.clone(), tmp.clone()), async {
        sqlx::query(&format!("DROP DATABASE IF EXISTS `{tmp}`")).execute(p).await.expect("cleanup");
    })
    .await;
}

async fn my_body(c: Connection, tmp: String) {
    let (smgr, src) = open(&c).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dump.sql");
    let script = dump(&src, &c, &dump_opts("ahsandb_test", &path, DumpContent::Both)).await;
    assert!(script.contains("SET FOREIGN_KEY_CHECKS=0;") && script.trim_end().ends_with("SET FOREIGN_KEY_CHECKS=1;"));
    assert!(script.contains("DELIMITER ;;\n") && script.contains("END;;\nDELIMITER ;\n"), "{script}");
    // Objects aren't tied to the source database, so the dump loads anywhere.
    assert!(!script.contains("`ahsandb_test`."), "{script}");

    let target = Connection { id: "test-target".into(), database: Some(tmp.clone()), ..c.clone() };
    let (dmgr, dst) = open(&target).await;
    run_script(&dmgr, &dst, &target, &script).await;
    // shortcut in export: the non-UTF-8 payments.receipt blob doesn't round-trip, so payments is compared by count.
    compare_tables((&smgr, &src, &c), (&dmgr, &dst, &target), &["customers", "products", "orders", "order_items"]).await;
    let s = format!("'{tmp}'");
    for (sql, n) in [
        (format!("SELECT count(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA = {s} AND TABLE_NAME = 'v_open_orders'"), 1),
        (format!("SELECT count(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = {s}"), 2),
        (format!("SELECT count(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = {s} AND TRIGGER_NAME = 'trg_orders_touch'"), 1),
        (format!("SELECT count(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = {s}"), 4),
        ("SELECT count(*) FROM v_open_orders".into(), 2),
        ("SELECT CAST(fn_order_total(1) AS SIGNED)".into(), 580000),
    ] {
        assert_eq!(scalar(&dst, &sql).await, n, "{sql}");
    }
    run_script(&dmgr, &dst, &target, &script).await;
    compare_tables((&smgr, &src, &c), (&dmgr, &dst, &target), &["orders"]).await;

    let structure = dump(&src, &c, &dump_opts("ahsandb_test", &path, DumpContent::Structure)).await;
    assert!(structure.contains("CREATE TABLE") && !structure.contains("INSERT INTO"));
    let data = dump(&src, &c, &dump_opts("ahsandb_test", &path, DumpContent::Data)).await;
    assert!(data.contains("INSERT INTO") && !data.contains("CREATE "));

    data_exports(&src, &c, (&dmgr, &dst, &target), "ahsandb_test", "CREATE TABLE orders_copy LIKE orders").await;
}

// ---------- SQLite (always runs) ----------

const LITE_FIXTURE: &str = "
CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, note TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id),
  total NUMERIC, data BLOB, paid INTEGER DEFAULT 0);
CREATE INDEX orders_customer ON orders (customer_id);
CREATE TABLE log (msg TEXT);
INSERT INTO customers (name, note) VALUES ('O''Neil', 'line1
line2'), ('日本 ✓', NULL), ('a,b', '\"q\"; DROP TABLE x;--');
INSERT INTO orders (customer_id, total, data, paid) VALUES (1, 12.5, X'DEADBEEF', 1), (1, 3, 'text blob', 0), (2, NULL, NULL, 0);
INSERT INTO log VALUES ('a'), ('b');
CREATE VIEW v_orders AS SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id;
CREATE TRIGGER trg_log AFTER INSERT ON orders BEGIN INSERT INTO log (msg) VALUES ('new'); END;
";

/// A new SQLite database file (in `dir`) with `script` applied.
async fn lite_db(dir: &Path, name: &str, script: &str) -> (Connection, Manager, Arc<Pool>) {
    let file = dir.join(name);
    db::create_sqlite_file(file.to_str().unwrap()).await.unwrap();
    let c = Connection { id: format!("lite-{name}"), file: Some(file.to_str().unwrap().into()), ..conn(Driver::Sqlite) };
    let (mgr, pool) = open(&c).await;
    run_script(&mgr, &pool, &c, script).await;
    (c, mgr, pool)
}

#[tokio::test]
async fn sqlite_dump_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let (c, smgr, src) = lite_db(dir.path(), "src.db", LITE_FIXTURE).await;
    let path = dir.path().join("dump.sql");
    let script = dump(&src, &c, &dump_opts("main", &path, DumpContent::Both)).await;
    assert!(script.contains("PRAGMA foreign_keys=OFF;") && script.contains("REFERENCES \"customers\""), "{script}");

    let (t, dmgr, dst) = lite_db(dir.path(), "dst.db", "").await;
    run_script(&dmgr, &dst, &t, &script).await;
    for table in ["customers", "orders", "log"] {
        let sql = format!("SELECT count(*) FROM {table}");
        assert_eq!(scalar(&src, &sql).await, scalar(&dst, &sql).await, "{table}");
    }
    let sql = "SELECT * FROM customers ORDER BY id";
    assert_eq!(rows(&smgr, &src, &c, sql).await, rows(&dmgr, &dst, &t, sql).await);
    let sql = "SELECT id, total, CAST(data AS TEXT) FROM orders WHERE id > 1 ORDER BY id";
    assert_eq!(rows(&smgr, &src, &c, sql).await, rows(&dmgr, &dst, &t, sql).await);
    for (kind, name) in [("view", "v_orders"), ("trigger", "trg_log"), ("index", "orders_customer")] {
        let sql = format!("SELECT count(*) FROM sqlite_master WHERE type = '{kind}' AND name = '{name}'");
        assert_eq!(scalar(&dst, &sql).await, 1, "{kind} {name}");
    }
    // AUTOINCREMENT continues after the copied ids; the trigger fires on new rows only.
    run_script(&dmgr, &dst, &t, "INSERT INTO customers (name) VALUES ('new')").await;
    assert_eq!(scalar(&dst, "SELECT max(id) FROM customers").await, 4);
    // Re-runnable (DROP IF EXISTS).
    run_script(&dmgr, &dst, &t, &script).await;
    assert_eq!(scalar(&dst, "SELECT count(*) FROM customers").await, 3);

    // A subset of objects.
    let opts = ExportDatabaseOptions {
        objects: vec![DumpObject { kind: ObjectKind::Table, name: "log".into() }],
        ..dump_opts("main", &path, DumpContent::Both)
    };
    let only = dump(&src, &c, &opts).await;
    assert!(only.contains("CREATE TABLE \"log\"") && !only.contains("customers") && !only.contains("VIEW"), "{only}");
}

#[tokio::test]
async fn sqlite_dump_variants_and_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let (c, _mgr, src) = lite_db(dir.path(), "src.db", LITE_FIXTURE).await;

    // gzip
    let gz = dir.path().join("dump.sql.gz");
    let (ctx, _) = JobCtx::for_test();
    let done = export_database(&src, &c, &ExportDatabaseOptions { gzip: true, ..dump_opts("main", &gz, DumpContent::Both) }, &ctx).await;
    assert!(done.ok && done.succeeded == 8, "{done:?}");
    let mut text = String::new();
    std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(std::fs::File::open(&gz).unwrap()), &mut text).unwrap();
    assert!(text.starts_with("-- AhsanDB dump") && text.contains("CREATE TABLE") && text.contains("INSERT INTO"));

    let path = dir.path().join("dump.sql");
    let structure = dump(&src, &c, &dump_opts("main", &path, DumpContent::Structure)).await;
    assert!(structure.contains("CREATE TABLE") && structure.contains("CREATE TRIGGER") && !structure.contains("INSERT INTO \""));
    let data = dump(&src, &c, &dump_opts("main", &path, DumpContent::Data)).await;
    assert!(data.contains("INSERT INTO") && !data.contains("CREATE ") && !data.contains("DROP TABLE IF"), "{data}");
    let plain = dump(&src, &c, &ExportDatabaseOptions { transaction: false, drop_existing: false, ..dump_opts("main", &path, DumpContent::Both) }).await;
    assert!(!plain.contains("BEGIN;") && !plain.contains("DROP TABLE IF") && !plain.contains("DROP VIEW"));

    // Cancelled before the first batch: no output, no part file.
    let cancelled = || JobCtx::new("t".into(), Arc::new(AtomicBool::new(true)), Box::new(|_| {}));
    let out = dir.path().join("cancelled.sql");
    let done = export_database(&src, &c, &dump_opts("main", &out, DumpContent::Both), &cancelled()).await;
    assert!(done.cancelled && !done.ok, "{done:?}");
    assert!(!out.exists() && !part(&out).exists());
    let out = dir.path().join("cancelled.csv");
    let source = DataSource::Table { schema: "main".into(), table: "customers".into() };
    let done = export_data(&src, &c, &data_opts(source, DataFormat::Csv, &out), &cancelled()).await;
    assert!(done.cancelled && !out.exists() && !part(&out).exists());

    // Unwritable path: io error, nothing left behind.
    let (ctx, _) = JobCtx::for_test();
    let bad = dir.path().join("missing/dump.sql");
    let done = export_database(&src, &c, &dump_opts("main", &bad, DumpContent::Both), &ctx).await;
    assert!(!done.ok && !done.cancelled && !done.message.is_empty());
    assert!(!dir.path().join("missing").exists());
}

#[tokio::test]
async fn sqlite_data_export() {
    let dir = tempfile::tempdir().unwrap();
    let (c, mgr, src) = lite_db(dir.path(), "src.db", LITE_FIXTURE).await;
    let customers = || DataSource::Table { schema: "main".into(), table: "customers".into() };
    let export = async |opts: ExportDataOptions| {
        let (done, path) = run(&src, &c, opts).await;
        assert!(done.ok, "{}", done.message);
        read(Path::new(&path))
    };

    let csv = export(data_opts(customers(), DataFormat::Csv, &dir.path().join("c.csv"))).await;
    assert_eq!(csv, "id,name,note\r\n1,O'Neil,\"line1\nline2\"\r\n2,日本 ✓,\r\n3,\"a,b\",\"\"\"q\"\"; DROP TABLE x;--\"\r\n");
    let tsv = export(ExportDataOptions { delimiter: Some("\t".into()), header: false, ..data_opts(customers(), DataFormat::Csv, &dir.path().join("c.tsv")) }).await;
    assert_eq!(tsv, "1\tO'Neil\t\"line1\nline2\"\r\n2\t日本 ✓\t\r\n3\ta,b\t\"\"\"q\"\"; DROP TABLE x;--\"\r\n");

    let json = export(data_opts(customers(), DataFormat::Json, &dir.path().join("c.json"))).await;
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v, serde_json::json!([
        {"id": 1, "name": "O'Neil", "note": "line1\nline2"},
        {"id": 2, "name": "日本 ✓", "note": null},
        {"id": 3, "name": "a,b", "note": "\"q\"; DROP TABLE x;--"},
    ]));

    // Empty result: CSV still has its header, JSON is [].
    let empty = || DataSource::Query { sql: "SELECT id, name FROM customers WHERE id < 0".into() };
    assert_eq!(export(data_opts(empty(), DataFormat::Csv, &dir.path().join("e.csv"))).await, "id,name\r\n");
    assert_eq!(export(data_opts(empty(), DataFormat::Json, &dir.path().join("e.json"))).await, "[]\n");
    assert_eq!(export(data_opts(empty(), DataFormat::Sql, &dir.path().join("e.sql"))).await, "");

    // SQL INSERTs (default table name = source table) load into a copy.
    let sql = export(data_opts(customers(), DataFormat::Sql, &dir.path().join("c.sql"))).await;
    assert!(sql.starts_with("INSERT INTO \"customers\" (\"id\", \"name\", \"note\") VALUES\n"), "{sql}");
    let copy = sql.replace("INSERT INTO \"customers\"", "INSERT INTO \"customers_copy\"");
    run_script(&mgr, &src, &c, &format!("CREATE TABLE customers_copy (id INTEGER PRIMARY KEY, name TEXT, note TEXT);\n{copy}")).await;
    let q = |t: &str| format!("SELECT * FROM {t} ORDER BY id");
    assert_eq!(rows(&mgr, &src, &c, &q("customers")).await, rows(&mgr, &src, &c, &q("customers_copy")).await);
    // Query source without a table name → `export`.
    let sql = export(data_opts(DataSource::Query { sql: "SELECT 1 AS x".into() }, DataFormat::Sql, &dir.path().join("q.sql"))).await;
    assert_eq!(sql, "INSERT INTO \"export\" (\"x\") VALUES\n(1);\n");

    // Refused: write query, bad delimiter.
    let (ctx, _) = JobCtx::for_test();
    let done = export_data(&src, &c, &data_opts(DataSource::Query { sql: "UPDATE log SET msg = 'x'".into() }, DataFormat::Csv, &dir.path().join("w.csv")), &ctx).await;
    assert!(!done.ok && done.message == "Only read queries can be exported");
    let done = export_data(&src, &c, &ExportDataOptions { delimiter: Some(";;".into()), ..data_opts(customers(), DataFormat::Csv, &dir.path().join("d.csv")) }, &ctx).await;
    assert!(!done.ok && !dir.path().join("d.csv").exists());
}
