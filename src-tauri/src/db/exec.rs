//! Runs editor scripts statement by statement.
use std::time::Instant;

use futures::StreamExt;
use sqlx::mysql::{MySql, MySqlDatabaseError};
use sqlx::postgres::{PgDatabaseError, PgErrorPosition, Postgres};
use sqlx::sqlite::Sqlite;
use sqlx::{Either, Executor, Row};

use super::value::{Dialect, columns};
use super::{Manager, Pool, Running};
use crate::error::{AppError, AppResult};
use crate::model::{Connection, Env, StatementError, StatementResult};
use crate::sql::classify::{StatementClass, classify};
use crate::sql::split::split;

/// Splits `sql`, enforces read-only (`ReadOnly`) and production confirmation (`NeedsConfirmation`)
/// before running anything, then runs each statement on one pooled connection. Stops at the first
/// failing statement (its result carries `error`). Registers `run_id` for `cancel`.
pub async fn execute(
    mgr: &Manager,
    pool: &Pool,
    conn: &Connection,
    sql: &str,
    confirmed: bool,
    max_rows: u32,
    run_id: &str,
) -> AppResult<Vec<StatementResult>> {
    let stmts = split(sql, conn.driver);
    let writes: Vec<String> = stmts.iter().filter(|s| classify(s) == StatementClass::Write).cloned().collect();
    if !writes.is_empty() {
        if conn.read_only {
            return Err(AppError::ReadOnly(writes));
        }
        if conn.env == Env::Prod && !confirmed {
            return Err(AppError::NeedsConfirmation(writes));
        }
    }
    if stmts.is_empty() {
        return Ok(vec![]);
    }
    let register = |server_id| async move {
        let run = Running { conn_id: conn.id.clone(), server_id };
        mgr.running.lock().await.insert(run_id.to_string(), run);
    };
    let results = match pool {
        Pool::Pg(p) => {
            let mut c = p.acquire().await?;
            let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut *c).await?;
            register(Some(pid.into())).await;
            run_all::<Postgres>(&mut *c, &stmts, max_rows).await
        }
        Pool::My(p) => {
            let mut c = p.acquire().await?;
            let id: i64 = sqlx::query_scalar("SELECT CAST(CONNECTION_ID() AS SIGNED)").fetch_one(&mut *c).await?;
            register(Some(id)).await;
            run_all::<MySql>(&mut *c, &stmts, max_rows).await
        }
        Pool::Lite(p) => {
            let mut c = p.acquire().await?;
            register(None).await;
            run_all::<Sqlite>(&mut *c, &stmts, max_rows).await
        }
    };
    mgr.running.lock().await.remove(run_id);
    Ok(results)
}

async fn run_all<DB: Dialect>(c: &mut DB::Connection, stmts: &[String], max_rows: u32) -> Vec<StatementResult>
where
    for<'c> &'c mut DB::Connection: Executor<'c, Database = DB>,
{
    let mut out = Vec::new();
    for stmt in stmts {
        let started = Instant::now();
        let mut r = StatementResult {
            sql: stmt.clone(),
            columns: vec![],
            rows: vec![],
            elapsed_ms: 0,
            affected: None,
            truncated: false,
            error: None,
        };
        let mut affected = 0;
        {
            let mut stream = sqlx::raw_sql(stmt).fetch_many(&mut *c);
            while let Some(item) = stream.next().await {
                match item {
                    Ok(Either::Left(done)) => affected += DB::affected(&done),
                    Ok(Either::Right(row)) => {
                        if r.columns.is_empty() {
                            r.columns = columns(row.columns());
                        }
                        if r.rows.len() >= max_rows as usize {
                            // Dropping the stream mid-result is fine: sqlx drains it before the next query.
                            r.truncated = true;
                            break;
                        }
                        r.rows.push(DB::cells(&row));
                    }
                    Err(e) => {
                        r.error = Some(statement_error(&e));
                        break;
                    }
                }
            }
        }
        if r.error.is_none()
            && r.columns.is_empty()
            && classify(stmt) == StatementClass::Read
            && let Ok(d) = (&mut *c).describe(stmt).await
        {
            r.columns = columns(d.columns());
        }
        if r.columns.is_empty() && r.error.is_none() {
            r.affected = Some(affected);
        }
        r.elapsed_ms = started.elapsed().as_millis() as u64;
        let failed = r.error.is_some();
        out.push(r);
        if failed {
            break;
        }
    }
    out
}

fn statement_error(e: &sqlx::Error) -> StatementError {
    let sqlx::Error::Database(db) = e else {
        return StatementError { message: e.to_string(), position: None, code: None };
    };
    let code = db.code().map(|c| c.into_owned());
    // 57014 = PostgreSQL query_canceled; 1317 = MySQL/MariaDB "Query execution was interrupted".
    let cancelled = code.as_deref() == Some("57014")
        || db.try_downcast_ref::<MySqlDatabaseError>().is_some_and(|m| m.number() == 1317);
    let position = db.try_downcast_ref::<PgDatabaseError>().and_then(|p| match p.position() {
        Some(PgErrorPosition::Original(n)) => u32::try_from(n).ok(),
        _ => None,
    });
    let message = if cancelled { "Query cancelled".to_string() } else { db.message().to_string() };
    StatementError { message, position, code }
}

/// Cancels a running query. PostgreSQL: pg_cancel_backend; MySQL/MariaDB: KILL QUERY.
pub async fn cancel(mgr: &Manager, run_id: &str) -> AppResult<()> {
    let Some(run) = mgr.running.lock().await.get(run_id).cloned() else {
        return Ok(()); // already finished
    };
    // A scoped id (`<conn>@<db>`) on the base database runs on the main pool, stored under the bare id.
    let pool = match mgr.pool(&run.conn_id).await {
        Ok(p) => p,
        Err(_) => mgr.pool(run.conn_id.split('@').next().unwrap_or_default()).await?,
    };
    match (&*pool, run.server_id) {
        (Pool::Pg(p), Some(pid)) => {
            sqlx::query("SELECT pg_cancel_backend($1)").bind(pid as i32).execute(p).await?;
        }
        (Pool::My(p), Some(id)) => {
            p.execute(format!("KILL QUERY {id}").as_str()).await?;
        }
        // shortcut: SQLite has no server to signal; upgrade via sqlite3_interrupt on the running
        // connection's raw handle once per-tab sessions exist.
        _ => return Err(AppError::NotSupported("Cancel isn't available for SQLite yet".into())),
    }
    Ok(())
}
