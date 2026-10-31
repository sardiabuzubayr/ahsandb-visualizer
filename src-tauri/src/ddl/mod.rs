//! DDL and data-edit SQL generation per dialect, plus reading a table's full definition.
mod load;
mod schema;

use std::collections::BTreeMap;

use serde_json::Value;

use crate::db::preview::{Plan, PlannedStatement};
use crate::error::{AppError, AppResult};
use crate::model::{Cell, Driver, ObjectKind, RowChange};

pub use load::load_table;
pub use schema::plan_schema_changes;

/// Quotes an identifier for the dialect (`"x"` with `""` escape; MySQL/MariaDB `` `x` `` with doubled backticks).
pub fn quote_ident(driver: Driver, ident: &str) -> String {
    match driver {
        Driver::Mysql | Driver::Mariadb => format!("`{}`", ident.replace('`', "``")),
        _ => format!("\"{}\"", ident.replace('"', "\"\"")),
    }
}

/// Renders a cell as a SQL literal: NULL, numbers as-is (validated numeric text), strings quoted with
/// the dialect's escaping (MySQL/MariaDB also escapes backslashes).
/// Numeric-looking strings stay strings: the database casts them to the column type.
pub fn literal(driver: Driver, value: &Cell) -> String {
    match value {
        Value::Null => "NULL".into(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) if driver == Driver::Sqlite => if *b { "1" } else { "0" }.into(),
        Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        Value::String(s) => quote_str(driver, s),
        other => quote_str(driver, &other.to_string()),
    }
}

fn quote_str(driver: Driver, s: &str) -> String {
    let s = s.replace('\'', "''");
    match driver {
        // shortcut: assumes the default sql_mode (no NO_BACKSLASH_ESCAPES); with it, `\\` would be stored doubled.
        Driver::Mysql | Driver::Mariadb => format!("'{}'", s.replace('\\', "\\\\")),
        // PostgreSQL ≥ 9.1 has standard_conforming_strings on: backslashes are literal.
        _ => format!("'{s}'"),
    }
}

/// `schema.name`, or just `name` when there is no schema (SQLite `main`).
pub(crate) fn qualified(driver: Driver, schema: &str, name: &str) -> String {
    if schema.is_empty() || (driver == Driver::Sqlite && schema == "main") {
        quote_ident(driver, name)
    } else {
        format!("{}.{}", quote_ident(driver, schema), quote_ident(driver, name))
    }
}

/// UPDATE/INSERT/DELETE for grid edits with literal values; UPDATE/DELETE keyed by `key` (all PK columns)
/// with `expect_rows: Some(1)`. Always transactional. Empty key on update/delete → `Query` error.
pub fn plan_row_changes(driver: Driver, schema: &str, table: &str, changes: &[RowChange]) -> AppResult<Plan> {
    let t = qualified(driver, schema, table);
    let q = |c: &str| quote_ident(driver, c);
    let where_key = |key: &BTreeMap<String, Cell>| -> AppResult<String> {
        if key.is_empty() {
            return Err(AppError::Query("Row has no primary key".into()));
        }
        Ok(key
            .iter()
            .map(|(k, v)| if v.is_null() { format!("{} IS NULL", q(k)) } else { format!("{} = {}", q(k), literal(driver, v)) })
            .collect::<Vec<_>>()
            .join(" AND "))
    };
    let mut plan = Plan { transactional: true, ..Default::default() };
    for change in changes {
        let sql = match change {
            RowChange::Update { key, values } => {
                let w = where_key(key)?;
                if values.is_empty() {
                    continue;
                }
                let sets: Vec<String> = values.iter().map(|(k, v)| format!("{} = {}", q(k), literal(driver, v))).collect();
                format!("UPDATE {t} SET {} WHERE {w}", sets.join(", "))
            }
            RowChange::Insert { values } if values.is_empty() => match driver {
                Driver::Mysql | Driver::Mariadb => format!("INSERT INTO {t} () VALUES ()"),
                _ => format!("INSERT INTO {t} DEFAULT VALUES"),
            },
            RowChange::Insert { values } => {
                let cols: Vec<String> = values.keys().map(|k| q(k)).collect();
                let vals: Vec<String> = values.values().map(|v| literal(driver, v)).collect();
                format!("INSERT INTO {t} ({}) VALUES ({})", cols.join(", "), vals.join(", "))
            }
            RowChange::Delete { key } => {
                plan.destructive = true;
                format!("DELETE FROM {t} WHERE {}", where_key(key)?)
            }
        };
        plan.statements.push(PlannedStatement { expect_rows: Some(1), ..PlannedStatement::new(sql) });
    }
    Ok(plan)
}

