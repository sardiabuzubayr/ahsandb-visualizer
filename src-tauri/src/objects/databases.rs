//! Databases: CREATE / RENAME / DROP DATABASE plans. All non-transactional (PostgreSQL can't run
//! them in a transaction block; MySQL/MariaDB DDL commits anyway). SQLite → `NotSupported`.
use super::{is_my, not_supported_sqlite};
use crate::db::preview::{Plan, PlannedStatement};
use crate::ddl::quote_ident;
use crate::error::{AppError, AppResult};
use crate::model::{DatabaseDef, Driver};

const DROP_WARNING: &str = "Dropping a database deletes all of its data permanently and can't be undone.";

/// System databases that are never renamed or dropped (`template0/1`, `postgres`; `mysql`,
/// `information_schema`, `performance_schema`, `sys`).
pub fn is_system(driver: Driver, name: &str) -> bool {
    match driver {
        Driver::Postgres => matches!(name, "postgres" | "template0" | "template1"),
        // information_schema and performance_schema match case-insensitively on every server.
        Driver::Mysql | Driver::Mariadb => {
            ["mysql", "information_schema", "performance_schema", "sys"].iter().any(|s| s.eq_ignore_ascii_case(name))
        }
        Driver::Sqlite => false,
    }
}

/// `CREATE DATABASE` (PG: `OWNER`; MySQL/MariaDB: `CHARACTER SET` / `COLLATE`). Empty name → `Query`.
pub fn plan_create_database(driver: Driver, def: &DatabaseDef) -> AppResult<Plan> {
    if driver == Driver::Sqlite {
        return not_supported_sqlite("databases to create (each file is one database)");
    }
    let mut sql = format!("CREATE DATABASE {}", quote_ident(driver, required(&def.name)?));
    let opt = |v: &Option<String>| v.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    if is_my(driver) {
        // Charset and collation names can't be quoted as identifiers, so only plain names are accepted.
        for (kw, v) in [("CHARACTER SET", opt(&def.charset)), ("COLLATE", opt(&def.collation))] {
            let Some(v) = v else { continue };
            if !v.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return Err(AppError::Query(format!("Invalid {} name: {v}", kw.to_lowercase())));
            }
            sql += &format!(" {kw} {v}");
        }
    } else if let Some(owner) = opt(&def.owner) {
        sql += &format!(" OWNER {}", quote_ident(driver, &owner));
    }
    Ok(plan(sql, false))
}

/// PG `ALTER DATABASE … RENAME TO`. `base` = the database the main pool is connected to, which
/// can't be renamed from this connection (`Query` error explaining to change the Database field).
/// MySQL/MariaDB have no rename → `NotSupported` with an explanation. System databases → `Query`.
pub fn plan_rename_database(driver: Driver, base: Option<&str>, from: &str, to: &str) -> AppResult<Plan> {
    match driver {
        Driver::Sqlite => return not_supported_sqlite("databases to rename"),
        Driver::Mysql | Driver::Mariadb => {
            return Err(AppError::NotSupported(
                "MySQL/MariaDB can't rename a database. Create a new database and move the tables into it instead.".into(),
            ));
        }
        Driver::Postgres => {}
    }
    let (from, to) = (required(from)?, required(to)?);
    if from == to {
        return Err(AppError::Query("The new name is the same as the current one".into()));
    }
    guard(driver, base, from, "renamed")?;
    Ok(plan(format!("ALTER DATABASE {} RENAME TO {}", quote_ident(driver, from), quote_ident(driver, to)), false))
}

/// `DROP DATABASE` (no `IF EXISTS`, no `FORCE`), destructive, with a warning that it can't be
/// undone. PG can't drop `base` (the connected database) → `Query`. System databases → `Query`.
pub fn plan_drop_database(driver: Driver, base: Option<&str>, name: &str) -> AppResult<Plan> {
    if driver == Driver::Sqlite {
        return not_supported_sqlite("databases to drop (delete the file instead)");
    }
    let name = required(name)?;
    guard(driver, base, name, "dropped")?;
    let mut p = plan(format!("DROP DATABASE {}", quote_ident(driver, name)), true);
    p.warnings.push(DROP_WARNING.into());
    Ok(p)
}

fn plan(sql: String, destructive: bool) -> Plan {
    Plan { statements: vec![PlannedStatement::new(sql)], transactional: false, destructive, warnings: vec![] }
}

/// The trimmed name, or `Query` when it is empty.
fn required(name: &str) -> AppResult<&str> {
    let n = name.trim();
    if n.is_empty() { Err(AppError::Query("The database needs a name".into())) } else { Ok(n) }
}

