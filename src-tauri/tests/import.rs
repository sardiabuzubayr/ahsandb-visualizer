//! SQL script and CSV/JSON import. SQLite always runs; PostgreSQL / MariaDB only when
//! AHSANDB_TEST_PG / AHSANDB_TEST_MYSQL are set. They write to a temp schema / database, dropped afterwards.
mod common;

use std::io::Write as _;

use ahsandb_lib::db::{self, Manager, Pool};
use ahsandb_lib::model::*;
use ahsandb_lib::transfer::{JobCtx, import};
use common::*;

#[tokio::test]
async fn postgres_import() {
    let Some(c) = from_env("AHSANDB_TEST_PG", Driver::Postgres) else { return };
    let tmp = format!("ahsandb_t_{}", rand_suffix());
    let (mgr, admin) = open(&c).await;
    rows(&mgr, &admin, &c, &format!("CREATE SCHEMA {tmp}")).await;
    // The body runs in its own task so a failed assertion still reaches the cleanup below.
    let outcome = tokio::spawn(body(c.clone(), tmp.clone())).await;
    rows(&mgr, &admin, &c, &format!("DROP SCHEMA IF EXISTS {tmp} CASCADE")).await;
    if let Err(e) = outcome {
        std::panic::resume_unwind(e.into_panic());
    }
}

#[tokio::test]
async fn mariadb_import() {
    let Some(c) = from_env("AHSANDB_TEST_MYSQL", Driver::Mariadb) else { return };
    let tmp = format!("ahsandb_t_{}", rand_suffix());
    let (mgr, admin) = open(&c).await;
    rows(&mgr, &admin, &c, &format!("CREATE DATABASE {tmp}")).await;
    let scoped = Connection { database: Some(tmp.clone()), ..c.clone() };
    let outcome = tokio::spawn(body(scoped, tmp.clone())).await;
    rows(&mgr, &admin, &c, &format!("DROP DATABASE IF EXISTS {tmp}")).await;
    if let Err(e) = outcome {
        std::panic::resume_unwind(e.into_panic());
    }
}

#[tokio::test]
async fn sqlite_import() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("import.db");
    db::create_sqlite_file(path.to_str().unwrap()).await.unwrap();
    let c = Connection { file: Some(path.to_string_lossy().into()), ..conn(Driver::Sqlite) };
    body(c, "main".into()).await;
}

/// Files much bigger than the 256 KiB read chunk stream through: a 50k-statement script (plain and
/// gzipped) and 100k CSV rows whose quoted line breaks straddle chunk boundaries.
#[tokio::test]
async fn sqlite_large_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large.db");
    db::create_sqlite_file(path.to_str().unwrap()).await.unwrap();
    let c = Connection { file: Some(path.to_string_lossy().into()), ..conn(Driver::Sqlite) };
    let (mgr, pool) = open(&c).await;
    let t = T { c, mgr, pool, schema: "main".into(), dir: tempfile::tempdir().unwrap() };

    let script = |name: &str| {
        let mut s = format!("CREATE TABLE {name} (id integer PRIMARY KEY, note text);\nBEGIN;\n");
        for i in 0..50_000 {
            s += &format!("INSERT INTO {name} VALUES ({i}, 'row {i}; it''s -- not a comment');\n");
        }
        s + "COMMIT;\n"
    };
    let plain = script("t_many");
    assert!(plain.len() > 3_000_000);
    let d = t.import_sql(&t.file("many.sql", plain.as_bytes()), OnError::Stop).await;
    assert!(d.ok && d.succeeded == 50_003 && d.message == "50003 of 50003 statements ran, 0 failed", "{d:?}");
    assert_eq!(t.count("t_many").await, 50_000);
    let r = t.sql("SELECT note FROM t_many WHERE id = 49999").await;
    assert_eq!(text(&r[0][0]), "row 49999; it's -- not a comment");

    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(script("t_many_gz").as_bytes()).unwrap();
    let d = t.import_sql(&t.file("many.sql.gz", &gz.finish().unwrap()), OnError::Stop).await;
    assert!(d.ok && d.succeeded == 50_003, "{d:?}");
    assert_eq!(t.count("t_many_gz").await, 50_000);

    let mut body = String::from("\u{feff}id,name,note\r\n");
    for i in 1..=100_000 {
        body += &format!("{i},name {i},\"line one\r\nline two, \"\"{i}\"\"\"\r\n");
    }
    let f = csv(&t.file("rows.csv", body.as_bytes()), true, ",", "UTF-8");
    let p = import::inspect_file(&t.c, &f).await.unwrap();
    assert_eq!((p.total_rows, p.rows.len()), (100_000, 20));
    assert_eq!(p.columns, ["id", "name", "note"]);
    assert_eq!(p.types, ["INTEGER", "TEXT", "TEXT"]);
    assert_eq!(text(&p.rows[19][2]), "line one\r\nline two, \"20\"");

    t.sql("CREATE TABLE t_rows (id integer, name text, note text)").await;
    let d = t.import_data(&t.opts(f, "t_rows", &["id", "name", "note"], OnError::Stop)).await;
    assert!(d.ok && d.succeeded == 100_000, "{d:?}");
    let r = t.sql("SELECT COUNT(DISTINCT id), MIN(id), MAX(id) FROM t_rows").await;
    assert_eq!(r[0].iter().map(|v| v.to_string()).collect::<Vec<_>>(), ["100000", "1", "100000"]);
    let r = t.sql("SELECT name, note FROM t_rows WHERE id = 54321").await;
    assert_eq!((text(&r[0][0]), text(&r[0][1])), ("name 54321", "line one\r\nline two, \"54321\""));

    // A bad byte past the first chunk, after batches went in: Stop rolls all of them back.
    let mut bad: Vec<u8> = (1..=30_000).flat_map(|i| format!("{i},n,x\n").into_bytes()).collect();
    bad.extend(b"0,\xff,x\n");
    assert!(bad.len() > 256 * 1024);
    let f = csv(&t.file("bad.csv", &bad), false, ",", "UTF-8");
    let d = t.import_data(&t.opts(f, "t_rows", &["id", "name", "note"], OnError::Stop)).await;
    assert!(!d.ok && d.message.contains("not valid UTF-8 (line 30001); nothing was imported"), "{d:?}");
    assert_eq!(t.count("t_rows").await, 100_000);
}

