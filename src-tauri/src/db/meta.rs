//! Metadata: navigator tree, columns, ER model, completion schema.
//!
//! Every metadata query returns text columns (casts in SQL) so one reader serves all drivers.
use std::collections::HashMap;

use sqlx::Row;

use super::Pool;
use super::page::quote;
use super::value::is_numeric;
use crate::error::AppResult;
use crate::model::{Column, Connection, ErColumn, ErModel, ErRelation, ErTable, NodeKind, SchemaNode};

/// Group key, node kind; tables and views are listed even when empty.
const GROUPS: [(&str, NodeKind); 7] = [
    ("tables", NodeKind::Table),
    ("views", NodeKind::View),
    ("functions", NodeKind::Function),
    ("procedures", NodeKind::Procedure),
    ("triggers", NodeKind::Trigger),
    ("sequences", NodeKind::Sequence),
    ("events", NodeKind::Event),
];

const PG_SCHEMA_FILTER: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema') \
     AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'";

/// Runs a metadata query; every column is read as text (NULL → "").
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

/// First column of the first row, "" when there is none.
async fn scalar(pool: &Pool, sql: &str) -> AppResult<String> {
    Ok(text_rows(pool, sql, &[]).await?.into_iter().next().and_then(|r| r.into_iter().next()).unwrap_or_default())
}

fn node(id: String, label: &str, kind: NodeKind, schema: Option<&str>, children: Option<Vec<SchemaNode>>) -> SchemaNode {
    let count = if kind == NodeKind::Group { children.as_ref().map(|c| c.len() as u64) } else { None };
    SchemaNode { id, label: label.to_string(), kind, count, schema: schema.map(str::to_string), children, lazy: false, size: None }
}

/// `[name, bytes]` rows as a map. Sizes are cosmetic: any error or unparsable value means no size.
async fn sizes(pool: &Pool, sql: &str, binds: &[&str]) -> HashMap<String, u64> {
    let rows = text_rows(pool, sql, binds).await.unwrap_or_default();
    rows.into_iter().filter_map(|r| Some((r[0].clone(), r[1].parse().ok()?))).collect()
}

/// Group nodes for one schema/database from `[schema, group, name]` rows.
fn groups(prefix: &str, schema: &str, objects: &[Vec<String>]) -> Vec<SchemaNode> {
    GROUPS
        .iter()
        .filter_map(|(key, kind)| {
            let items: Vec<SchemaNode> = objects
                .iter()
                .filter(|o| o[0] == schema && o[1] == *key)
                .map(|o| node(format!("{prefix}/{key}/{}", o[2]), &o[2], *kind, Some(schema), None))
                .collect();
            if items.is_empty() && !matches!(*key, "tables" | "views") {
                return None;
            }
            let label = format!("{}{}", key[..1].to_uppercase(), &key[1..]);
            Some(node(format!("{prefix}/{key}"), &label, NodeKind::Group, None, Some(items)))
        })
        .collect()
}

/// Top-level Roles node, or nothing when the role list can't be read (missing privileges).
async fn roles_node(pool: &Pool, conn_id: &str, sql: &str) -> Option<SchemaNode> {
    let rows = text_rows(pool, sql, &[]).await.ok()?;
    let roles: Vec<SchemaNode> = rows
        .iter()
        .filter(|r| !r[0].is_empty())
        .map(|r| node(format!("{conn_id}/roles/{}", r[0]), &r[0], NodeKind::Role, None, None))
        .collect();
    let mut n = node(format!("{conn_id}/roles"), "Roles", NodeKind::Role, None, None);
    n.count = Some(roles.len() as u64);
    n.children = Some(roles);
    Some(n)
}

