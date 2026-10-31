//! SQL script import and CSV/JSON data import. Files are streamed: a blocking reader thread parses
//! them and hands statements / row batches to the async side over a small bounded channel, so
//! memory stays around one statement or batch plus the read buffers, whatever the file size.
use serde_json::Value;
use sqlx::pool::PoolConnection;
use sqlx::{Executor as _, MySql, Postgres, Sqlite};
use tokio::sync::mpsc;

use super::JobCtx;
use super::parse::{self, CHUNK, TableReader, TextReader};
use crate::db::Pool;
use crate::ddl::{literal, plan_schema_changes, qualified, quote_ident};
use crate::error::{AppError, AppResult};
use crate::model::{
    Cell, Connection, Driver, FileOptions, FilePreview, ImportDataOptions, ImportSqlOptions, JobDone, JobError, OnError, TableChange,
};
use crate::sql::split::StatementStream;

const MAX_ERRORS: usize = 100;
const BATCH: usize = 500;

/// What the reader thread sends: a batch and the file bytes read so far, or a read error.
type Batch<T> = Result<(Vec<T>, u64), String>;

/// Runs a `.sql`/`.sql.gz` script statement by statement on one connection (session state such as
/// SET/USE/BEGIN carries over), split with `sql::split` for the driver while it is read. Progress =
/// file bytes read of the file size. Stop: halt at the first error. Skip: record it and continue.
pub async fn import_sql(pool: &Pool, conn: &Connection, opts: &ImportSqlOptions, ctx: &JobCtx) -> JobDone {
    let mut done = ctx.done();
    let total = tokio::fs::metadata(&opts.path).await.ok().map(|m| m.len());
    let (tx, mut rx) = mpsc::channel::<Batch<String>>(4);
    let (path, driver) = (opts.path.clone(), conn.driver);
    let reader = tokio::task::spawn_blocking(move || {
        if let Err(m) = read_statements(&path, driver, CHUNK, |stmts, pos| tx.blocking_send(Ok((stmts, pos))).is_ok()) {
            let _ = tx.blocking_send(Err(m));
        }
    });
    let mut c = match Conn::acquire(pool).await {
        Ok(c) => c,
        Err(e) => return JobDone { message: message(&e), ..done },
    };
    let (mut seen, mut pos) = (0u64, 0u64);
    let mut halted = false;
    'read: while let Some(batch) = rx.recv().await {
        let stmts = match batch {
            Ok((stmts, at)) => {
                pos = at;
                stmts
            }
            Err(m) => {
                (done.message, halted) = (m, true);
                break;
            }
        };
        for stmt in stmts {
            if ctx.cancelled() {
                done.cancelled = true;
                break 'read;
            }
            seen += 1;
            let head: String = stmt.chars().take(60).map(|ch| if ch.is_whitespace() { ' ' } else { ch }).collect();
            ctx.progress(pos, total, &head, false);
            match c.run(&stmt).await {
                Ok(()) => done.succeeded += 1,
                Err(e) => {
                    push_error(&mut done, seen, message(&e));
                    if opts.on_error == OnError::Stop || !is_db_error(&e) {
                        done.message = format!("Statement {seen}: {}", message(&e));
                        halted = true;
                        break 'read;
                    }
                }
            }
        }
    }
    drop(rx);
    if let (Err(e), false) = (reader.await, halted || done.cancelled) {
        (done.message, halted) = (format!("File reader failed: {e}"), true);
    }
    // Not returned to the pool: the script may have changed session state (SET, USE, open BEGIN).
    c.close().await;
    ctx.progress(pos, total, "", true);
    done.ok = !halted && !done.cancelled;
    if done.message.is_empty() {
        done.message = format!("{} of {seen} statements ran, {} failed", done.succeeded, done.failed);
    }
    done
}

/// Reads the script `chunk` bytes at a time (gunzipped when it starts with the gzip magic, UTF-8
/// with BOM stripped) and calls `emit(statements completed, file bytes read)` per chunk; `emit`
/// returning false stops reading.
fn read_statements(path: &str, driver: Driver, chunk: usize, mut emit: impl FnMut(Vec<String>, u64) -> bool) -> Result<(), String> {
    let mut r = TextReader::open(path, "UTF-8", true, chunk).map_err(|e| e.to_string())?;
    let mut split = StatementStream::new(driver);
    while let Some(text) = r.next_text().map_err(|e| e.to_string())? {
        if !emit(split.push(&text), r.pos()) {
            return Ok(());
        }
    }
    emit(split.finish(), r.pos());
    Ok(())
}

