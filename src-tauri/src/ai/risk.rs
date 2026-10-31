//! Risk level of one SQL statement, decided by the app (never by the model), plus the facts shown on
//! critical approval cards (row counts, dependent objects, size), computed on the database.
use sqlx::Row;

use crate::db::Pool;
use crate::error::AppResult;
use crate::model::{Driver, RiskLevel};
use crate::sql::classify::{StatementClass, classify};
use crate::sql::split::{block_end, dollar_end, is_ident, line_end, skip_quoted, split};

pub const IRREVERSIBLE: &str = "Cannot be undone once it runs";
const NOT_COUNTED: &str = "Affected rows could not be counted";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Read,
    Insert,
    Update,
    Delete,
    Truncate,
    DropTable,
    DropDatabase,
    /// DROP of anything else (view, index, column via ALTER is `Alter`, PG schema…).
    Drop,
    Alter,
    Create,
    Comment,
    Grant,
    Revoke,
    Other,
}

/// A (possibly qualified) object name from the statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjName {
    /// As written in the SQL (quotes kept), safe to splice back into a query.
    pub sql: String,
    /// Unquoted; PostgreSQL folds unquoted names to lower case.
    pub schema: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assessment {
    pub level: RiskLevel,
    pub op: Op,
    /// Objects acted on (tables for DML/TRUNCATE/DROP TABLE, the database for DROP DATABASE).
    pub targets: Vec<ObjName>,
    /// DELETE/UPDATE rewritten to `SELECT count(*) FROM <table> [WHERE …]`; `None` if not rewritable.
    pub count_sql: Option<String>,
}

impl Assessment {
    /// Name the user types to confirm a critical action on production (`None` = no object found).
    pub fn target(&self) -> Option<String> {
        if self.targets.is_empty() {
            return None;
        }
        Some(self.targets.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(", "))
    }

    /// INSERT/UPDATE/DELETE report affected rows; DDL just "OK".
    pub fn is_dml(&self) -> bool {
        matches!(self.op, Op::Insert | Op::Update | Op::Delete)
    }
}