pub async fn schema_tree(pool: &Pool, conn: &Connection) -> AppResult<Vec<SchemaNode>> {
    let id = &conn.id;
    let mut tree = Vec::new();
    match pool {
        Pool::Pg(_) => {
            let mut dbs = conn.databases();
            if dbs.is_empty() {
                dbs = text_rows(pool, "SELECT datname::text FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1", &[])
                    .await?
                    .into_iter()
                    .map(|mut r| r.remove(0))
                    .collect();
            }
            if dbs.len() == 1 && conn.base_database().as_ref() == dbs.first() {
                tree.push(database_tree(pool, conn).await?);
            } else {
                // Each database needs its own pool, so its objects load on expand (`database_tree`).
                let marks = (1..=dbs.len()).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ");
                let binds: Vec<&str> = dbs.iter().map(String::as_str).collect();
                let size = sizes(pool, &format!(
                    "SELECT datname::text, CASE WHEN has_database_privilege(datname, 'CONNECT') THEN pg_database_size(datname)::text END
                     FROM pg_database WHERE datname IN ({marks})"), &binds).await;
                tree.extend(dbs.iter().map(|db| SchemaNode {
                    lazy: true,
                    size: size.get(db).copied(),
                    ..node(format!("{id}/{db}"), db, NodeKind::Database, None, None)
                }));
            }
            tree.extend(roles_node(pool, id, "SELECT rolname::text FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY 1").await);
        }
        Pool::My(_) => {
            let mut dbs = conn.databases();
            if dbs.is_empty() {
                dbs = text_rows(pool, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA \
                    WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') ORDER BY 1", &[])
                    .await?
                    .into_iter()
                    .map(|mut r| r.remove(0))
                    .collect();
            }
            let (objects, size) = if dbs.is_empty() {
                (Vec::new(), HashMap::new())
            } else {
                let marks = vec!["?"; dbs.len()].join(", ");
                let binds: Vec<&str> = dbs.iter().map(String::as_str).collect();
                let objects = text_rows(pool, &format!(
                    "SELECT s, g, n FROM (
                       SELECT TABLE_SCHEMA AS s, CASE TABLE_TYPE WHEN 'VIEW' THEN 'views' ELSE 'tables' END AS g, TABLE_NAME AS n
                       FROM information_schema.TABLES WHERE TABLE_TYPE <> 'SYSTEM VIEW'
                       UNION ALL SELECT ROUTINE_SCHEMA, CASE ROUTINE_TYPE WHEN 'PROCEDURE' THEN 'procedures' ELSE 'functions' END, ROUTINE_NAME
                       FROM information_schema.ROUTINES
                       UNION ALL SELECT TRIGGER_SCHEMA, 'triggers', TRIGGER_NAME FROM information_schema.TRIGGERS
                       UNION ALL SELECT EVENT_SCHEMA, 'events', EVENT_NAME FROM information_schema.EVENTS
                     ) o WHERE s IN ({marks}) ORDER BY 1, 2, 3"), &binds).await?;
                // From SCHEMATA so an existing database without tables reports 0.
                let size = sizes(pool, &format!(
                    "SELECT s.SCHEMA_NAME, CAST(COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS CHAR)
                     FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
                     WHERE s.SCHEMA_NAME IN ({marks}) GROUP BY s.SCHEMA_NAME"), &binds).await;
                (objects, size)
            };
            for db in &dbs {
                let prefix = format!("{id}/{db}");
                let children = groups(&prefix, db, &objects);
                tree.push(SchemaNode { size: size.get(db).copied(), ..node(prefix, db, NodeKind::Database, Some(db), Some(children)) });
            }
            tree.extend(roles_node(pool, id, "SELECT DISTINCT User FROM mysql.user ORDER BY 1").await);
        }
        Pool::Lite(_) => {
            let objects = text_rows(pool,
                "SELECT 'main', type || 's', name FROM sqlite_master \
                 WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY 2, 3", &[]).await?;
            let prefix = format!("{id}/main");
            let children = groups(&prefix, "main", &objects);
            let size = scalar(pool, "SELECT CAST(page_count * page_size AS TEXT) FROM pragma_page_count(), pragma_page_size()").await;
            let size = size.ok().and_then(|s| s.parse().ok());
            tree.push(SchemaNode { size, ..node(prefix, "main", NodeKind::Database, Some("main"), Some(children)) });
        }
    }
    Ok(tree)
}

/// The populated node of the pool's own database (PostgreSQL): schemas with their object groups.
/// Also expands a lazy database node, called with that database's pool. `conn.id` is the bare connection id.
pub async fn database_tree(pool: &Pool, conn: &Connection) -> AppResult<SchemaNode> {
    if !matches!(pool, Pool::Pg(_)) {
        return Err(crate::error::AppError::NotSupported("Per-database trees are PostgreSQL only".into()));
    }
    let id = &conn.id;
    let db = scalar(pool, "SELECT current_database()::text").await?;
    let schemas =
        text_rows(pool, &format!("SELECT n.nspname::text FROM pg_namespace n WHERE {PG_SCHEMA_FILTER} ORDER BY 1"), &[])
            .await?;
    // shortcut: overloaded functions and same-named triggers on different tables show once (UNION dedupes).
    let objects = text_rows(pool, &format!(
        "SELECT n.nspname::text, CASE WHEN c.relkind IN ('r','p') THEN 'tables' WHEN c.relkind IN ('v','m') THEN 'views' ELSE 'sequences' END, c.relname::text
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','S') AND {PG_SCHEMA_FILTER}
         UNION
         SELECT n.nspname::text, CASE p.prokind WHEN 'p' THEN 'procedures' ELSE 'functions' END, p.proname::text
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prokind IN ('f','p') AND {PG_SCHEMA_FILTER}
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
         UNION
         SELECT n.nspname::text, 'triggers', t.tgname::text
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal AND {PG_SCHEMA_FILTER}
         ORDER BY 1, 2, 3"), &[]).await?;
    let schema_nodes = schemas
        .iter()
        .map(|s| {
            let prefix = format!("{id}/{db}/{}", s[0]);
            let children = groups(&prefix, &s[0], &objects);
            node(prefix, &s[0], NodeKind::Schema, Some(&s[0]), Some(children))
        })
        .collect();
    let size = scalar(pool, "SELECT pg_database_size(current_database())::text").await.ok().and_then(|s| s.parse().ok());
    Ok(SchemaNode { size, ..node(format!("{id}/{db}"), &db, NodeKind::Database, None, Some(schema_nodes)) })
}

/// `[table, column, type, pk, fk]` rows; `table = ""` means every table and view of the schema.
async fn column_rows(pool: &Pool, schema: &str, table: &str) -> AppResult<Vec<Vec<String>>> {
    match pool {
        Pool::Pg(_) => text_rows(pool,
            "SELECT c.relname::text, a.attname::text, t.typname::text,
               CASE WHEN EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p' AND a.attnum = ANY(k.conkey)) THEN '1' ELSE '0' END,
               CASE WHEN EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f' AND a.attnum = ANY(k.conkey)) THEN '1' ELSE '0' END,
               COALESCE((SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = a.atttypid)::text, '')
             FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_type t ON t.oid = a.atttypid
             WHERE n.nspname = $1 AND (c.relname = $2 OR $2 = '') AND c.relkind IN ('r','p','v','m','f')
               AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY c.relname, a.attnum", &[schema, table]).await,
        Pool::My(_) => text_rows(pool,
            "SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE,
               CASE WHEN c.COLUMN_KEY = 'PRI' THEN '1' ELSE '0' END,
               CASE WHEN EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA
                 AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME AND k.REFERENCED_TABLE_NAME IS NOT NULL) THEN '1' ELSE '0' END,
               CASE WHEN c.DATA_TYPE = 'enum' THEN c.COLUMN_TYPE ELSE '' END
             FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = ? AND (c.TABLE_NAME = ? OR ? = '')
             ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION", &[schema, table, table]).await,
        Pool::Lite(_) => {
            let schema = lite_schema(schema);
            text_rows(pool, &format!(
                "SELECT m.name, p.name, lower(p.type), CASE WHEN p.pk > 0 THEN '1' ELSE '0' END,
                   CASE WHEN EXISTS (SELECT 1 FROM pragma_foreign_key_list(m.name, ?1) f WHERE f.\"from\" = p.name) THEN '1' ELSE '0' END, ''
                 FROM {}.sqlite_master m JOIN pragma_table_info(m.name, ?1) p
                 WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND (m.name = ?2 OR ?2 = '')
                 ORDER BY m.name, p.cid", quote(pool, schema)), &[schema, table]).await
        }
    }
}

fn lite_schema(schema: &str) -> &str {
    if schema.is_empty() { "main" } else { schema }
}

pub async fn table_columns(pool: &Pool, schema: &str, table: &str) -> AppResult<Vec<Column>> {
    Ok(column_rows(pool, schema, table)
        .await?
        .into_iter()
        .map(|r| {
            let type_name = r[2].to_lowercase();
            Column { name: r[1].clone(), numeric: is_numeric(&type_name), type_name, pk: r[3] == "1", fk: r[4] == "1", enum_values: enum_values(&r[5]) }
        })
        .collect())
}

/// Parses PostgreSQL's JSON label array (`["a","b"]`) or MySQL's column type (`enum('a','it''s')`); anything else → none.
fn enum_values(raw: &str) -> Vec<String> {
    if raw.starts_with('[') {
        return serde_json::from_str(raw).unwrap_or_default();
    }
    let Some(body) = raw.strip_prefix("enum(").and_then(|b| b.strip_suffix(')')) else { return vec![] };
    let (mut out, mut cur, mut quoted) = (vec![], String::new(), false);
    let mut chars = body.chars().peekable();
    while let Some(ch) = chars.next() {
        match (ch, quoted) {
            ('\'', false) => quoted = true,
            ('\'', true) if chars.peek() == Some(&'\'') => {
                cur.push('\'');
                chars.next();
            }
            ('\'', true) => {
                quoted = false;
                out.push(std::mem::take(&mut cur));
            }
            (c, true) => cur.push(c),
            _ => {} // separators between quoted values
        }
    }
    out
}

pub async fn er_model(pool: &Pool, schema: &str) -> AppResult<ErModel> {
    let (tables_sql, table_binds, rel_sql, binds): (String, Vec<&str>, String, Vec<&str>) = match pool {
        Pool::Pg(_) => (
            "SELECT c.relname::text, c.reltuples::bigint::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relkind IN ('r','p') ORDER BY 1".into(),
            vec![schema],
            "SELECT cl.relname::text, a.attname::text, rc.relname::text, ra.attname::text
             FROM pg_constraint co JOIN pg_namespace n ON n.oid = co.connamespace
             CROSS JOIN LATERAL unnest(co.conkey, co.confkey) AS k(col, refcol)
             JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = k.col
             JOIN pg_class rc ON rc.oid = co.confrelid JOIN pg_attribute ra ON ra.attrelid = co.confrelid AND ra.attnum = k.refcol
             WHERE co.contype = 'f' AND n.nspname = $1 ORDER BY 1, 2".into(),
            vec![schema],
        ),
        Pool::My(_) => (
            "SELECT TABLE_NAME, CAST(TABLE_ROWS AS CHAR) FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY 1".into(),
            vec![schema],
            "SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY 1, 2".into(),
            vec![schema],
        ),
        Pool::Lite(_) => {
            let s = quote(pool, lite_schema(schema));
            (
                format!("SELECT name, '' FROM {s}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY 1"),
                vec![],
                // A FK without a target column references the parent's primary key.
                format!("SELECT m.name, f.\"from\", f.\"table\",
                           COALESCE(f.\"to\", (SELECT name FROM pragma_table_info(f.\"table\", ?1) WHERE pk = 1))
                         FROM {s}.sqlite_master m JOIN pragma_foreign_key_list(m.name, ?1) f WHERE m.type = 'table' ORDER BY 1, 2"),
                vec![lite_schema(schema)],
            )
        }
    };
    let table_rows = text_rows(pool, &tables_sql, &table_binds).await?;
    let columns = column_rows(pool, schema, "").await?;
    let relations = text_rows(pool, &rel_sql, &binds)
        .await?
        .into_iter()
        .map(|r| ErRelation {
            id: format!("{}.{}->{}", r[0], r[1], r[2]),
            from: r[0].clone(),
            from_column: r[1].clone(),
            to: r[2].clone(),
            to_column: r[3].clone(),
        })
        .collect();
    let tables = table_rows
        .iter()
        .map(|t| ErTable {
            name: t[0].clone(),
            rows: short_count(&t[1]),
            columns: columns
                .iter()
                .filter(|c| c[0] == t[0])
                .map(|c| ErColumn { name: c[1].clone(), type_name: c[2].to_lowercase(), pk: c[3] == "1", fk: c[4] == "1" })
                .collect(),
        })
        .collect();
    Ok(ErModel { tables, relations })
}

/// 860 → "860", 2400 → "2.4k", 1_200_000 → "1.2M"; unknown (≤ 0, PostgreSQL's −1) → "".
fn short_count(s: &str) -> String {
    let n: f64 = s.parse().unwrap_or(0.0);
    let (v, unit) = match n {
        n if n <= 0.0 => return String::new(),
        n if n < 1e3 => return format!("{n}"),
        n if n < 1e6 => (n / 1e3, "k"),
        n => (n / 1e6, "M"),
    };
    format!("{v:.1}").trim_end_matches(".0").to_string() + unit
}

/// Table name → column names, for editor autocomplete. Keys are bare table names.
pub async fn completion_schema(pool: &Pool, conn: &Connection) -> AppResult<HashMap<String, Vec<String>>> {
    let schema = match pool {
        Pool::Pg(_) => scalar(pool, "SELECT current_schema()::text").await?,
        Pool::My(_) => match conn.base_database() {
            Some(d) => d,
            None => scalar(pool, "SELECT DATABASE()").await?,
        },
        Pool::Lite(_) => "main".to_string(),
    };
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    if schema.is_empty() {
        return Ok(map);
    }
    for mut r in column_rows(pool, &schema, "").await? {
        let col = r.swap_remove(1);
        map.entry(r.swap_remove(0)).or_default().push(col);
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    #[test]
    fn enum_values_parse() {
        assert_eq!(super::enum_values(r#"["male","fe\"male"]"#), ["male", "fe\"male"]);
        assert_eq!(super::enum_values("enum('a','it''s','x,y')"), ["a", "it's", "x,y"]);
        assert_eq!(super::enum_values("enum('')"), [""]);
        assert!(super::enum_values("").is_empty());
        assert!(super::enum_values("varchar(10)").is_empty());
    }

    #[test]
    fn short_counts() {
        for (n, s) in [("-1", ""), ("0", ""), ("860", "860"), ("1000", "1k"), ("2400", "2.4k"), ("12400", "12.4k"), ("1200000", "1.2M")] {
            assert_eq!(super::short_count(n), s);
        }
    }
}