/// DROP TABLE / VIEW / SEQUENCE (PG) / EVENT (MySQL/MariaDB), no CASCADE. Destructive.
pub fn plan_drop(driver: Driver, kind: ObjectKind, schema: &str, name: &str) -> AppResult<Plan> {
    let mysql = matches!(driver, Driver::Mysql | Driver::Mariadb);
    let what = match kind {
        ObjectKind::Table => "TABLE",
        ObjectKind::View => "VIEW",
        ObjectKind::Function | ObjectKind::Procedure => {
            return Err(AppError::NotSupported("Routines are dropped from the routine editor".into()));
        }
        ObjectKind::Trigger => return Err(AppError::NotSupported("Triggers are dropped with plan_trigger".into())),
        ObjectKind::Sequence if driver == Driver::Postgres => "SEQUENCE",
        ObjectKind::Event if mysql => "EVENT",
        ObjectKind::Sequence => return Err(AppError::NotSupported("Sequences exist only on PostgreSQL".into())),
        ObjectKind::Event => return Err(AppError::NotSupported("Events exist only on MySQL/MariaDB".into())),
    };
    Ok(Plan {
        statements: vec![PlannedStatement::new(format!("DROP {what} {}", qualified(driver, schema, name)))],
        transactional: !mysql,
        destructive: true,
        warnings: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ALL: [Driver; 4] = [Driver::Postgres, Driver::Mysql, Driver::Mariadb, Driver::Sqlite];

    #[test]
    fn idents() {
        assert_eq!(quote_ident(Driver::Postgres, r#"we"ird"#), r#""we""ird""#);
        assert_eq!(quote_ident(Driver::Mysql, "we`ird"), "`we``ird`");
        assert_eq!(qualified(Driver::Sqlite, "main", "t"), r#""t""#);
        assert_eq!(qualified(Driver::Sqlite, "aux", "t"), r#""aux"."t""#);
        assert_eq!(qualified(Driver::Mariadb, "db", "t"), "`db`.`t`");
    }

    #[test]
    fn literals() {
        for d in ALL {
            assert_eq!(literal(d, &json!(null)), "NULL");
            assert_eq!(literal(d, &json!(42)), "42");
            assert_eq!(literal(d, &json!(-1.5)), "-1.5");
            assert_eq!(literal(d, &json!("12.50")), "'12.50'");
            assert_eq!(literal(d, &json!("")), "''");
            assert_eq!(literal(d, &json!("it's")), "'it''s'");
            assert_eq!(literal(d, &json!("'; DROP TABLE x;--")), "'''; DROP TABLE x;--'");
            assert_eq!(literal(d, &json!("日本語 ✓ 🚀")), "'日本語 ✓ 🚀'");
            assert_eq!(literal(d, &json!("a\nb")), "'a\nb'");
        }
        assert_eq!(literal(Driver::Postgres, &json!(r"C:\dir\'x")), r"'C:\dir\''x'");
        assert_eq!(literal(Driver::Sqlite, &json!(r"a\b")), r"'a\b'");
        assert_eq!(literal(Driver::Mysql, &json!(r"C:\dir\'x")), r"'C:\\dir\\''x'");
        assert_eq!(literal(Driver::Mariadb, &json!(r"\")), r"'\\'");
    }

    #[test]
    fn row_changes() {
        let key = |id: i64| BTreeMap::from([("id".to_string(), json!(id))]);
        let changes = vec![
            RowChange::Update { key: key(1), values: BTreeMap::from([("name".into(), json!("O'Neil")), ("note".into(), json!(null))]) },
            RowChange::Insert { values: BTreeMap::from([("name".into(), json!("x")), ("qty".into(), json!(3))]) },
            RowChange::Insert { values: BTreeMap::new() },
            RowChange::Delete { key: BTreeMap::from([("a".into(), json!("k")), ("b".into(), json!(null))]) },
            RowChange::Update { key: key(2), values: BTreeMap::new() },
        ];
        let p = plan_row_changes(Driver::Postgres, "public", "t", &changes).unwrap();
        let sql: Vec<&str> = p.statements.iter().map(|s| s.sql.as_str()).collect();
        assert_eq!(sql, [
            r#"UPDATE "public"."t" SET "name" = 'O''Neil', "note" = NULL WHERE "id" = 1"#,
            r#"INSERT INTO "public"."t" ("name", "qty") VALUES ('x', 3)"#,
            r#"INSERT INTO "public"."t" DEFAULT VALUES"#,
            r#"DELETE FROM "public"."t" WHERE "a" = 'k' AND "b" IS NULL"#,
        ]);
        assert!(p.statements.iter().all(|s| s.expect_rows == Some(1) && s.display == s.sql));
        assert!(p.transactional && p.destructive);

        let p = plan_row_changes(Driver::Mysql, "shop", "t", &changes[..3]).unwrap();
        assert_eq!(p.statements[0].sql, r"UPDATE `shop`.`t` SET `name` = 'O''Neil', `note` = NULL WHERE `id` = 1");
        assert_eq!(p.statements[2].sql, "INSERT INTO `shop`.`t` () VALUES ()");
        assert!(p.transactional && !p.destructive);
        let p = plan_row_changes(Driver::Sqlite, "main", "t", &changes[3..4]).unwrap();
        assert_eq!(p.statements[0].sql, r#"DELETE FROM "t" WHERE "a" = 'k' AND "b" IS NULL"#);
    }

    #[test]
    fn row_changes_need_key() {
        for change in [
            RowChange::Update { key: BTreeMap::new(), values: BTreeMap::from([("a".into(), json!(1))]) },
            RowChange::Delete { key: BTreeMap::new() },
        ] {
            let r = plan_row_changes(Driver::Sqlite, "main", "t", &[change]);
            assert!(matches!(r, Err(AppError::Query(m)) if m == "Row has no primary key"));
        }
    }

    #[test]
    fn drops() {
        let p = plan_drop(Driver::Postgres, ObjectKind::Table, "public", "orders").unwrap();
        assert_eq!(p.statements[0].sql, r#"DROP TABLE "public"."orders""#);
        assert!(p.destructive && p.transactional);
        let p = plan_drop(Driver::Mariadb, ObjectKind::View, "shop", "v").unwrap();
        assert_eq!(p.statements[0].sql, "DROP VIEW `shop`.`v`");
        assert!(!p.transactional);
        let p = plan_drop(Driver::Sqlite, ObjectKind::View, "main", "v").unwrap();
        assert_eq!(p.statements[0].sql, r#"DROP VIEW "v""#);
        assert!(matches!(plan_drop(Driver::Postgres, ObjectKind::Function, "public", "f"), Err(AppError::NotSupported(_))));
    }

    #[test]
    fn plan_drop_sequence_event() {
        let p = plan_drop(Driver::Postgres, ObjectKind::Sequence, "public", "s").unwrap();
        assert_eq!(p.statements.iter().map(|s| s.sql.as_str()).collect::<Vec<_>>(), [r#"DROP SEQUENCE "public"."s""#]);
        assert!(p.transactional && p.destructive);
        for d in [Driver::Mysql, Driver::Mariadb] {
            let p = plan_drop(d, ObjectKind::Event, "shop", "e`1").unwrap();
            assert_eq!(p.statements.iter().map(|s| s.sql.as_str()).collect::<Vec<_>>(), ["DROP EVENT `shop`.`e``1`"]);
            assert!(!p.transactional && p.destructive);
            assert!(matches!(plan_drop(d, ObjectKind::Sequence, "shop", "s"), Err(AppError::NotSupported(_))));
        }
        for d in [Driver::Postgres, Driver::Sqlite] {
            assert!(matches!(plan_drop(d, ObjectKind::Event, "main", "e"), Err(AppError::NotSupported(_))));
        }
        assert!(matches!(plan_drop(Driver::Sqlite, ObjectKind::Sequence, "main", "s"), Err(AppError::NotSupported(_))));
    }
}