struct T {
    c: Connection,
    mgr: Manager,
    pool: std::sync::Arc<Pool>,
    schema: String,
    dir: tempfile::TempDir,
}

impl T {
    fn table(&self, t: &str) -> String {
        if self.c.driver == Driver::Sqlite { t.to_string() } else { format!("{}.{t}", self.schema) }
    }

    async fn sql(&self, sql: &str) -> Vec<Vec<Cell>> {
        rows(&self.mgr, &self.pool, &self.c, sql).await
    }

    async fn count(&self, t: &str) -> i64 {
        let r = self.sql(&format!("SELECT COUNT(*) FROM {}", self.table(t))).await;
        let v = &r[0][0];
        v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).expect("count")
    }

    fn file(&self, name: &str, bytes: &[u8]) -> String {
        let p = self.dir.path().join(name);
        std::fs::write(&p, bytes).unwrap();
        p.to_string_lossy().into()
    }

    async fn import_sql(&self, path: &str, on_error: OnError) -> JobDone {
        let (ctx, seen) = JobCtx::for_test();
        let done = import::import_sql(&self.pool, &self.c, &ImportSqlOptions { path: path.into(), on_error }, &ctx).await;
        let last = seen.lock().unwrap().last().cloned().expect("progress");
        // Progress counts file bytes; small scripts are read in one go, big ones to the end when ok.
        if done.ok || last.total.is_some_and(|t| t < 256 * 1024) {
            assert_eq!(Some(last.done), last.total, "{last:?}");
        }
        done
    }

    fn opts(&self, file: FileOptions, table: &str, targets: &[&str], on_error: OnError) -> ImportDataOptions {
        ImportDataOptions {
            file,
            schema: self.schema.clone(),
            table: table.into(),
            create: None,
            mapping: targets.iter().enumerate().map(|(source, t)| ColumnMapping { source, target: t.to_string() }).collect(),
            on_error,
            empty_as_null: true,
        }
    }

    async fn import_data(&self, o: &ImportDataOptions) -> JobDone {
        let (ctx, _) = JobCtx::for_test();
        import::import_data(&self.pool, &self.c, o, &ctx).await
    }
}

fn csv(path: &str, header: bool, delimiter: &str, encoding: &str) -> FileOptions {
    FileOptions { path: path.into(), format: FileFormat::Csv, delimiter: delimiter.into(), header, encoding: encoding.into() }
}

fn text(v: &Cell) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not text: {v}"))
}

async fn body(c: Connection, schema: String) {
    let (mgr, pool) = open(&c).await;
    let t = T { c, mgr, pool, schema, dir: tempfile::tempdir().unwrap() };
    sql_scripts(&t).await;
    csv_stop_and_skip(&t).await;
    batches(&t).await;
    json_new_table(&t).await;
    latin1(&t).await;
}