/// Assesses exactly one statement. Errors (sent back to the model as tool errors): empty SQL, more
/// than one statement, session statements.
pub fn assess(driver: Driver, sql: &str) -> Result<Assessment, String> {
    let stmts = split(sql, driver);
    let stmt = match stmts.as_slice() {
        [] => return Err("The SQL is empty".into()),
        [s] => s.as_str(),
        _ => return Err("Only one statement per call: send each statement in its own run_sql call".into()),
    };
    let session = || Err("Session statements (SET, USE, BEGIN, COMMIT…) are not allowed".to_string());
    let read = |op| Ok(Assessment { level: RiskLevel::Read, op, targets: vec![], count_sql: None });
    match classify(stmt) {
        StatementClass::Session => return session(),
        StatementClass::Read => return read(Op::Read),
        StatementClass::Write => {}
    }
    let t = lex(stmt, driver);
    let w = |i: usize| t.get(i).filter(|x| x.kind == Kind::Word).map_or("", |x| x.up.as_str());
    let top = |word: &str| t.iter().any(|x| x.depth == 0 && x.kind == Kind::Word && x.up == word);
    let a = |level, op, targets| Ok(Assessment { level, op, targets, count_sql: None });
    use RiskLevel::{Change, Critical};
    match w(0) {
        "SET" | "USE" | "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "END" => session(),
        "INSERT" => {
            let mut i = skip(&t, 1, &["LOW_PRIORITY", "DELAYED", "HIGH_PRIORITY", "IGNORE"]);
            // SQLite INSERT OR REPLACE deletes conflicting rows.
            let level = if w(i) == "OR" { Critical } else { Change };
            if w(i) == "OR" {
                i += 2;
            }
            let targets = if w(i) == "INTO" { names(&t, stmt, driver, i + 1, false) } else { vec![] };
            a(level, Op::Insert, targets)
        }
        "UPDATE" => {
            let i = after_modifiers(&t, 1);
            let level = if top("WHERE") { Change } else { Critical };
            let targets = names(&t, stmt, driver, i, false);
            Ok(Assessment { level, op: Op::Update, targets, count_sql: count_rewrite(&t, stmt) })
        }
        "DELETE" => {
            let from = t.iter().position(|x| x.depth == 0 && x.up == "FROM" && x.kind == Kind::Word);
            let targets = from.map(|f| names(&t, stmt, driver, f + 1, false)).unwrap_or_default();
            Ok(Assessment { level: Critical, op: Op::Delete, targets, count_sql: count_rewrite(&t, stmt) })
        }
        "TRUNCATE" => {
            let i = skip(&t, 1, &["TABLE"]);
            a(Critical, Op::Truncate, names(&t, stmt, driver, i, true))
        }
        "DROP" => {
            let i = skip(&t, 1, &["TEMPORARY", "MATERIALIZED", "FOREIGN", "UNIQUE"]);
            let op = match w(i) {
                "TABLE" => Op::DropTable,
                "DATABASE" => Op::DropDatabase,
                "SCHEMA" if driver != Driver::Postgres => Op::DropDatabase,
                _ => Op::Drop,
            };
            a(Critical, op, names(&t, stmt, driver, i + 1, true))
        }
        "ALTER" => {
            let i = skip(&t, 1, &["ONLINE", "IGNORE", "MATERIALIZED", "FOREIGN"]);
            let targets = names(&t, stmt, driver, i + 1, false);
            // Every top-level clause must add or rename; any DROP (or anything else) is critical.
            // Clause starts: the token after the object name and after each top-level comma.
            let (mut clauses, mut start) = (vec![], true);
            for x in t.iter().skip(targets_end(&t, i + 1)) {
                if start {
                    clauses.push(x.up.as_str());
                    start = false;
                }
                if x.depth == 0 && x.kind == Kind::Sym && x.up == "," {
                    start = true;
                }
            }
            let safe = !clauses.is_empty()
                && clauses.iter().all(|c| matches!(*c, "ADD" | "RENAME"))
                && !t.iter().any(|x| x.kind == Kind::Word && x.up == "DROP");
            a(if safe { Change } else { Critical }, Op::Alter, targets)
        }
        "CREATE" => {
            const KINDS: [&str; 16] = [
                "TABLE", "VIEW", "INDEX", "DATABASE", "SCHEMA", "FUNCTION", "PROCEDURE", "TRIGGER", "SEQUENCE", "TYPE",
                "EXTENSION", "ROLE", "USER", "EVENT", "DOMAIN", "MATERIALIZED",
            ];
            let k = t.iter().position(|x| x.depth == 0 && x.kind == Kind::Word && KINDS.contains(&x.up.as_str()));
            let targets = k.map(|k| names(&t, stmt, driver, skip(&t, k + 1, &["VIEW", "CONCURRENTLY"]), false)).unwrap_or_default();
            a(Change, Op::Create, targets)
        }
        "COMMENT" => a(Change, Op::Comment, vec![]),
        "GRANT" => a(Change, Op::Grant, vec![]),
        "REVOKE" => a(Critical, Op::Revoke, vec![]),
        // WITH … DELETE, REPLACE, MERGE, CALL, DO, VACUUM, SELECT … INTO, RENAME TABLE, LOAD DATA…
        _ => a(Critical, Op::Other, vec![]),
    }
}

/// Index after the object name list starting at `i` (skipping IF [NOT] EXISTS / ONLY).
fn targets_end(t: &[Tok], i: usize) -> usize {
    let mut j = skip(t, i, &["IF", "NOT", "EXISTS", "ONLY"]);
    if t.get(j).is_some_and(|x| matches!(x.kind, Kind::Word | Kind::Ident)) {
        j += 1;
        while t.get(j).is_some_and(|x| x.kind == Kind::Sym && x.up == ".") && t.get(j + 1).is_some() {
            j += 2;
        }
    }
    j
}

/// Index of the first token at/after `i` that isn't one of `words`.
fn skip(t: &[Tok], mut i: usize, words: &[&str]) -> usize {
    while t.get(i).is_some_and(|x| x.kind == Kind::Word && words.contains(&x.up.as_str())) {
        i += 1;
    }
    i
}