/// Reads the file's columns, first 20 rows, row count and a suggested SQL type per column, in one
/// pass that keeps only those.
pub async fn inspect_file(conn: &Connection, file: &FileOptions) -> AppResult<FilePreview> {
    let (file, driver) = (file.clone(), conn.driver);
    blocking(move || {
        let mut t = parse::open_table(&file)?;
        let mut infer = vec![parse::Infer::default(); t.columns.len()];
        let (mut rows, mut total_rows) = (Vec::new(), 0);
        for row in &mut t {
            let row = row?;
            infer.iter_mut().zip(&row).for_each(|(f, v)| _ = f.add(v));
            total_rows += 1;
            if rows.len() < 20 {
                rows.push(row);
            }
        }
        let types = infer.iter().map(|f| f.sql_type(driver)).collect();
        Ok(FilePreview { columns: t.columns, rows, total_rows, types })
    })
    .await
    .map_err(AppError::Internal)?
}

/// Why a data import stopped early.
enum Halt {
    Cancelled,
    /// Stop mode: a row (or its batch) was rejected.
    Row(JobError),
    /// Reading the file or the connection failed.
    Fatal(String),
}

/// Inserts the mapped file columns into `schema.table` (creating it first when `create` is set),
/// in batches as the file is read. Stop: one transaction, rolled back on the first bad row. Skip:
/// bad rows are skipped and reported by row number. Progress = file bytes read of the file size.
pub async fn import_data(pool: &Pool, conn: &Connection, opts: &ImportDataOptions, ctx: &JobCtx) -> JobDone {
    let fail = |message: String| JobDone { message, ..ctx.done() };
    let d = conn.driver;
    let file = opts.file.clone();
    let t = match blocking(move || parse::open_table(&file)).await.map_err(AppError::Internal).and_then(|r| r) {
        Ok(t) => t,
        Err(e) => return fail(e.to_string()),
    };
    if opts.mapping.is_empty() {
        return fail("No file columns are mapped to table columns".into());
    }
    if let Some(m) = opts.mapping.iter().find(|m| m.source >= t.columns.len()) {
        return fail(format!("File column {} doesn't exist (the file has {})", m.source + 1, t.columns.len()));
    }
    let target = qualified(d, &opts.schema, &opts.table);
    let cols: Vec<String> = opts.mapping.iter().map(|m| quote_ident(d, &m.target)).collect();
    let head = format!("INSERT INTO {target} ({}) VALUES ", cols.join(", "));
    let insert = |rows: &[Vec<Cell>]| -> String {
        let tuples = rows.iter().map(|r| {
            let vals: Vec<String> = opts.mapping.iter().map(|m| value(d, &r[m.source], opts.empty_as_null)).collect();
            format!("({})", vals.join(", "))
        });
        format!("{head}{}", tuples.collect::<Vec<_>>().join(", "))
    };

    let mut c = match Conn::acquire(pool).await {
        Ok(c) => c,
        Err(e) => return fail(message(&e)),
    };
    if let Some(def) = &opts.create
        && let Err(m) = create_table(&mut c, d, def).await
    {
        return fail(format!("Could not create the table: {m}"));
    }
    let stop = opts.on_error == OnError::Stop;
    if stop && let Err(e) = c.run("BEGIN").await {
        return fail(message(&e));
    }
    let total = tokio::fs::metadata(&opts.file.path).await.ok().map(|m| m.len());
    let (tx, mut rx) = mpsc::channel::<Batch<Vec<Cell>>>(2);
    let reader = tokio::task::spawn_blocking(move || send_batches(t, &tx));
    let mut done = ctx.done();
    let (mut seen, mut pos) = (0usize, 0u64);
    let outcome: Result<(), Halt> = async {
        while let Some(batch) = rx.recv().await {
            let (rows, at) = batch.map_err(Halt::Fatal)?;
            if ctx.cancelled() {
                return Err(Halt::Cancelled);
            }
            ctx.progress(pos, total, &target, false);
            if stop {
                insert_all_or_nothing(&mut c, &insert, &rows, seen).await?;
            } else {
                insert_skipping(&mut c, &insert, &rows, seen, &mut done).await?;
            }
            (seen, pos) = (seen + rows.len(), at);
        }
        Ok(())
    }
    .await;
    drop(rx);
    // A reader that died early must not look like the end of the file.
    let outcome = match (outcome, reader.await) {
        (Ok(()), Err(e)) => Err(Halt::Fatal(format!("File reader failed: {e}"))),
        (o, _) => o,
    };

    if stop {
        let end = if outcome.is_ok() { "COMMIT" } else { "ROLLBACK" };
        let ended = c.run(end).await;
        match (outcome, ended) {
            (Ok(()), Ok(())) => (done.ok, done.succeeded) = (true, seen as u64),
            (Ok(()), Err(e)) => done.message = format!("COMMIT failed: {}", message(&e)),
            (Err(Halt::Cancelled), _) => (done.cancelled, done.message) = (true, "Cancelled; nothing was imported".into()),
            (Err(Halt::Row(err)), _) => {
                done.message = format!("Row {}: {}; nothing was imported", err.index, err.message);
                push_error(&mut done, err.index, err.message);
            }
            (Err(Halt::Fatal(m)), _) => done.message = format!("{m}; nothing was imported"),
        }
    } else {
        match outcome {
            Ok(()) => {}
            Err(Halt::Cancelled) => (done.cancelled, done.message) = (true, format!("Cancelled after importing {} rows", done.succeeded)),
            Err(Halt::Row(err)) => done.message = err.message,
            Err(Halt::Fatal(m)) => done.message = m,
        }
        done.ok = done.message.is_empty();
    }
    ctx.progress(pos, total, &target, true);
    if done.ok {
        done.message = format!("Imported {} rows into {target}{}", done.succeeded, if done.failed > 0 { format!(", skipped {}", done.failed) } else { String::new() });
    }
    done
}