async fn sql_scripts(t: &T) {
    let pg = t.c.driver == Driver::Postgres;
    let pre = if pg { format!("SET search_path TO {};\n", t.schema) } else { String::new() };
    let p = u64::from(pg);
    let script = |name: &str| {
        format!(
            "{pre}CREATE TABLE {name} (id int PRIMARY KEY, name varchar(20));\n\
             INSERT INTO {name} VALUES (1, 'a');\n\
             INSERT INTO {name} VALUES (1, 'dup');\n\
             INSERT INTO {name} VALUES (2, 'b');\n"
        )
    };

    let d = t.import_sql(&t.file("stop.sql", script("t_stop").as_bytes()), OnError::Stop).await;
    assert!(!d.ok && !d.cancelled, "{d:?}");
    assert_eq!((d.succeeded, d.failed), (p + 2, 1), "{d:?}");
    assert_eq!(d.errors.len(), 1);
    assert_eq!(d.errors[0].index, p + 3);
    assert_eq!(t.count("t_stop").await, 1);

    let d = t.import_sql(&t.file("skip.sql", script("t_skip").as_bytes()), OnError::Skip).await;
    assert!(d.ok, "{d:?}");
    assert_eq!((d.succeeded, d.failed), (p + 3, 1));
    assert_eq!(d.errors[0].index, p + 3);
    assert_eq!(t.count("t_skip").await, 2);

    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(script("t_gz").as_bytes()).unwrap();
    let d = t.import_sql(&t.file("dump.sql.gz", &gz.finish().unwrap()), OnError::Skip).await;
    assert_eq!((d.succeeded, d.failed), (p + 3, 1), "{d:?}");
    assert_eq!(t.count("t_gz").await, 2);

    let (ctx, _) = JobCtx::for_test();
    let bad = ImportSqlOptions { path: t.file("bad.sql.gz", &[0x1f, 0x8b, 8, 0, 1, 2]), on_error: OnError::Skip };
    let d = import::import_sql(&t.pool, &t.c, &bad, &ctx).await;
    assert!(!d.ok && d.message.contains("gzip"), "{d:?}");
}

async fn csv_stop_and_skip(t: &T) {
    // STRICT: SQLite would otherwise store 'oops' in an int column.
    let strict = if t.c.driver == Driver::Sqlite { " STRICT" } else { "" };
    for name in ["t_csv_stop", "t_csv_skip"] {
        t.sql(&format!("CREATE TABLE {} (id int, name text, qty int){strict}", t.table(name))).await;
    }
    let file = t.file("rows.csv", b"\xef\xbb\xbfid,name,qty\r\n1,a,10\r\n2,b,20\r\n3,\"c, \"\"q\"\"\",30\r\n4,d,oops\r\n5,e,50\r\n6,,60\r\n");

    let preview = import::inspect_file(&t.c, &csv(&file, true, ",", "UTF-8")).await.unwrap();
    assert_eq!(preview.columns, ["id", "name", "qty"]);
    assert_eq!(preview.total_rows, 6);
    assert_eq!(preview.rows[2][1], "c, \"q\"");
    assert_eq!(preview.types[2].to_lowercase(), "text");

    let d = t.import_data(&t.opts(csv(&file, true, ",", "UTF-8"), "t_csv_stop", &["id", "name", "qty"], OnError::Stop)).await;
    assert!(!d.ok, "{d:?}");
    assert_eq!((d.succeeded, d.failed), (0, 1));
    assert_eq!(d.errors[0].index, 4, "{d:?}");
    assert!(d.message.starts_with("Row 4"), "{d:?}");
    assert_eq!(t.count("t_csv_stop").await, 0);

    let o = t.opts(csv(&file, true, ",", "UTF-8"), "t_csv_skip", &["id", "name", "qty"], OnError::Skip);
    let d = t.import_data(&o).await;
    assert!(d.ok, "{d:?}");
    assert_eq!((d.succeeded, d.failed), (5, 1));
    assert_eq!(d.errors.len(), 1);
    assert_eq!(d.errors[0].index, 4);
    assert_eq!(t.count("t_csv_skip").await, 5);
    let r = t.sql(&format!("SELECT name FROM {} WHERE id = 3", t.table("t_csv_skip"))).await;
    assert_eq!(text(&r[0][0]), "c, \"q\"");
    let r = t.sql(&format!("SELECT COUNT(*) FROM {} WHERE name IS NULL", t.table("t_csv_skip"))).await;
    assert_eq!(r[0][0].to_string().trim_matches('"'), "1");

    // Cancelled before the first batch: nothing written.
    let (ctx, _) = JobCtx::for_test();
    ctx.cancel_flag().store(true, std::sync::atomic::Ordering::Relaxed);
    let d = import::import_data(&t.pool, &t.c, &o, &ctx).await;
    assert!(d.cancelled && !d.ok && d.succeeded == 0, "{d:?}");
    assert_eq!(t.count("t_csv_skip").await, 5);
}