/// After UPDATE/DELETE: MySQL modifiers and SQLite `OR <conflict>`.
fn after_modifiers(t: &[Tok], i: usize) -> usize {
    let i = skip(t, i, &["LOW_PRIORITY", "QUICK", "IGNORE"]);
    if t.get(i).is_some_and(|x| x.kind == Kind::Word && x.up == "OR") { i + 2 } else { i }
}

/// Object names at `i` (after IF [NOT] EXISTS / ONLY / CONCURRENTLY); `list` = comma-separated names.
fn names(t: &[Tok], stmt: &str, driver: Driver, i: usize, list: bool) -> Vec<ObjName> {
    let mut i = skip(t, i, &["IF", "NOT", "EXISTS", "ONLY", "CONCURRENTLY"]);
    let mut out = vec![];
    while let Some(first) = t.get(i).filter(|x| matches!(x.kind, Kind::Word | Kind::Ident)) {
        let mut parts = vec![unquote(first, driver)];
        let mut end = first.end;
        i += 1;
        while t.get(i).is_some_and(|x| x.kind == Kind::Sym && x.up == ".")
            && let Some(p) = t.get(i + 1).filter(|x| matches!(x.kind, Kind::Word | Kind::Ident))
        {
            parts.push(unquote(p, driver));
            end = p.end;
            i += 2;
        }
        let name = parts.pop().unwrap_or_default();
        out.push(ObjName { sql: stmt[first.start..end].to_string(), schema: parts.pop(), name });
        if !(list && t.get(i).is_some_and(|x| x.kind == Kind::Sym && x.up == ",")) {
            break;
        }
        i += 1;
    }
    out
}

fn unquote(x: &Tok, driver: Driver) -> String {
    match x.kind {
        Kind::Ident => {
            let inner = &x.raw[1..x.raw.len().saturating_sub(1).max(1)];
            let q = &x.raw[..1];
            let close = if q == "[" { "]" } else { q };
            inner.replace(&format!("{close}{close}"), close)
        }
        _ if driver == Driver::Postgres => x.raw.to_lowercase(),
        _ => x.raw.to_string(),
    }
}

/// `DELETE FROM t [AS a] [WHERE …] [RETURNING …]` / `UPDATE t [AS a] SET … [WHERE …] [RETURNING …]`
/// → `SELECT count(*) FROM t [AS a] [WHERE …]`. Multi-table forms, ORDER BY/LIMIT, USING and
/// UPDATE … FROM aren't rewritten (the count would be wrong).
fn count_rewrite(t: &[Tok], stmt: &str) -> Option<String> {
    let top_word = |x: &Tok, w: &[&str]| x.depth == 0 && x.kind == Kind::Word && w.contains(&x.up.as_str());
    let i = after_modifiers(t, 1);
    let (table_start, table_end, rest) = if t[0].up == "DELETE" {
        t.get(i).filter(|x| top_word(x, &["FROM"]))?;
        let stop = t[i + 1..].iter().position(|x| top_word(x, &["WHERE", "RETURNING"])).map(|p| i + 1 + p);
        (i + 1, stop.unwrap_or(t.len()), stop)
    } else {
        let set = i + t[i..].iter().position(|x| top_word(x, &["SET"]))?;
        let where_ = t[set..].iter().position(|x| top_word(x, &["WHERE"])).map(|p| set + p);
        (i, set, where_)
    };
    let table = t.get(table_start..table_end)?;
    if table.is_empty() || table.iter().any(|x| (x.depth == 0 && x.kind == Kind::Sym && x.up == ",") || top_word(x, &["JOIN", "USING"])) {
        return None;
    }
    let scan_from = table_end;
    if t[scan_from..].iter().any(|x| top_word(x, &["ORDER", "LIMIT", "USING", "FROM", "JOIN"])) {
        return None;
    }
    let mut sql = format!("SELECT count(*) FROM {}", &stmt[table[0].start..table[table.len() - 1].end]);
    if let Some(w) = rest.filter(|&w| t[w].up == "WHERE") {
        let end = t[w..].iter().position(|x| top_word(x, &["RETURNING"])).map_or(t.len(), |p| w + p);
        sql += " ";
        sql += &stmt[t[w].start..t[end - 1].end];
    }
    (classify(&sql) == StatementClass::Read).then_some(sql)
}