/// Reader thread: the file's rows in batches of `BATCH`, then the channel closes.
fn send_batches(mut rows: TableReader, tx: &mpsc::Sender<Batch<Vec<Cell>>>) {
    let mut batch = Vec::with_capacity(BATCH);
    loop {
        match rows.next() {
            Some(Ok(row)) => {
                batch.push(row);
                if batch.len() < BATCH {
                    continue;
                }
            }
            Some(Err(e)) => {
                let _ = tx.blocking_send(Err(e.to_string()));
                return;
            }
            None if batch.is_empty() => return,
            None => {}
        }
        if tx.blocking_send(Ok((std::mem::take(&mut batch), rows.pos()))).is_err() {
            return;
        }
    }
}

type Insert<'a> = dyn Fn(&[Vec<Cell>]) -> String + Sync + 'a;

/// Stop mode, inside the caller's transaction: the batch under a savepoint; a failing batch is
/// retried row by row to name the bad row. `first` = 0-based file row of `rows[0]`.
async fn insert_all_or_nothing(c: &mut Conn, insert: &Insert<'_>, rows: &[Vec<Cell>], first: usize) -> Result<(), Halt> {
    let err = |index: usize, e: sqlx::Error| Halt::Row(JobError { index: index as u64 + 1, message: message(&e) });
    c.run("SAVEPOINT ahsandb_batch").await.map_err(|e| err(first, e))?;
    match c.run(&insert(rows)).await {
        Ok(()) => c.run("RELEASE SAVEPOINT ahsandb_batch").await.map_err(|e| err(first, e)),
        Err(e) if !is_db_error(&e) => Err(err(first, e)),
        Err(batch) => {
            c.run("ROLLBACK TO SAVEPOINT ahsandb_batch").await.map_err(|e| err(first, e))?;
            for (i, row) in rows.iter().enumerate() {
                c.run(&insert(std::slice::from_ref(row))).await.map_err(|e| err(first + i, e))?;
            }
            // Every row went in alone: the batch failed as a whole (e.g. packet too large).
            Err(err(first, batch))
        }
    }
}

/// Skip mode: the batch is one INSERT statement, so it commits (or fails) as a whole in
/// autocommit; a failing batch is retried row by row, skipping and recording the bad rows.
async fn insert_skipping(c: &mut Conn, insert: &Insert<'_>, rows: &[Vec<Cell>], first: usize, done: &mut JobDone) -> Result<(), Halt> {
    match c.run(&insert(rows)).await {
        Ok(()) => done.succeeded += rows.len() as u64,
        Err(e) if !is_db_error(&e) => return Err(Halt::Fatal(message(&e))),
        Err(_) => {
            for (i, row) in rows.iter().enumerate() {
                match c.run(&insert(std::slice::from_ref(row))).await {
                    Ok(()) => done.succeeded += 1,
                    Err(e) if !is_db_error(&e) => return Err(Halt::Fatal(message(&e))),
                    Err(e) => push_error(done, (first + i) as u64 + 1, message(&e)),
                }
            }
        }
    }
    Ok(())
}

/// Runs the CREATE plan for the "new table from file" path (in a transaction where the driver has DDL ones).
async fn create_table(c: &mut Conn, d: Driver, def: &crate::model::TableDef) -> Result<(), String> {
    let plan = plan_schema_changes(d, &[TableChange { original: None, target: Some(def.clone()) }]).map_err(|e| e.to_string())?;
    if plan.transactional {
        c.run("BEGIN").await.map_err(|e| message(&e))?;
    }
    for s in &plan.statements {
        if let Err(e) = c.run(&s.sql).await {
            if plan.transactional {
                let _ = c.run("ROLLBACK").await;
            }
            return Err(message(&e));
        }
    }
    if plan.transactional {
        c.run("COMMIT").await.map_err(|e| message(&e))?;
    }
    Ok(())
}