/// System databases are refused everywhere; PG also refuses the connection's own database (a session
/// can't rename or drop the database it is connected to). MySQL has no such limit.
fn guard(driver: Driver, base: Option<&str>, name: &str, verb: &str) -> AppResult<()> {
    if is_system(driver, name) {
        return Err(AppError::Query(format!("{name} is a system database and can't be {verb}")));
    }
    if driver == Driver::Postgres && base == Some(name) {
        return Err(AppError::Query(format!(
            "{name} is the database this connection is connected to, so it can't be {verb} from here. \
             Change the connection's Database field to another database first."
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(name: &str) -> DatabaseDef {
        DatabaseDef { name: name.into(), owner: None, charset: None, collation: None }
    }

    fn sql(p: &Plan) -> &str {
        assert_eq!(p.statements.len(), 1);
        assert!(!p.transactional);
        &p.statements[0].sql
    }

    fn query_err<T: std::fmt::Debug>(r: AppResult<T>) -> String {
        match r {
            Err(AppError::Query(m)) => m,
            other => panic!("expected Query error, got {other:?}"),
        }
    }

    #[test]
    fn system_databases() {
        for n in ["postgres", "template0", "template1"] {
            assert!(is_system(Driver::Postgres, n));
            assert!(!is_system(Driver::Mysql, n));
        }
        assert!(!is_system(Driver::Postgres, "Postgres"));
        for n in ["mysql", "information_schema", "INFORMATION_SCHEMA", "performance_schema", "sys"] {
            assert!(is_system(Driver::Mysql, n) && is_system(Driver::Mariadb, n));
        }
        assert!(!is_system(Driver::Mariadb, "shop") && !is_system(Driver::Sqlite, "main"));
    }

    #[test]
    fn create_postgres() {
        let p = plan_create_database(Driver::Postgres, &def(" shop ")).unwrap();
        assert_eq!(sql(&p), "CREATE DATABASE \"shop\"");
        assert!(!p.destructive);
        let with_owner = DatabaseDef { owner: Some("app \"o\"".into()), charset: Some("x;".into()), ..def("my db\"") };
        assert_eq!(sql(&plan_create_database(Driver::Postgres, &with_owner).unwrap()), "CREATE DATABASE \"my db\"\"\" OWNER \"app \"\"o\"\"\"");
        let blank_owner = DatabaseDef { owner: Some("  ".into()), ..def("a") };
        assert_eq!(sql(&plan_create_database(Driver::Postgres, &blank_owner).unwrap()), "CREATE DATABASE \"a\"");
        query_err(plan_create_database(Driver::Postgres, &def("  ")));
    }

    #[test]
    fn create_mysql() {
        for d in [Driver::Mysql, Driver::Mariadb] {
            assert_eq!(sql(&plan_create_database(d, &def("my `db`")).unwrap()), "CREATE DATABASE `my ``db```");
            let full = DatabaseDef { charset: Some("utf8mb4".into()), collation: Some(" utf8mb4_unicode_ci ".into()), owner: Some("x".into()), ..def("shop") };
            assert_eq!(sql(&plan_create_database(d, &full).unwrap()), "CREATE DATABASE `shop` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
            let only_coll = DatabaseDef { collation: Some("latin1_bin".into()), ..def("shop") };
            assert_eq!(sql(&plan_create_database(d, &only_coll).unwrap()), "CREATE DATABASE `shop` COLLATE latin1_bin");
            for bad in ["utf8; DROP DATABASE x", "utf-8", "`x`"] {
                query_err(plan_create_database(d, &DatabaseDef { charset: Some(bad.into()), ..def("shop") }));
                query_err(plan_create_database(d, &DatabaseDef { collation: Some(bad.into()), ..def("shop") }));
            }
            query_err(plan_create_database(d, &def("")));
        }
    }

    #[test]
    fn rename() {
        let p = plan_rename_database(Driver::Postgres, Some("postgres"), "old \"x\"", " new name ").unwrap();
        assert_eq!(sql(&p), "ALTER DATABASE \"old \"\"x\"\"\" RENAME TO \"new name\"");
        assert!(!p.destructive);
        assert!(query_err(plan_rename_database(Driver::Postgres, None, "a", " a ")).contains("same"));
        query_err(plan_rename_database(Driver::Postgres, None, "a", " "));
        assert!(query_err(plan_rename_database(Driver::Postgres, Some("shop"), "shop", "b")).contains("Database field"));
        assert!(query_err(plan_rename_database(Driver::Postgres, Some("shop"), "template1", "b")).contains("system"));
        for d in [Driver::Mysql, Driver::Mariadb] {
            match plan_rename_database(d, None, "a", "b") {
                Err(AppError::NotSupported(m)) => assert!(m.contains("can't rename") && m.contains("move the tables")),
                other => panic!("{other:?}"),
            }
        }
        assert!(matches!(plan_rename_database(Driver::Sqlite, None, "a", "b"), Err(AppError::NotSupported(_))));
    }

    #[test]
    fn drop() {
        let p = plan_drop_database(Driver::Postgres, Some("postgres"), "my \"db\"").unwrap();
        assert_eq!(sql(&p), "DROP DATABASE \"my \"\"db\"\"\"");
        assert!(p.destructive);
        assert_eq!(p.warnings, [DROP_WARNING]);
        assert!(query_err(plan_drop_database(Driver::Postgres, Some("shop"), "shop")).contains("Database field"));
        assert!(query_err(plan_drop_database(Driver::Postgres, Some("shop"), "postgres")).contains("system"));
        query_err(plan_drop_database(Driver::Postgres, None, ""));
        for d in [Driver::Mysql, Driver::Mariadb] {
            let p = plan_drop_database(d, Some("shop"), "shop").unwrap(); // MySQL may drop the base database
            assert_eq!(sql(&p), "DROP DATABASE `shop`");
            assert!(p.destructive && p.warnings == [DROP_WARNING]);
            assert_eq!(sql(&plan_drop_database(d, None, "a`b c").unwrap()), "DROP DATABASE `a``b c`");
            assert!(query_err(plan_drop_database(d, None, "mysql")).contains("system"));
            query_err(plan_drop_database(d, None, "Performance_Schema"));
        }
        assert!(matches!(plan_drop_database(Driver::Sqlite, None, "main"), Err(AppError::NotSupported(_))));
        assert!(matches!(plan_create_database(Driver::Sqlite, &def("x")), Err(AppError::NotSupported(_))));
    }
}