// ---------- tokenizer ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Word,
    /// Quoted identifier ("x", `x`, [x]).
    Ident,
    Str,
    Sym,
}

#[derive(Debug, Clone)]
struct Tok<'a> {
    kind: Kind,
    /// Upper-cased words and symbols.
    up: String,
    raw: &'a str,
    start: usize,
    end: usize,
    /// Parenthesis depth (0 = top level).
    depth: i32,
}

/// Words, quoted identifiers, strings and one-char symbols with their paren depth; comments skipped.
/// MySQL `/*! … */` contents run on the server, so they are lexed as code.
fn lex(s: &str, driver: Driver) -> Vec<Tok<'_>> {
    let my = matches!(driver, Driver::Mysql | Driver::Mariadb);
    let pg = driver == Driver::Postgres;
    let b = s.as_bytes();
    let (mut out, mut i, mut depth) = (Vec::<Tok>::new(), 0, 0);
    while i < b.len() {
        let c = b[i];
        let (kind, end) = match c {
            b'\'' => {
                let e_string = pg && out.last().is_some_and(|t| t.end == i && t.up == "E");
                (Kind::Str, skip_quoted(b, i, c, my || e_string))
            }
            b'"' if my => (Kind::Str, skip_quoted(b, i, c, true)),
            b'"' => (Kind::Ident, skip_quoted(b, i, c, false)),
            b'`' if !pg => (Kind::Ident, skip_quoted(b, i, c, false)),
            b'[' if driver == Driver::Sqlite => (Kind::Ident, b[i..].iter().position(|&x| x == b']').map_or(b.len(), |p| i + p + 1)),
            b'$' if pg => match dollar_end(s, i) {
                Some(e) => (Kind::Str, e),
                None => (Kind::Sym, i + 1),
            },
            b'-' if b.get(i + 1) == Some(&b'-') => {
                i = line_end(b, i);
                continue;
            }
            b'#' if my => {
                i = line_end(b, i);
                continue;
            }
            b'/' if my && b[i..].starts_with(b"/*!") => {
                i += 3;
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i = block_end(b, i);
                continue;
            }
            c if c.is_ascii_whitespace() => {
                i += 1;
                continue;
            }
            c if is_ident(c) && c != b'$' => (Kind::Word, i + b[i..].iter().position(|&c| !is_ident(c)).unwrap_or(b.len() - i)),
            _ => (Kind::Sym, i + 1),
        };
        // Multi-byte chars are lexed as ident bytes, so `end` always lands on a char boundary.
        let raw = &s[i..end];
        if raw == ")" {
            depth -= 1;
        }
        out.push(Tok { kind, up: raw.to_ascii_uppercase(), raw, start: i, end, depth });
        if raw == "(" {
            depth += 1;
        }
        i = end;
    }
    out
}

/// True when `def` (a view definition) mentions `name` as an identifier (case-insensitive).
fn mentions(def: &str, driver: Driver, name: &str) -> bool {
    lex(def, driver).iter().any(|x| matches!(x.kind, Kind::Word | Kind::Ident) && unquote(x, Driver::Sqlite).eq_ignore_ascii_case(name))
}

// ---------- facts ----------

/// Facts for a critical action's card, computed on `pool`. Never fails: a fact that can't be
/// computed says so. Always ends with "Cannot be undone once it runs".
pub async fn facts(pool: &Pool, driver: Driver, a: &Assessment) -> Vec<String> {
    let mut out = vec![];
    match a.op {
        Op::Delete | Op::Update => {
            let verb = if a.op == Op::Delete { "deleted" } else { "updated" };
            out.push(match &a.count_sql {
                Some(q) => match count_read_only(pool, q).await {
                    Ok(n) => format!("{} will be {verb}", rows(n)),
                    Err(_) => NOT_COUNTED.into(),
                },
                None => NOT_COUNTED.into(),
            });
        }
        Op::Truncate => {
            for t in &a.targets {
                out.push(row_fact(pool, t).await);
            }
        }
        Op::DropTable => {
            for t in &a.targets {
                out.push(row_fact(pool, t).await);
                out.extend(dependents(pool, driver, t).await);
            }
        }
        Op::DropDatabase => {
            for t in &a.targets {
                out.push(database_size(pool, &t.name).await);
            }
        }
        _ => {}
    }
    out.push(IRREVERSIBLE.into());
    out
}