/// More rows than one batch: the bad row is found inside the second batch.
async fn batches(t: &T) {
    let strict = if t.c.driver == Driver::Sqlite { " STRICT" } else { "" };
    t.sql(&format!("CREATE TABLE {} (id int, qty int){strict}", t.table("t_big"))).await;
    let body: String = (1..=1200).map(|i| if i == 777 { format!("{i};x\n") } else { format!("{i};{i}\n") }).collect();
    let file = csv(&t.file("big.csv", body.as_bytes()), false, ";", "UTF-8");
    let d = t.import_data(&t.opts(file.clone(), "t_big", &["id", "qty"], OnError::Stop)).await;
    assert_eq!((d.ok, d.succeeded, d.failed), (false, 0, 1), "{d:?}");
    assert_eq!(d.errors[0].index, 777);
    assert_eq!(t.count("t_big").await, 0);
    let d = t.import_data(&t.opts(file, "t_big", &["id", "qty"], OnError::Skip)).await;
    assert_eq!((d.ok, d.succeeded, d.failed), (true, 1199, 1), "{d:?}");
    assert_eq!(d.errors[0].index, 777);
    assert_eq!(t.count("t_big").await, 1199);
}

async fn json_new_table(t: &T) {
    let file = t.file(
        "items.json",
        br#"[{"id": 1, "name": "x", "price": 1.5, "active": true, "meta": {"a": 1}, "day": "2024-01-02"},
            {"id": 2, "name": "y", "price": 2, "active": false, "meta": [1, 2], "day": "2024-02-03", "extra": "z"}]"#,
    );
    let f = FileOptions { path: file.clone(), format: FileFormat::Json, delimiter: ",".into(), header: false, encoding: "UTF-8".into() };
    let p = import::inspect_file(&t.c, &f).await.unwrap();
    assert_eq!(p.columns, ["id", "name", "price", "active", "meta", "day", "extra"]);
    assert_eq!(p.total_rows, 2);
    assert_eq!(p.rows[0][4], r#"{"a":1}"#);
    assert!(p.rows[0][6].is_null() && p.rows[1][6] == "z");
    let want: [&str; 7] = match t.c.driver {
        Driver::Postgres => ["bigint", "text", "numeric", "boolean", "text", "date", "text"],
        Driver::Sqlite => ["INTEGER", "TEXT", "REAL", "INTEGER", "TEXT", "TEXT", "TEXT"],
        _ => ["BIGINT", "TEXT", "DECIMAL(18,6)", "TINYINT(1)", "TEXT", "DATE", "TEXT"],
    };
    assert_eq!(p.types, want);

    let def = TableDef {
        schema: t.schema.clone(),
        name: "t_json".into(),
        columns: p
            .columns
            .iter()
            .zip(&p.types)
            .map(|(n, ty)| ColumnDef { name: n.clone(), original_name: None, type_name: ty.clone(), nullable: true, default: None, auto_increment: false })
            .collect(),
        primary_key: vec![],
        foreign_keys: vec![],
        indexes: vec![],
        checks: vec![],
    };
    let cols: Vec<&str> = p.columns.iter().map(String::as_str).collect();
    let o = ImportDataOptions { create: Some(def), ..t.opts(f, "t_json", &cols, OnError::Stop) };
    let d = t.import_data(&o).await;
    assert!(d.ok && d.succeeded == 2, "{d:?}");
    let r = t.sql(&format!("SELECT meta, extra FROM {} WHERE id = 1", t.table("t_json"))).await;
    assert_eq!(text(&r[0][0]), r#"{"a":1}"#);
    assert!(r[0][1].is_null());

    // The table exists now: the create fails and nothing is inserted.
    let d = t.import_data(&o).await;
    assert!(!d.ok && d.succeeded == 0 && d.message.starts_with("Could not create the table"), "{d:?}");
    assert_eq!(t.count("t_json").await, 2);
}

async fn latin1(t: &T) {
    t.sql(&format!("CREATE TABLE {} (id int, name text)", t.table("t_latin"))).await;
    let file = t.file("latin1.csv", b"id;name\n1;caf\xe9\n");
    let e = import::inspect_file(&t.c, &csv(&file, true, ";", "UTF-8")).await.unwrap_err();
    assert!(e.to_string().contains("line 2"), "{e}");
    let d = t.import_data(&t.opts(csv(&file, true, ";", "ISO-8859-1"), "t_latin", &["id", "name"], OnError::Stop)).await;
    assert!(d.ok, "{d:?}");
    let r = t.sql(&format!("SELECT name FROM {} WHERE id = 1", t.table("t_latin"))).await;
    assert_eq!(text(&r[0][0]), "café");
}
