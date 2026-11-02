pub mod databases;
pub mod roles;
pub mod routines;
pub mod triggers;
pub mod views;

use sqlx::Row;

use crate::db::Pool;
use crate::error::{AppError, AppResult};
use crate::model::{Cell, Driver};

const MY_DDL_WARNING: &str =
    "MySQL/MariaDB DDL is not transactional: statements that already ran stay applied if a later one fails.";

/// Separator for lists aggregated in catalog queries (names may contain commas).
const SEP: char = '\u{1f}';

/// Runs a catalog query; every column is read as text (NULL → ""), so queries cast in SQL.
// shortcut: copy of the private db::meta::text_rows; share it once db/ exposes one.
async fn text_rows(pool: &Pool, sql: &str, binds: &[&str]) -> AppResult<Vec<Vec<String>>> {
    macro_rules! run {
        ($p:expr) => {{
            let mut q = sqlx::query(sql);
            for b in binds {
                q = q.bind(*b);
            }
            q.fetch_all($p)
                .await?
                .iter()
                .map(|r| (0..r.len()).map(|i| r.try_get_unchecked::<Option<String>, _>(i).ok().flatten().unwrap_or_default()).collect())
                .collect()
        }};
    }
    Ok(match pool {
        Pool::Pg(p) => run!(p),
        Pool::My(p) => run!(p),
        Pool::Lite(p) => run!(p),
    })
}

fn split_list(s: &str) -> Vec<String> {
    if s.is_empty() { vec![] } else { s.split(SEP).map(str::to_string).collect() }
}

fn is_my(d: Driver) -> bool {
    matches!(d, Driver::Mysql | Driver::Mariadb)
}

/// Quoted identifier (`"x"` / `` `x` ``).
// shortcut: local twin of ddl::quote_ident (written concurrently by P4-DDL); switch once it lands.
fn q(d: Driver, ident: &str) -> String {
    if is_my(d) { format!("`{}`", ident.replace('`', "``")) } else { format!("\"{}\"", ident.replace('"', "\"\"")) }
}

/// Quoted string literal; MySQL/MariaDB also escape backslashes.
fn lit(d: Driver, s: &str) -> String {
    let s = if is_my(d) { s.replace('\\', "\\\\") } else { s.to_string() };
    format!("'{}'", s.replace('\'', "''"))
}

/// A grid/form value as a SQL literal.
fn cell_lit(d: Driver, c: &Cell) -> String {
    match c {
        Cell::Null => "NULL".into(),
        Cell::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        Cell::Number(n) => n.to_string(),
        Cell::String(s) => lit(d, s),
        other => lit(d, &other.to_string()),
    }
}

fn not_supported_sqlite<T>(what: &str) -> AppResult<T> {
    Err(AppError::NotSupported(format!("SQLite has no {what}")))
}

fn not_sql<T>() -> AppResult<T> {
    Err(AppError::NotSupported("Redis has no SQL objects".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn literals_per_dialect() {
        assert_eq!(cell_lit(Driver::Postgres, &json!("it's \\ ok")), r"'it''s \ ok'");
        assert_eq!(cell_lit(Driver::Mariadb, &json!("it's \\ ok")), r"'it''s \\ ok'");
        assert_eq!(cell_lit(Driver::Mysql, &json!("'; DROP TABLE x;--")), "'''; DROP TABLE x;--'");
        assert_eq!(cell_lit(Driver::Postgres, &json!(null)), "NULL");
        assert_eq!(cell_lit(Driver::Postgres, &json!(1.5)), "1.5");
        assert_eq!(cell_lit(Driver::Postgres, &json!(true)), "TRUE");
        assert_eq!(q(Driver::Mysql, "a`b"), "`a``b`");
        assert_eq!(q(Driver::Postgres, "a\"b"), "\"a\"\"b\"");
    }
}
