//! Reads one table's full definition per driver. Every query returns text columns (casts in SQL).
use serde_json::Value;
use sqlx::Row;

use super::literal;
use crate::db::Pool;
use crate::db::value::is_numeric;
use crate::error::{AppError, AppResult};
use crate::model::{CheckDef, ColumnDef, Driver, ForeignKeyDef, IndexDef, TableDef};

type Rows = Vec<Vec<String>>;

/// Runs a metadata query; every column is read as text (NULL → "").
async fn rows(pool: &Pool, sql: &str, binds: &[&str]) -> AppResult<Rows> {
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

/// Consecutive rows with the same first column.
fn grouped(rows: Rows) -> Vec<Rows> {
    let mut out: Vec<Rows> = Vec::new();
    for r in rows {
        match out.last_mut() {
            Some(g) if g[0][0] == r[0] => g.push(r),
            _ => out.push(vec![r]),
        }
    }
    out
}

fn col(g: &Rows, i: usize) -> Vec<String> {
    g.iter().map(|r| r[i].clone()).collect()
}

fn not_found(schema: &str, table: &str) -> AppError {
    AppError::NotFound(format!("Table {schema}.{table} not found"))
}

fn some(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

/// Full definition of one table: columns (type, nullability, default, auto-increment), PK, FKs, indexes
/// (excluding the PK index), checks. Columns come back with `original_name = Some(name)` so the
/// definition can be edited and sent back as a change target directly.
pub async fn load_table(pool: &Pool, schema: &str, table: &str) -> AppResult<TableDef> {
    let mut t = match pool {
        Pool::Pg(_) => pg(pool, schema, table).await?,
        Pool::My(_) => mysql(pool, schema, table).await?,
        Pool::Lite(_) => sqlite(pool, if schema.is_empty() { "main" } else { schema }, table).await?,
    };
    for c in &mut t.columns {
        c.original_name = Some(c.name.clone());
    }
    Ok(t)
}

const PG_REL: &str = "(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p'))";

async fn pg(pool: &Pool, schema: &str, table: &str) -> AppResult<TableDef> {
    let b = [schema, table];
    // shortcut: generated columns (attgenerated) show their expression as the default.
    let cols = rows(pool, &format!(
        "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN '1' ELSE '0' END,
           pg_get_expr(d.adbin, d.adrelid), a.attidentity::text
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = {PG_REL} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"), &b).await?;
    if cols.is_empty() {
        return Err(not_found(schema, table));
    }
    let columns = cols
        .into_iter()
        .map(|r| {
            // serial = integer with a nextval() default; identity = attidentity 'a'/'d'.
            let auto_increment = !r[4].is_empty() || r[3].starts_with("nextval(");
            ColumnDef {
                name: r[0].clone(),
                original_name: None,
                type_name: r[1].clone(),
                nullable: r[2] == "0",
                default: if auto_increment { None } else { some(&r[3]) },
                auto_increment,
            }
        })
        .collect();
    // shortcut: expression and partial indexes are skipped (not representable in IndexDef).
    let idx = rows(pool, &format!(
        "SELECT i.relname::text, CASE WHEN x.indisprimary THEN '1' ELSE '0' END, CASE WHEN x.indisunique THEN '1' ELSE '0' END,
           a.attname::text, CASE WHEN x.indexprs IS NULL AND x.indpred IS NULL THEN '1' ELSE '0' END
         FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
         CROSS JOIN LATERAL unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
         LEFT JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
         WHERE x.indrelid = {PG_REL} AND k.ord <= x.indnkeyatts ORDER BY i.relname, k.ord"), &b).await?;
    let mut primary_key = vec![];
    let mut indexes = vec![];
    for g in grouped(idx) {
        let cols = col(&g, 3);
        if g[0][4] != "1" || cols.iter().any(String::is_empty) {
            continue;
        }
        if g[0][1] == "1" {
            primary_key = cols;
        } else {
            indexes.push(IndexDef { name: g[0][0].clone(), columns: cols, unique: g[0][2] == "1" });
        }
    }
    let fks = rows(pool, &format!(
        "SELECT co.conname::text, a.attname::text, rn.nspname::text, rc.relname::text, ra.attname::text,
           co.confdeltype::text, co.confupdtype::text
         FROM pg_constraint co CROSS JOIN LATERAL unnest(co.conkey, co.confkey) WITH ORDINALITY AS k(col, refcol, ord)
         JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = k.col
         JOIN pg_class rc ON rc.oid = co.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         JOIN pg_attribute ra ON ra.attrelid = co.confrelid AND ra.attnum = k.refcol
         WHERE co.contype = 'f' AND co.conrelid = {PG_REL} ORDER BY co.conname, k.ord"), &b).await?;
    let pg_action = |c: &str| {
        match c {
            "r" => Some("RESTRICT"),
            "c" => Some("CASCADE"),
            "n" => Some("SET NULL"),
            "d" => Some("SET DEFAULT"),
            _ => None, // 'a' = NO ACTION, the default
        }
        .map(str::to_string)
    };
    let foreign_keys = grouped(fks)
        .into_iter()
        .map(|g| ForeignKeyDef {
            name: Some(g[0][0].clone()),
            columns: col(&g, 1),
            ref_schema: (g[0][2] != schema).then(|| g[0][2].clone()),
            ref_table: g[0][3].clone(),
            ref_columns: col(&g, 4),
            on_delete: pg_action(&g[0][5]),
            on_update: pg_action(&g[0][6]),
        })
        .collect();
    let checks = rows(pool, &format!(
        "SELECT conname::text, pg_get_constraintdef(oid) FROM pg_constraint WHERE contype = 'c' AND conrelid = {PG_REL} ORDER BY conname"), &b)
        .await?
        .into_iter()
        .map(|r| {
            let def = r[1].strip_prefix("CHECK ").unwrap_or(&r[1]);
            let def = def.strip_suffix(" NOT VALID").unwrap_or(def);
            CheckDef { name: Some(r[0].clone()), expression: strip_parens(def).to_string() }
        })
        .collect();
    Ok(TableDef { schema: schema.into(), name: table.into(), columns, primary_key, foreign_keys, indexes, checks })
}

async fn mysql(pool: &Pool, schema: &str, table: &str) -> AppResult<TableDef> {
    let b = [schema, table];
    let kind = rows(pool, "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", &b).await?;
    if !kind.iter().any(|r| r[0] == "BASE TABLE") {
        return Err(not_found(schema, table));
    }
    let version = rows(pool, "SELECT VERSION()", &[]).await?;
    let mariadb = version.first().is_some_and(|r| r[0].contains("MariaDB"));
    let columns = rows(pool,
        "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, CASE WHEN COLUMN_DEFAULT IS NULL THEN '0' ELSE '1' END,
           EXTRA, DATA_TYPE
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", &b)
        .await?
        .into_iter()
        .map(|r| ColumnDef {
            name: r[0].clone(),
            original_name: None,
            type_name: r[1].clone(),
            nullable: r[2] == "YES",
            default: mysql_default(mariadb, r[4] == "1", &r[3], &r[5], &r[6]),
            auto_increment: r[5].to_lowercase().contains("auto_increment"),
        })
        .collect();
    let fks = rows(pool,
        "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
           r.DELETE_RULE, r.UPDATE_RULE
         FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
         WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION", &b).await?;
    // RESTRICT and NO ACTION are the same thing in MySQL/MariaDB (and the default).
    let my_action = |a: &str| (!matches!(a, "RESTRICT" | "NO ACTION" | "")).then(|| a.to_string());
    let foreign_keys: Vec<ForeignKeyDef> = grouped(fks)
        .into_iter()
        .map(|g| ForeignKeyDef {
            name: Some(g[0][0].clone()),
            columns: col(&g, 1),
            ref_schema: (g[0][2] != schema).then(|| g[0][2].clone()),
            ref_table: g[0][3].clone(),
            ref_columns: col(&g, 4),
            on_delete: my_action(&g[0][5]),
            on_update: my_action(&g[0][6]),
        })
        .collect();
    let idx = rows(pool,
        "SELECT INDEX_NAME, CAST(NON_UNIQUE AS CHAR), COLUMN_NAME FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX", &b).await?;
    let mut primary_key = vec![];
    let mut indexes = vec![];
    for g in grouped(idx) {
        let cols = col(&g, 2);
        let (name, unique) = (g[0][0].clone(), g[0][1] == "0");
        if cols.iter().any(String::is_empty) {
            continue; // functional index (MySQL 8)
        }
        // The index MySQL creates for a FK is named after the constraint (or its first column).
        let fk_backing = !unique
            && foreign_keys.iter().any(|f| f.columns == cols && (f.name.as_deref() == Some(&name) || f.columns[0] == name));
        if name == "PRIMARY" {
            primary_key = cols;
        } else if !fk_backing {
            indexes.push(IndexDef { name, columns: cols, unique });
        }
    }
    // MySQL 8's CHECK_CONSTRAINTS has no TABLE_NAME (names are per schema); MariaDB's does (names are per table).
    let checks_sql = if mariadb {
        "SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? ORDER BY CONSTRAINT_NAME"
    } else {
        "SELECT cc.CONSTRAINT_NAME, cc.CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS cc
         JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
         WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK' ORDER BY cc.CONSTRAINT_NAME"
    };
    // Older servers have no CHECK_CONSTRAINTS table: no checks then.
    let checks = rows(pool, checks_sql, &b)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|r| CheckDef { name: Some(r[0].clone()), expression: strip_parens(&r[1]).to_string() })
        .collect();
    Ok(TableDef { schema: schema.into(), name: table.into(), columns, primary_key, foreign_keys, indexes, checks })
}

/// COLUMN_DEFAULT as a SQL expression. MariaDB already reports expressions (`'abc'`, `NULL` text for
/// "no default"); MySQL 8 reports literal strings unquoted and flags expressions as DEFAULT_GENERATED.
fn mysql_default(mariadb: bool, has: bool, raw: &str, extra: &str, data_type: &str) -> Option<String> {
    if !has {
        return None;
    }
    if mariadb {
        return (raw != "NULL").then(|| raw.to_string());
    }
    // shortcut: MySQL 8 heuristics below are untested here (only MariaDB in CI); revisit with a MySQL 8 server.
    if extra.to_lowercase().contains("default_generated") {
        let l = raw.to_lowercase();
        return Some(if l.starts_with("current_timestamp") || l.starts_with('(') { raw.to_string() } else { format!("({raw})") });
    }
    if is_numeric(data_type) || data_type.eq_ignore_ascii_case("bit") {
        Some(raw.to_string())
    } else {
        Some(literal(Driver::Mysql, &Value::String(raw.to_string())))
    }
}

async fn sqlite(pool: &Pool, schema: &str, table: &str) -> AppResult<TableDef> {
    let s = super::quote_ident(Driver::Sqlite, schema);
    let b = [table, schema];
    let sql = rows(pool, &format!("SELECT sql FROM {s}.sqlite_master WHERE type = 'table' AND name = ?1"), &[table]).await?;
    let Some(sql) = sql.into_iter().next().map(|mut r| r.remove(0)) else {
        return Err(not_found(schema, table));
    };
    let cols = rows(pool,
        "SELECT name, type, CAST(\"notnull\" AS TEXT), dflt_value, CAST(pk AS TEXT) FROM pragma_table_info(?1, ?2) ORDER BY cid", &b).await?;
    let mut pk: Vec<(i64, String)> = cols.iter().filter(|r| r[4] != "0").map(|r| (r[4].parse().unwrap_or(0), r[0].clone())).collect();
    pk.sort();
    let primary_key: Vec<String> = pk.into_iter().map(|(_, n)| n).collect();
    let autoinc = sql.to_uppercase().contains("AUTOINCREMENT");
    let columns = cols
        .iter()
        .map(|r| ColumnDef {
            name: r[0].clone(),
            original_name: None,
            type_name: r[1].clone(),
            // A single INTEGER PRIMARY KEY is the rowid: never NULL, though pragma reports notnull = 0.
            nullable: r[2] == "0" && !(primary_key.len() == 1 && primary_key[0] == r[0] && r[1].eq_ignore_ascii_case("INTEGER")),
            default: some(&r[3]),
            auto_increment: autoinc && primary_key.len() == 1 && primary_key[0] == r[0] && r[1].eq_ignore_ascii_case("INTEGER"),
        })
        .collect();
    let mut indexes = vec![];
    // shortcut: partial and expression indexes are skipped (not representable in IndexDef).
    for r in rows(pool, "SELECT name, CAST(\"unique\" AS TEXT), origin, CAST(partial AS TEXT) FROM pragma_index_list(?1, ?2) ORDER BY name", &b).await? {
        if r[2] == "pk" || r[3] == "1" {
            continue;
        }
        let cols: Vec<String> =
            rows(pool, "SELECT name FROM pragma_index_info(?1, ?2) ORDER BY seqno", &[&r[0], schema]).await?.into_iter().map(|mut c| c.remove(0)).collect();
        if !cols.is_empty() && !cols.iter().any(String::is_empty) {
            indexes.push(IndexDef { name: r[0].clone(), columns: cols, unique: r[1] == "1" });
        }
    }
    let fks = rows(pool,
        "SELECT CAST(id AS TEXT), \"table\", \"from\", \"to\", on_update, on_delete FROM pragma_foreign_key_list(?1, ?2) ORDER BY id, seq", &b).await?;
    let lite_action = |a: &str| (!matches!(a, "NO ACTION" | "")).then(|| a.to_string());
    let mut foreign_keys = vec![];
    for g in grouped(fks) {
        let mut ref_columns = col(&g, 3);
        // `REFERENCES parent` without columns means the parent's primary key.
        if ref_columns.iter().all(String::is_empty) {
            ref_columns = rows(pool, "SELECT name FROM pragma_table_info(?1, ?2) WHERE pk > 0 ORDER BY pk", &[&g[0][1], schema])
                .await?
                .into_iter()
                .map(|mut c| c.remove(0))
                .collect();
        }
        foreign_keys.push(ForeignKeyDef {
            name: None,
            columns: col(&g, 2),
            ref_schema: None,
            ref_table: g[0][1].clone(),
            ref_columns,
            on_delete: lite_action(&g[0][5]),
            on_update: lite_action(&g[0][4]),
        });
    }
    Ok(TableDef { schema: schema.into(), name: table.into(), columns, primary_key, foreign_keys, indexes, checks: sqlite_checks(&sql) })
}

#[derive(Debug, PartialEq)]
enum Tok {
    Word(String),
    Quoted(String),
    Punct(char),
}

/// Tokens with byte offsets; skips whitespace, comments and string literals' contents.
fn tokens(sql: &str) -> Vec<(usize, Tok)> {
    let chars: Vec<(usize, char)> = sql.char_indices().collect();
    let at = |i: usize| chars.get(i).map(|c| c.1);
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(c) = at(i) {
        let pos = chars[i].0;
        if c.is_whitespace() {
            i += 1;
        } else if c == '-' && at(i + 1) == Some('-') {
            while at(i).is_some_and(|c| c != '\n') {
                i += 1;
            }
        } else if c == '/' && at(i + 1) == Some('*') {
            i += 2;
            while at(i).is_some() && !(at(i) == Some('*') && at(i + 1) == Some('/')) {
                i += 1;
            }
            i += 2;
        } else if matches!(c, '\'' | '"' | '`' | '[') {
            let close = if c == '[' { ']' } else { c };
            let mut text = String::new();
            i += 1;
            while let Some(x) = at(i) {
                i += 1;
                if x == close {
                    if close != ']' && at(i) == Some(close) {
                        i += 1; // doubled quote = escaped
                    } else {
                        break;
                    }
                }
                text.push(x);
            }
            out.push((pos, if c == '\'' { Tok::Punct('\'') } else { Tok::Quoted(text) }));
        } else if c.is_alphanumeric() || c == '_' {
            let start = i;
            while at(i).is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$') {
                i += 1;
            }
            out.push((pos, Tok::Word(chars[start..i].iter().map(|c| c.1).collect())));
        } else {
            out.push((pos, Tok::Punct(c)));
            i += 1;
        }
    }
    out
}

/// CHECK constraints from a SQLite CREATE TABLE statement (column-level checks become table-level).
fn sqlite_checks(sql: &str) -> Vec<CheckDef> {
    let toks = tokens(sql);
    let mut out = Vec::new();
    for (i, (_, t)) in toks.iter().enumerate() {
        let is_check = matches!(t, Tok::Word(w) if w.eq_ignore_ascii_case("CHECK"));
        let Some((open, Tok::Punct('('))) = toks.get(i + 1).filter(|_| is_check) else { continue };
        let mut depth = 0;
        let close = toks[i + 1..].iter().find_map(|(p, t)| {
            match t {
                Tok::Punct('(') => depth += 1,
                Tok::Punct(')') => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(*p);
                    }
                }
                _ => {}
            }
            None
        });
        let Some(close) = close else { continue };
        let name = match (i.checked_sub(2).map(|j| &toks[j].1), i.checked_sub(1).map(|j| &toks[j].1)) {
            (Some(Tok::Word(c)), Some(Tok::Word(n) | Tok::Quoted(n))) if c.eq_ignore_ascii_case("CONSTRAINT") => Some(n.clone()),
            _ => None,
        };
        out.push(CheckDef { name, expression: sql[open + 1..close].trim().to_string() });
    }
    out
}

/// `((a > 0))` → `a > 0`: removes parentheses that wrap the whole expression.
pub(super) fn strip_parens(s: &str) -> &str {
    let mut s = s.trim();
    while s.starts_with('(') && s.ends_with(')') {
        let mut depth = 0;
        let wraps = s.char_indices().all(|(i, c)| {
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            depth > 0 || i == s.len() - 1
        });
        if !wraps {
            break;
        }
        s = s[1..s.len() - 1].trim();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parens() {
        assert_eq!(strip_parens("((qty > 0))"), "qty > 0");
        assert_eq!(strip_parens("(a > 0) AND (b > 0)"), "(a > 0) AND (b > 0)");
        assert_eq!(strip_parens(" `c` > 0 "), "`c` > 0");
    }

    #[test]
    fn sqlite_check_parsing() {
        let sql = r#"CREATE TABLE t (id INTEGER PRIMARY KEY, qty INT CHECK (qty > 0), note TEXT DEFAULT 'CHECK (x)',
            -- CHECK (comment)
            "we""ird" TEXT, CONSTRAINT "pos total" CHECK ((qty * 2) < 100), constraint c2 check(length(note) < 10))"#;
        let checks = sqlite_checks(sql);
        assert_eq!(checks, vec![
            CheckDef { name: None, expression: "qty > 0".into() },
            CheckDef { name: Some("pos total".into()), expression: "(qty * 2) < 100".into() },
            CheckDef { name: Some("c2".into()), expression: "length(note) < 10".into() },
        ]);
        assert!(sqlite_checks("CREATE TABLE t (a, b)").is_empty());
    }

    #[test]
    fn mysql_defaults() {
        assert_eq!(mysql_default(true, true, "NULL", "", "varchar"), None);
        assert_eq!(mysql_default(true, true, "'x''y'", "", "varchar").as_deref(), Some("'x''y'"));
        assert_eq!(mysql_default(true, false, "", "", "int"), None);
        assert_eq!(mysql_default(false, true, "", "", "varchar").as_deref(), Some("''"));
        assert_eq!(mysql_default(false, true, "it's", "", "varchar").as_deref(), Some("'it''s'"));
        assert_eq!(mysql_default(false, true, "5", "", "int").as_deref(), Some("5"));
        assert_eq!(mysql_default(false, true, "CURRENT_TIMESTAMP", "DEFAULT_GENERATED", "datetime").as_deref(), Some("CURRENT_TIMESTAMP"));
        assert_eq!(mysql_default(false, true, "uuid()", "DEFAULT_GENERATED", "char").as_deref(), Some("(uuid())"));
    }
}
