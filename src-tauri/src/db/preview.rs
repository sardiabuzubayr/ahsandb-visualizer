//! Review-then-apply: generators produce a `Plan`, the user sees it as a `Preview`, and only
//! `apply` runs it — exactly the stored statements, never re-generated.
use sqlx::mysql::MySql;
use sqlx::postgres::Postgres;
use sqlx::sqlite::Sqlite;
use sqlx::Executor as _;

use super::value::Dialect;
use super::{Manager, Pool};
use crate::error::{AppError, AppResult};
use crate::model::{ApplyFailure, ApplyReport, Connection, Env, Preview};

/// SQLite table rebuilds switch FK enforcement off around the transaction (the pragma is a no-op
/// inside one, and `DROP TABLE` with enforcement on would fire ON DELETE actions on child rows).
/// A plan starting with `FK_OFF` gets it run before BEGIN; a trailing `FK_ON` runs after COMMIT, and
/// enforcement is restored even when the apply fails.
pub(crate) const FK_OFF: &str = "PRAGMA foreign_keys = OFF";
pub(crate) const FK_ON: &str = "PRAGMA foreign_keys = ON";
/// SQLite `PRAGMA foreign_key_check(…)` reports violations as rows; `apply` treats any row as a failure.
pub(crate) const FK_CHECK: &str = "PRAGMA foreign_key_check";

#[derive(Debug, Clone, PartialEq)]
pub struct PlannedStatement {
    /// SQL that runs.
    pub sql: String,
    /// SQL shown to the user (secrets masked). Usually equal to `sql`.
    pub display: String,
    /// Data edits: the statement must affect exactly this many rows or the whole apply rolls back.
    pub expect_rows: Option<u64>,
}