fn rows(n: i64) -> String {
    if n == 1 { "1 row".into() } else { format!("{n} rows") }
}

async fn row_fact(pool: &Pool, t: &ObjName) -> String {
    match count_read_only(pool, &format!("SELECT count(*) FROM {}", t.sql)).await {
        Ok(n) => format!("{} has {}", t.name, rows(n)),
        Err(_) => format!("Rows in {} could not be counted", t.name),
    }
}

/// Runs a count inside a read-only transaction, so functions in a WHERE clause can't write.
async fn count_read_only(pool: &Pool, sql: &str) -> AppResult<i64> {
    macro_rules! ro {
        ($p:expr, $begin:expr) => {{
            let mut c = $p.acquire().await?;
            sqlx::raw_sql($begin).execute(&mut *c).await?;
            let r = sqlx::query_scalar::<_, i64>(sql).fetch_one(&mut *c).await;
            let _ = sqlx::raw_sql("ROLLBACK").execute(&mut *c).await;
            Ok(r?)
        }};
    }
    // shortcut: no statement timeout on the count; add one if huge tables make cards slow to appear.
    match pool {
        Pool::Pg(p) => ro!(p, "BEGIN READ ONLY"),
        Pool::My(p) => ro!(p, "START TRANSACTION READ ONLY"),
        // SQLite functions can't write; there is nothing to guard.
        Pool::Lite(p) => Ok(sqlx::query_scalar::<_, i64>(sql).fetch_one(p).await?),
    }
}