/// A file cell as a SQL literal: strings quoted (the database casts them), JSON numbers/bools as-is.
fn value(d: Driver, v: &Cell, empty_as_null: bool) -> String {
    match v {
        Value::String(s) if empty_as_null && s.is_empty() => "NULL".into(),
        v => literal(d, v),
    }
}

/// Runs file reading/parsing off the async runtime's worker threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| format!("File reader failed: {e}"))
}

fn push_error(done: &mut JobDone, index: u64, message: String) {
    done.failed += 1;
    if done.errors.len() < MAX_ERRORS {
        done.errors.push(JobError { index, message });
    }
}

/// A server-side error (bad statement/row); anything else (I/O, protocol) means the connection is gone.
fn is_db_error(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(_))
}

fn message(e: &sqlx::Error) -> String {
    match e {
        sqlx::Error::Database(db) => db.message().to_string(),
        _ => e.to_string(),
    }
}

/// One pooled connection of any driver. Concrete per-driver arms (no generic executor) keep the job
/// future `Send` (see `db::preview`).
enum Conn {
    Pg(PoolConnection<Postgres>),
    My(PoolConnection<MySql>),
    Lite(PoolConnection<Sqlite>),
}

impl Conn {
    async fn acquire(pool: &Pool) -> Result<Self, sqlx::Error> {
        Ok(match pool {
            Pool::Pg(p) => Conn::Pg(p.acquire().await?),
            Pool::My(p) => Conn::My(p.acquire().await?),
            Pool::Lite(p) => Conn::Lite(p.acquire().await?),
        })
    }

    async fn run(&mut self, sql: &str) -> Result<(), sqlx::Error> {
        let q = sqlx::raw_sql(sql);
        match self {
            Conn::Pg(c) => (&mut **c).execute(q).await.map(drop),
            Conn::My(c) => (&mut **c).execute(q).await.map(drop),
            Conn::Lite(c) => (&mut **c).execute(q).await.map(drop),
        }
    }

    /// Closes the connection instead of returning it to the pool.
    async fn close(self) {
        let _ = match self {
            Conn::Pg(c) => c.close().await,
            Conn::My(c) => c.close().await,
            Conn::Lite(c) => c.close().await,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    /// Writes `bytes` to a temp file and streams its statements `chunk` bytes at a time.
    fn statements(bytes: &[u8], chunk: usize) -> (Vec<String>, Result<(), String>) {
        let f = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(f.path(), bytes).unwrap();
        let mut got = Vec::new();
        let r = read_statements(&f.path().to_string_lossy(), Driver::Postgres, chunk, |s, _| {
            got.extend(s);
            true
        });
        (got, r)
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(bytes).unwrap();
        gz.finish().unwrap()
    }

    #[test]
    fn reads_plain_and_gzip_scripts() {
        let script = "\u{feff}SELECT 'é;'; SELECT $$a;\nb$$;\n-- end";
        let want = vec!["SELECT 'é;'".to_string(), "SELECT $$a;\nb$$".into()];
        for chunk in [1, 2, 3, 7, CHUNK] {
            assert_eq!(statements(script.as_bytes(), chunk), (want.clone(), Ok(())), "chunk {chunk}");
            assert_eq!(statements(&gzip(script.as_bytes()), chunk), (want.clone(), Ok(())), "gzip chunk {chunk}");
        }
        let (_, e) = statements(&[0x1f, 0x8b, 8, 0, 1, 2, 3], CHUNK);
        assert!(e.unwrap_err().starts_with("The file is not a valid gzip archive"));
        // Statements before a bad byte were already handed over.
        let (got, e) = statements(b"SELECT 1;\nSELECT '\xff';", 4);
        assert_eq!(got, ["SELECT 1"]);
        assert!(e.as_ref().unwrap_err().contains("not valid UTF-8 (line 2)"), "{e:?}");
        let e = read_statements("/nonexistent/x.sql", Driver::Sqlite, CHUNK, |_, _| true).unwrap_err();
        assert!(e.starts_with("Could not read /nonexistent/x.sql"), "{e}");
    }

    #[test]
    fn values() {
        assert_eq!(value(Driver::Postgres, &Value::String(String::new()), true), "NULL");
        assert_eq!(value(Driver::Postgres, &Value::String(String::new()), false), "''");
        assert_eq!(value(Driver::Mysql, &serde_json::json!("it's"), true), "'it''s'");
        assert_eq!(value(Driver::Postgres, &serde_json::json!(1.5), true), "1.5");
        assert_eq!(value(Driver::Sqlite, &serde_json::json!(true), true), "1");
        assert_eq!(value(Driver::Sqlite, &Value::Null, false), "NULL");
    }
}