impl PlannedStatement {
    pub fn new(sql: impl Into<String>) -> Self {
        let sql = sql.into();
        Self { display: sql.clone(), sql, expect_rows: None }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Plan {
    pub statements: Vec<PlannedStatement>,
    /// Run inside one transaction (all-or-nothing).
    pub transactional: bool,
    pub destructive: bool,
    pub warnings: Vec<String>,
}

/// Stored server-side until applied or replaced; keyed by preview id.
#[derive(Debug, Clone)]
pub struct StoredPreview {
    pub conn_id: String,
    pub plan: Plan,
}

/// Saves the plan for `conn_id` and returns what the UI shows. Rejects an empty plan with
/// `AppError::Query("Nothing to apply")`.
pub async fn store(mgr: &Manager, conn_id: &str, plan: Plan) -> AppResult<Preview> {
    if plan.statements.is_empty() {
        return Err(AppError::Query("Nothing to apply".into()));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let preview = Preview {
        id: id.clone(),
        statements: plan.statements.iter().map(|s| s.display.clone()).collect(),
        transactional: plan.transactional,
        destructive: plan.destructive,
        warnings: plan.warnings.clone(),
    };
    // shortcut: previews that are never applied stay in memory until the app quits; fine for a desktop
    // session, prune per connection if it ever matters.
    mgr.previews.lock().await.insert(id, StoredPreview { conn_id: conn_id.to_string(), plan });
    Ok(preview)
}

/// Runs a stored preview on `conn` (must match its `conn_id`; unknown id → `NotFound`).
/// Read-only connection → `ReadOnly`; production without `confirmed` → `NeedsConfirmation(display
/// statements)`. Transactional plans run in one transaction and roll back on the first error or on
/// an `expect_rows` mismatch; non-transactional plans stop at the first error (earlier statements
/// stay applied — the report says how many). The preview is removed after a successful apply.
pub async fn apply(mgr: &Manager, pool: &Pool, conn: &Connection, preview_id: &str, confirmed: bool) -> AppResult<ApplyReport> {
    // Taken out while running so a double click can't apply it twice; put back unless it succeeded.
    let stored = {
        let mut previews = mgr.previews.lock().await;
        match previews.get(preview_id) {
            Some(p) if p.conn_id == conn.id => previews.remove(preview_id),
            _ => None,
        }
    };
    let Some(stored) = stored else {
        return Err(AppError::NotFound("Preview expired — review the SQL again".into()));
    };
    let shown = || stored.plan.statements.iter().map(|s| s.display.clone()).collect::<Vec<_>>();
    let blocked = if conn.read_only {
        Some(AppError::ReadOnly(shown()))
    } else if conn.env == Env::Prod && !confirmed {
        Some(AppError::NeedsConfirmation(shown()))
    } else {
        None
    };
    let result = match blocked {
        Some(e) => Err(e),
        None => match pool {
            Pool::Pg(p) => match p.acquire().await {
                Ok(mut c) => Ok(pg::run(&mut c, &stored.plan).await),
                Err(e) => Err(e.into()),
            },
            Pool::My(p) => match p.acquire().await {
                Ok(mut c) => Ok(my::run(&mut c, &stored.plan).await),
                Err(e) => Err(e.into()),
            },
            Pool::Lite(p) => match p.acquire().await {
                Ok(mut c) => Ok(lite::run(&mut c, &stored.plan).await),
                Err(e) => Err(e.into()),
            },
        },
    };
    if !matches!(&result, Ok(r) if r.failed.is_none()) {
        mgr.previews.lock().await.insert(preview_id.to_string(), stored);
    }
    result
}

// Concrete per-driver copies: a generic version over `for<'c> &'c mut DB::Connection: Executor` trips
// rustc's "Send is not general enough" inside the Tauri command futures.
macro_rules! runner {
    ($m:ident, $conn:ty, $db:ty) => {
        mod $m {
            use super::*;

            /// Runs the plan on one connection. Never returns early with the connection inside a transaction.
            pub(super) async fn run(c: &mut $conn, plan: &Plan) -> ApplyReport {
                let stmts = &plan.statements;
                let pre = usize::from(stmts.first().is_some_and(|s| s.sql == FK_OFF));
                let post = usize::from(pre == 1 && stmts.len() > 1 && stmts.last().is_some_and(|s| s.sql == FK_ON));
                let fail = |index: usize, message: String, rolled_back: bool| ApplyReport {
                    executed: index,
                    failed: Some(ApplyFailure { index, message }),
                    rolled_back,
                };
                if pre == 1
                    && let Err(e) = (&mut *c).execute(sqlx::raw_sql(FK_OFF)).await
                {
                    return fail(0, message(&e), false);
                }
                let body = pre..stmts.len() - post;
                let mut report = match begin_run_commit(c, plan, body.clone()).await {
                    Ok(()) => ApplyReport { executed: body.end, failed: None, rolled_back: false },
                    Err((index, msg)) => fail(index, msg, plan.transactional),
                };
                if pre == 1 {
                    // Restore enforcement whatever happened; a failure here only matters when it was the plan's own step.
                    let restored = (&mut *c).execute(sqlx::raw_sql(FK_ON)).await;
                    if post == 1 && report.failed.is_none() {
                        match restored {
                            Ok(_) => report.executed = stmts.len(),
                            Err(e) => report = fail(stmts.len() - 1, message(&e), false),
                        }
                    }
                }
                report
            }

            /// BEGIN (when transactional), each statement of `range`, COMMIT; on failure ROLLBACK and return
            /// `(index, message)`.
            async fn begin_run_commit(c: &mut $conn, plan: &Plan, range: std::ops::Range<usize>) -> Result<(), (usize, String)> {
                let tx = plan.transactional;
                if tx {
                    (&mut *c).execute(sqlx::raw_sql("BEGIN")).await.map_err(|e| (range.start, message(&e)))?;
                }
                let last = range.end.saturating_sub(1);
                let mut outcome = Ok(());
                for i in range {
                    if let Err(m) = step(c, &plan.statements[i]).await {
                        outcome = Err((i, m));
                        break;
                    }
                }
                if tx {
                    match outcome {
                        Ok(()) => {
                            if let Err(e) = (&mut *c).execute(sqlx::raw_sql("COMMIT")).await {
                                let _ = (&mut *c).execute(sqlx::raw_sql("ROLLBACK")).await;
                                return Err((last, format!("COMMIT failed: {}", message(&e))));
                            }
                        }
                        Err(_) => {
                            let _ = (&mut *c).execute(sqlx::raw_sql("ROLLBACK")).await;
                        }
                    }
                }
                outcome
            }

            async fn step(c: &mut $conn, s: &PlannedStatement) -> Result<(), String> {
                if s.sql.starts_with(FK_CHECK) {
                    let rows = (&mut *c).fetch_all(sqlx::raw_sql(&s.sql)).await.map_err(|e| message(&e))?;
                    return match rows.first() {
                        None => Ok(()),
                        Some(r) => {
                            // Columns: table, rowid, parent, fkid.
                            let cells = <$db as Dialect>::cells(r);
                            let cell = |i: usize| cells.get(i).map(|v| v.to_string().trim_matches('"').to_string()).unwrap_or_default();
                            Err(format!(
                                "Foreign key check failed: {} row(s) violate constraints (e.g. {} rowid {} → {})",
                                rows.len(),
                                cell(0),
                                cell(1),
                                cell(2)
                            ))
                        }
                    };
                }
                let done = (&mut *c).execute(sqlx::raw_sql(&s.sql)).await.map_err(|e| message(&e))?;
                if let Some(want) = s.expect_rows {
                    let got = <$db as Dialect>::affected(&done);
                    if got != want {
                        let why = if got < want { "the row changed or was deleted" } else { "the key matches more than one row" };
                        return Err(format!("Expected {want} row{}, got {got} — {why}", if want == 1 { "" } else { "s" }));
                    }
                }
                Ok(())
            }
        }
    };
}
runner!(pg, sqlx::PgConnection, Postgres);
runner!(my, sqlx::MySqlConnection, MySql);
runner!(lite, sqlx::SqliteConnection, Sqlite);

fn message(e: &sqlx::Error) -> String {
    match e {
        sqlx::Error::Database(db) => db.message().to_string(),
        _ => e.to_string(),
    }
}