/// Foreign keys from other tables, dependent views, and triggers on `t`.
async fn dependents(pool: &Pool, driver: Driver, t: &ObjName) -> Vec<String> {
    let schema = t.schema.clone().unwrap_or_default();
    let (fks, views, triggers) = match pool {
        Pool::Pg(_) => {
            let fks = names_of(pool, "SELECT DISTINCT conrelid::regclass::text FROM pg_constraint \
                WHERE contype = 'f' AND confrelid = $1::text::regclass AND conrelid <> confrelid ORDER BY 1", &[&t.sql]).await;
            let views = names_of(pool, "SELECT DISTINCT v.oid::regclass::text FROM pg_depend d \
                JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class v ON v.oid = r.ev_class \
                WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass \
                AND d.refobjid = $1::text::regclass AND v.oid <> d.refobjid ORDER BY 1", &[&t.sql]).await;
            let triggers = names_of(pool, "SELECT tgname::text FROM pg_trigger WHERE tgrelid = $1::text::regclass \
                AND NOT tgisinternal ORDER BY 1", &[&t.sql]).await;
            (fks, views, triggers)
        }
        Pool::My(_) => {
            const DB: &str = "COALESCE(NULLIF(?, ''), DATABASE())";
            let fks = names_of(pool, &format!("SELECT DISTINCT TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE \
                WHERE REFERENCED_TABLE_SCHEMA = {DB} AND REFERENCED_TABLE_NAME = ? \
                AND NOT (TABLE_SCHEMA = REFERENCED_TABLE_SCHEMA AND TABLE_NAME = REFERENCED_TABLE_NAME) ORDER BY 1"), &[&schema, &t.name]).await;
            let views = views_mentioning(pool, driver, &format!("SELECT TABLE_NAME, VIEW_DEFINITION FROM information_schema.VIEWS \
                WHERE TABLE_SCHEMA = {DB} ORDER BY 1"), &[&schema], &t.name).await;
            let triggers = names_of(pool, &format!("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS \
                WHERE EVENT_OBJECT_SCHEMA = {DB} AND EVENT_OBJECT_TABLE = ? ORDER BY 1"), &[&schema, &t.name]).await;
            (fks, views, triggers)
        }
        // shortcut: SQLite looks at the main database only (attached databases are ignored).
        Pool::Lite(_) => {
            let fks = names_of(pool, "SELECT DISTINCT m.name FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f \
                WHERE m.type = 'table' AND lower(f.\"table\") = lower(?1) AND lower(m.name) <> lower(?1) ORDER BY 1", &[&t.name]).await;
            let views = views_mentioning(pool, driver, "SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY 1", &[], &t.name).await;
            let triggers = names_of(pool, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND lower(tbl_name) = lower(?1) ORDER BY 1", &[&t.name]).await;
            (fks, views, triggers)
        }
    };
    let mut out = vec![];
    let mut add = |r: AppResult<Vec<String>>, label: &str| match r {
        Ok(v) if v.is_empty() => {}
        Ok(v) => out.push(format!("{label}: {}", v.join(", "))),
        Err(_) => out.push(format!("{label}: could not be checked")),
    };
    add(fks, &format!("Tables with foreign keys to {}", t.name));
    add(views, "Views that depend on it");
    add(triggers, "Triggers dropped with it");
    if out.is_empty() {
        out.push(format!("No foreign keys, views or triggers depend on {}", t.name));
    }
    out
}

async fn views_mentioning(pool: &Pool, driver: Driver, sql: &str, binds: &[&str], name: &str) -> AppResult<Vec<String>> {
    let rows = text_rows(pool, sql, binds).await?;
    Ok(rows.into_iter().filter(|r| mentions(&r[1], driver, name)).map(|mut r| r.swap_remove(0)).collect())
}

async fn names_of(pool: &Pool, sql: &str, binds: &[&str]) -> AppResult<Vec<String>> {
    Ok(text_rows(pool, sql, binds).await?.into_iter().map(|mut r| r.swap_remove(0)).collect())
}

async fn database_size(pool: &Pool, name: &str) -> String {
    let r = match pool {
        Pool::Pg(_) => text_rows(pool, "SELECT pg_database_size($1)::text, ''", &[name]).await,
        Pool::My(_) => text_rows(pool, "SELECT CAST(COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS CHAR), CAST(COUNT(*) AS CHAR) \
            FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", &[name]).await,
        Pool::Lite(_) => Ok(vec![]),
    };
    match r.ok().and_then(|r| r.into_iter().next()).and_then(|r| Some((r[0].parse::<u64>().ok()?, r[1].clone()))) {
        Some((bytes, tables)) if tables.is_empty() => format!("Database {name} uses {}", fmt_bytes(bytes)),
        Some((bytes, tables)) => format!("Database {name} has {tables} tables using {}", fmt_bytes(bytes)),
        None => format!("The size of {name} could not be measured"),
    }
}

fn fmt_bytes(n: u64) -> String {
    let units = ["bytes", "KB", "MB", "GB", "TB"];
    let (mut v, mut u) = (n as f64, 0);
    while v >= 1024.0 && u < units.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 { format!("{n} bytes") } else { format!("{v:.1} {}", units[u]) }
}

/// Runs a catalog query; every column is read as text (NULL → ""), so queries cast in SQL.
// shortcut: third copy of the private db::meta/objects text_rows; share it once db/ exposes one.
pub(crate) async fn text_rows(pool: &Pool, sql: &str, binds: &[&str]) -> AppResult<Vec<Vec<String>>> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use RiskLevel::*;

    #[test]
    fn levels() {
        let cases: &[(Driver, &str, RiskLevel, Op, Option<&str>)] = &[
            (Driver::Postgres, "SELECT * FROM orders", Read, Op::Read, None),
            (Driver::Postgres, "WITH x AS (SELECT 1) SELECT * FROM x", Read, Op::Read, None),
            (Driver::Postgres, "-- hi\nselect 1;", Read, Op::Read, None),
            (Driver::Postgres, "INSERT INTO orders (id) VALUES (1)", Change, Op::Insert, Some("orders")),
            (Driver::Sqlite, "INSERT OR REPLACE INTO t VALUES (1)", Critical, Op::Insert, Some("t")),
            (Driver::Postgres, "UPDATE orders SET status = 'x' WHERE id = 1", Change, Op::Update, Some("orders")),
            (Driver::Postgres, "update ORDERS set a = 1", Critical, Op::Update, Some("orders")),
            (Driver::Postgres, "UPDATE t SET note = 'WHERE x' -- WHERE id = 1", Critical, Op::Update, Some("t")),
            (Driver::Postgres, "UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)", Critical, Op::Update, Some("t")),
            (Driver::Postgres, "/* WHERE */ UPDATE t SET a = 1", Critical, Op::Update, Some("t")),
            (Driver::Postgres, "DELETE FROM orders WHERE id = 1", Critical, Op::Delete, Some("orders")),
            (Driver::Postgres, "DELETE FROM public.\"Orders\"", Critical, Op::Delete, Some("Orders")),
            (Driver::Mysql, "TRUNCATE TABLE `shop`.`orders`", Critical, Op::Truncate, Some("orders")),
            (Driver::Postgres, "TRUNCATE a, b", Critical, Op::Truncate, Some("a, b")),
            (Driver::Postgres, "DROP TABLE IF EXISTS orders CASCADE", Critical, Op::DropTable, Some("orders")),
            (Driver::Mariadb, "DROP DATABASE shop", Critical, Op::DropDatabase, Some("shop")),
            (Driver::Mysql, "DROP SCHEMA shop", Critical, Op::DropDatabase, Some("shop")),
            (Driver::Postgres, "DROP SCHEMA s", Critical, Op::Drop, Some("s")),
            (Driver::Postgres, "DROP VIEW v", Critical, Op::Drop, Some("v")),
            (Driver::Postgres, "ALTER TABLE orders DROP COLUMN note", Critical, Op::Alter, Some("orders")),
            (Driver::Postgres, "ALTER TABLE orders ADD COLUMN note text", Change, Op::Alter, Some("orders")),
            (Driver::Postgres, "ALTER TABLE orders ADD COLUMN a int, DROP COLUMN b", Critical, Op::Alter, Some("orders")),
            (Driver::Postgres, "ALTER TABLE orders ADD COLUMN a int, ALTER COLUMN b TYPE text", Critical, Op::Alter, Some("orders")),
            (Driver::Postgres, "ALTER TABLE IF EXISTS ONLY orders RENAME COLUMN a TO b", Change, Op::Alter, Some("orders")),
            (Driver::Postgres, "ALTER TABLE t ADD COLUMN c text DEFAULT 'drop'", Change, Op::Alter, Some("t")),
            (Driver::Postgres, "ALTER TABLE t ALTER COLUMN c DROP DEFAULT", Critical, Op::Alter, Some("t")),
            (Driver::Mysql, "ALTER TABLE t ADD c int /*!, DROP d */", Critical, Op::Alter, Some("t")),
            (Driver::Postgres, "CREATE TABLE shipments (id int)", Change, Op::Create, Some("shipments")),
            (Driver::Postgres, "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ix ON t (a)", Change, Op::Create, Some("ix")),
            (Driver::Postgres, "CREATE OR REPLACE VIEW v AS SELECT 1", Change, Op::Create, Some("v")),
            (Driver::Postgres, "COMMENT ON TABLE t IS 'x'", Change, Op::Comment, None),
            (Driver::Postgres, "GRANT SELECT ON t TO bob", Change, Op::Grant, None),
            (Driver::Postgres, "REVOKE SELECT ON t FROM bob", Critical, Op::Revoke, None),
            (Driver::Postgres, "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", Critical, Op::Other, None),
            (Driver::Mysql, "REPLACE INTO t VALUES (1)", Critical, Op::Other, None),
            (Driver::Postgres, "VACUUM", Critical, Op::Other, None),
            (Driver::Postgres, "FROBNICATE all", Critical, Op::Other, None),
            (Driver::Postgres, "SELECT * INTO t2 FROM t", Critical, Op::Other, None),
        ];
        for (driver, sql, level, op, target) in cases {
            let a = assess(*driver, sql).unwrap_or_else(|e| panic!("{sql}: {e}"));
            assert_eq!((a.level, a.op, a.target().as_deref()), (*level, *op, *target), "{sql}");
        }
    }

    #[test]
    fn rejected() {
        for (sql, msg) in [
            ("SELECT 1; SELECT 2", "one statement per call"),
            ("DELETE FROM a; DROP TABLE b", "one statement per call"),
            ("SET search_path TO x", "not allowed"),
            ("USE shop", "not allowed"),
            ("BEGIN", "not allowed"),
            ("SET TRANSACTION READ WRITE", "not allowed"),
            ("  -- nothing\n", "empty"),
        ] {
            let e = assess(Driver::Postgres, sql).unwrap_err();
            assert!(e.contains(msg), "{sql}: {e}");
        }
        // A `;` inside a string is not a second statement.
        assert!(assess(Driver::Postgres, "DELETE FROM t WHERE a = ';'").is_ok());
    }

    #[test]
    fn qualified_names() {
        let a = assess(Driver::Postgres, "DROP TABLE Public.\"My \"\"T\"\"\"").unwrap();
        assert_eq!(a.targets, [ObjName { sql: "Public.\"My \"\"T\"\"\"".into(), schema: Some("public".into()), name: "My \"T\"".into() }]);
        let a = assess(Driver::Mysql, "DROP TABLE `s`.`a``b`, c").unwrap();
        assert_eq!(a.targets.iter().map(|t| (t.schema.clone(), t.name.clone())).collect::<Vec<_>>(),
            [(Some("s".into()), "a`b".into()), (None, "c".into())]);
        assert_eq!(assess(Driver::Mysql, "DROP TABLE Orders").unwrap().targets[0].name, "Orders");
    }

    #[test]
    fn count_rewrites() {
        let c = |d, sql| assess(d, sql).unwrap().count_sql;
        let pg = Driver::Postgres;
        assert_eq!(c(pg, "DELETE FROM orders WHERE id > 3").as_deref(), Some("SELECT count(*) FROM orders WHERE id > 3"));
        assert_eq!(c(pg, "delete from public.orders o where o.id in (select id from x where y) returning *").as_deref(),
            Some("SELECT count(*) FROM public.orders o where o.id in (select id from x where y)"));
        assert_eq!(c(pg, "DELETE FROM orders").as_deref(), Some("SELECT count(*) FROM orders"));
        assert_eq!(c(pg, "DELETE FROM t RETURNING id").as_deref(), Some("SELECT count(*) FROM t"));
        assert_eq!(c(pg, "UPDATE orders SET a = 1, b = 'x WHERE' WHERE id = 2").as_deref(), Some("SELECT count(*) FROM orders WHERE id = 2"));
        assert_eq!(c(pg, "UPDATE orders AS o SET a = (SELECT 1 FROM z WHERE q) RETURNING o.id").as_deref(), Some("SELECT count(*) FROM orders AS o"));
        assert_eq!(c(Driver::Sqlite, "UPDATE OR IGNORE t SET a = 1 WHERE b").as_deref(), Some("SELECT count(*) FROM t WHERE b"));
        // Not rewritable: the count would be wrong.
        for sql in [
            "DELETE FROM t USING u WHERE t.id = u.id",
            "UPDATE t SET a = u.a FROM u WHERE t.id = u.id",
            "DELETE FROM t WHERE a = 1 ORDER BY id LIMIT 5",
            "UPDATE t, u SET t.a = u.a WHERE t.id = u.id",
            "DELETE t FROM t JOIN u ON u.id = t.id",
        ] {
            assert_eq!(c(Driver::Mysql, sql), None, "{sql}");
        }
    }

    #[test]
    fn view_mentions_and_bytes() {
        assert!(mentions("select `o`.`id` from `shop`.`orders` `o`", Driver::Mysql, "orders"));
        assert!(!mentions("select * from orders_archive", Driver::Sqlite, "orders"));
        assert!(mentions("CREATE VIEW v AS SELECT * FROM \"Orders\"", Driver::Sqlite, "orders"));
        assert_eq!(fmt_bytes(512), "512 bytes");
        assert_eq!(fmt_bytes(1536), "1.5 KB");
        assert_eq!(fmt_bytes(5 * 1024 * 1024), "5.0 MB");
    }
}
