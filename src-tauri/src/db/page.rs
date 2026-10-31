//! Paged table browsing for the data viewer.
use sqlx::mysql::MySql;
use sqlx::postgres::Postgres;
use sqlx::sqlite::Sqlite;

use super::Pool;
use super::meta::table_columns;
use super::value::Dialect;
use crate::error::{AppError, AppResult};
use crate::model::{Driver, OrderBy, TablePage};
use crate::sql::{
    classify::{StatementClass, classify},
    split::split,
};

/// Quotes an identifier for the pool's dialect (`"…"` with `""`, MySQL `` `…` `` with ``` `` ```).
pub(crate) fn quote(pool: &Pool, ident: &str) -> String {
    match pool {
        Pool::My(_) => format!("`{}`", ident.replace('`', "``")),
        _ => format!("\"{}\"", ident.replace('"', "\"\"")),
    }
}

/// `SELECT * FROM schema.table [WHERE filter] [ORDER BY col] LIMIT/OFFSET` with quoted identifiers.
/// `order_by.column` must be an existing column (validated against metadata) — never interpolated unchecked.
/// `filter` is the user's own WHERE expression (data viewer filter / foreign-key jump); the whole query
/// must still be exactly one read statement, so `1=1; DROP …` or a write is refused.
pub async fn table_page(
    pool: &Pool,
    schema: &str,
    table: &str,
    order_by: Option<OrderBy>,
    filter: Option<&str>,
    offset: u64,
    limit: u32,
) -> AppResult<TablePage> {
    let columns = table_columns(pool, schema, table).await?;
    let from = match pool {
        Pool::Lite(_) if schema.is_empty() || schema == "main" => quote(pool, table),
        _ => format!("{}.{}", quote(pool, schema), quote(pool, table)),
    };
    let order = match &order_by {
        Some(o) if columns.iter().any(|c| c.name == o.column) => {
            format!(" ORDER BY {} {}", quote(pool, &o.column), if o.desc { "DESC" } else { "ASC" })
        }
        Some(o) => return Err(AppError::Query(format!("Unknown column: {}", o.column))),
        None => String::new(),
    };
    // LIMIT/OFFSET are typed integers, so formatting them is safe. The text protocol (raw_sql) keeps
    // cell encoding identical to the SQL editor's results.
    let filter = filter.map(str::trim).filter(|f| !f.is_empty());
    let filter_sql = filter.map(|f| format!(" WHERE ({f}\n)")).unwrap_or_default();
    let sql = format!("SELECT * FROM {from}{filter_sql}{order} LIMIT {} OFFSET {offset}", u64::from(limit) + 1);
    if filter.is_some() {
        let driver = match pool {
            Pool::Pg(_) => Driver::Postgres,
            Pool::My(_) => Driver::Mysql,
            Pool::Lite(_) => Driver::Sqlite,
        };
        let statements = split(&sql, driver);
        if statements.len() != 1 || classify(&statements[0]) != StatementClass::Read {
            return Err(AppError::Query("The filter must be a single condition (no ; or other statements)".into()));
        }
    }
    let mut rows: Vec<_> = match pool {
        Pool::Pg(p) => sqlx::raw_sql(&sql).fetch_all(p).await?.iter().map(Postgres::cells).collect(),
        Pool::My(p) => sqlx::raw_sql(&sql).fetch_all(p).await?.iter().map(MySql::cells).collect(),
        Pool::Lite(p) => sqlx::raw_sql(&sql).fetch_all(p).await?.iter().map(Sqlite::cells).collect(),
    };
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    Ok(TablePage { columns, rows, has_more })
}
