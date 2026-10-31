//! Views: read definition, generate save SQL; DDL text of sequences and events.
use super::{MY_DDL_WARNING, is_my, lit, text_rows};
use crate::db::Pool;
use crate::db::preview::{Plan, PlannedStatement};
use crate::ddl::{qualified, quote_ident};
use crate::error::{AppError, AppResult};
use crate::model::{Driver, ObjectKind, ViewDef};

const PG_REPLACE_WARNING: &str = "CREATE OR REPLACE VIEW can only add columns at the end: removing, renaming or reordering columns fails on apply (drop and re-create the view instead).";

fn not_found(schema: &str, name: &str) -> AppError {
    AppError::NotFound(format!("The view {schema}.{name} does not exist"))
}

/// Query without surrounding whitespace and trailing `;`.
fn clean(query: &str) -> &str {
    query.trim_end_matches(|c: char| c == ';' || c.is_whitespace()).trim_start()
}

/// Reads a view's query. PG materialized views → `NotSupported` (edited through SQL).
pub async fn load_view(pool: &Pool, schema: &str, name: &str) -> AppResult<ViewDef> {
    let query = match pool {
        Pool::Pg(_) => {
            let rows = text_rows(
                pool,
                "SELECT c.relkind::text, pg_get_viewdef(c.oid, true)
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v', 'm')",
                &[schema, name],
            )
            .await?;
            let r = rows.into_iter().next().ok_or_else(|| not_found(schema, name))?;
            if r[0] == "m" {
                return Err(AppError::NotSupported("Materialized views are edited through SQL".into()));
            }
            r[1].clone()
        }
        Pool::My(_) => text_rows(
            pool,
            "SELECT VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
            &[schema, name],
        )
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| not_found(schema, name))?
        .remove(0),
        Pool::Lite(_) => {
            let sql = format!(
                "SELECT sql FROM {}.sqlite_master WHERE type = 'view' AND name = ?",
                quote_ident(Driver::Sqlite, if schema.is_empty() { "main" } else { schema })
            );
            let create = text_rows(pool, &sql, &[name]).await?.into_iter().next().ok_or_else(|| not_found(schema, name))?.remove(0);
            sqlite_query(&create).to_string()
        }
    };
    Ok(ViewDef { schema: schema.into(), name: name.into(), query: clean(&query).to_string() })
}

/// The SELECT of a SQLite `CREATE VIEW … AS select`: text after the first ` AS ` outside quotes and parentheses.
fn sqlite_query(create: &str) -> &str {
    let b = create.as_bytes();
    let (mut depth, mut quote) = (0, None::<u8>);
    for (i, &c) in b.iter().enumerate() {
        match (quote, c) {
            (Some(q), c) if c == q || (q == b'[' && c == b']') => quote = None,
            (Some(_), _) => {}
            (None, c @ (b'"' | b'\'' | b'`' | b'[')) => quote = Some(c),
            (None, b'(') => depth += 1,
            (None, b')') => depth -= 1,
            (None, c) if depth == 0
                && c.is_ascii_whitespace()
                && b.get(i + 1..i + 3).is_some_and(|w| w.eq_ignore_ascii_case(b"AS"))
                && b.get(i + 3).is_some_and(u8::is_ascii_whitespace) =>
            {
                return create[i + 3..].trim();
            }
            _ => {}
        }
    }
    ""
}

/// `original: None` = create. PG: CREATE OR REPLACE VIEW (ALTER VIEW … RENAME first when renamed);
/// MySQL/MariaDB: CREATE OR REPLACE VIEW (RENAME TABLE first when renamed), non-transactional;
/// SQLite: DROP VIEW IF EXISTS + CREATE VIEW in one transaction.
pub fn plan_view(driver: Driver, original: Option<&ViewDef>, target: &ViewDef) -> AppResult<Plan> {
    let query = clean(&target.query);
    if target.name.trim().is_empty() {
        return Err(AppError::Query("The view needs a name".into()));
    }
    if query.is_empty() {
        return Err(AppError::Query("The view query is empty".into()));
    }
    if original.is_some_and(|o| o.schema != target.schema) {
        return Err(AppError::Query("Moving a view to another schema is not supported".into()));
    }
    let name = qualified(driver, &target.schema, &target.name);
    let renamed = original.filter(|o| o.name != target.name);
    let mut plan = Plan { transactional: !is_my(driver), ..Default::default() };
    let mut push = |sql: String| plan.statements.push(PlannedStatement::new(sql));
    match driver {
        Driver::Postgres => {
            if let Some(o) = renamed {
                push(format!("ALTER VIEW {} RENAME TO {}", qualified(driver, &o.schema, &o.name), quote_ident(driver, &target.name)));
            }
            push(format!("CREATE OR REPLACE VIEW {name} AS\n{query}"));
            if original.is_some() {
                plan.warnings.push(PG_REPLACE_WARNING.into());
            }
        }
        Driver::Mysql | Driver::Mariadb => {
            if let Some(o) = renamed {
                push(format!("RENAME TABLE {} TO {name}", qualified(driver, &o.schema, &o.name)));
            }
            push(format!("CREATE OR REPLACE VIEW {name} AS\n{query}"));
            plan.warnings.push(MY_DDL_WARNING.into());
        }
        Driver::Sqlite => {
            if let Some(o) = original {
                push(format!("DROP VIEW IF EXISTS {}", qualified(driver, &o.schema, &o.name)));
            }
            push(format!("CREATE VIEW {name} AS\n{query}"));
        }
    }
    Ok(plan)
}

/// Re-runnable DDL text shown in a SQL editor: PG sequence (`CREATE SEQUENCE … ;` plus
/// `ALTER SEQUENCE … OWNED BY` and a commented `SELECT setval(…)` with the current value),
/// MySQL/MariaDB event (`SHOW CREATE EVENT`). Other kinds → `NotSupported`.
pub async fn object_ddl(pool: &Pool, kind: ObjectKind, schema: &str, name: &str) -> AppResult<String> {
    match (kind, pool) {
        (ObjectKind::Sequence, Pool::Pg(_)) => sequence_ddl(pool, schema, name).await,
        (ObjectKind::Event, Pool::My(_)) => {
            let sql = format!("SHOW CREATE EVENT {}", qualified(Driver::Mysql, schema, name));
            // Columns: Event, sql_mode, time_zone, Create Event, …
            let create = text_rows(pool, &sql, &[]).await?.into_iter().next().and_then(|r| r.into_iter().nth(3)).unwrap_or_default();
            if create.is_empty() {
                return Err(AppError::NotFound(format!("The event {schema}.{name} does not exist")));
            }
            Ok(format!("{create};"))
        }
        (ObjectKind::Sequence, _) => Err(AppError::NotSupported("Sequences exist only on PostgreSQL".into())),
        (ObjectKind::Event, _) => Err(AppError::NotSupported("Events exist only on MySQL/MariaDB".into())),
        _ => Err(AppError::NotSupported("DDL text is only available for sequences and events".into())),
    }
}

async fn sequence_ddl(pool: &Pool, schema: &str, name: &str) -> AppResult<String> {
    let rows = text_rows(
        pool,
        "SELECT s.data_type::text, s.increment_by::text, s.min_value::text, s.max_value::text, s.start_value::text,
           s.cache_size::text, s.cycle::text, s.last_value::text,
           COALESCE((SELECT quote_ident(tn.nspname) || '.' || quote_ident(tc.relname) || '.' || quote_ident(a.attname)
             FROM pg_depend d JOIN pg_class tc ON tc.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = tc.relnamespace
             JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
             WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_class'::regclass
               AND d.deptype = 'a' LIMIT 1), '')
         FROM pg_sequences s JOIN pg_namespace n ON n.nspname = s.schemaname
         JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = s.sequencename
         WHERE s.schemaname = $1 AND s.sequencename = $2",
        &[schema, name],
    )
    .await?;
    let r = rows.into_iter().next().ok_or_else(|| AppError::NotFound(format!("The sequence {schema}.{name} does not exist")))?;
    let seq = qualified(Driver::Postgres, schema, name);
    let cycle = if r[6] == "true" { "CYCLE" } else { "NO CYCLE" };
    let mut ddl = format!(
        "CREATE SEQUENCE {seq} AS {} INCREMENT BY {} MINVALUE {} MAXVALUE {} START WITH {} CACHE {} {cycle};",
        r[0], r[1], r[2], r[3], r[4], r[5]
    );
    if !r[8].is_empty() {
        ddl += &format!("\nALTER SEQUENCE {seq} OWNED BY {};", r[8]);
    }
    if !r[7].is_empty() {
        ddl += &format!("\n-- SELECT setval({}, {});", lit(Driver::Postgres, &seq), r[7]);
    }
    Ok(ddl)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(schema: &str, name: &str, query: &str) -> ViewDef {
        ViewDef { schema: schema.into(), name: name.into(), query: query.into() }
    }

    fn sqls(plan: &Plan) -> Vec<&str> {
        plan.statements.iter().map(|s| s.sql.as_str()).collect()
    }

    #[test]
    fn postgres() {
        let new = v("public", "v_open", "  SELECT 1 ;\n ; ");
        let plan = plan_view(Driver::Postgres, None, &new).unwrap();
        assert!(plan.transactional && !plan.destructive && plan.warnings.is_empty());
        assert_eq!(sqls(&plan), ["CREATE OR REPLACE VIEW \"public\".\"v_open\" AS\nSELECT 1"]);
        let renamed = v("public", r#"v"x"#, "SELECT 2");
        let plan = plan_view(Driver::Postgres, Some(&new), &renamed).unwrap();
        assert_eq!(
            sqls(&plan),
            [r#"ALTER VIEW "public"."v_open" RENAME TO "v""x""#, "CREATE OR REPLACE VIEW \"public\".\"v\"\"x\" AS\nSELECT 2"]
        );
        assert_eq!(plan.warnings, [PG_REPLACE_WARNING]);
        assert_eq!(plan_view(Driver::Postgres, Some(&new), &new).unwrap().statements.len(), 1);
    }

    #[test]
    fn mysql_and_sqlite() {
        let o = v("shop", "v", "SELECT 1");
        for d in [Driver::Mysql, Driver::Mariadb] {
            let plan = plan_view(d, Some(&o), &v("shop", "v`2", "SELECT 2;")).unwrap();
            assert!(!plan.transactional && plan.warnings == [MY_DDL_WARNING]);
            assert_eq!(sqls(&plan), ["RENAME TABLE `shop`.`v` TO `shop`.`v``2`", "CREATE OR REPLACE VIEW `shop`.`v``2` AS\nSELECT 2"]);
        }
        let o = v("main", "v", "SELECT 1");
        let plan = plan_view(Driver::Sqlite, Some(&o), &v("main", "w", "SELECT 2")).unwrap();
        assert!(plan.transactional);
        assert_eq!(sqls(&plan), [r#"DROP VIEW IF EXISTS "v""#, "CREATE VIEW \"w\" AS\nSELECT 2"]);
        assert_eq!(sqls(&plan_view(Driver::Sqlite, None, &o).unwrap()), ["CREATE VIEW \"v\" AS\nSELECT 1"]);
    }

    #[test]
    fn validation() {
        let err = |o: Option<&ViewDef>, t: &ViewDef| match plan_view(Driver::Postgres, o, t) {
            Err(AppError::Query(m)) => m,
            other => panic!("{other:?}"),
        };
        assert_eq!(err(None, &v("s", " ", "SELECT 1")), "The view needs a name");
        assert_eq!(err(None, &v("s", "v", " ;; ")), "The view query is empty");
        assert_eq!(err(Some(&v("a", "v", "SELECT 1")), &v("b", "v", "SELECT 1")), "Moving a view to another schema is not supported");
    }

    #[test]
    fn sqlite_view_query() {
        assert_eq!(sqlite_query("CREATE VIEW v AS SELECT 1"), "SELECT 1");
        assert_eq!(sqlite_query("create view \"has as in it\"(a, \"b as c\")\n as\nselect x as a, y from t"), "select x as a, y from t");
        assert_eq!(sqlite_query("CREATE VIEW [x as y] AS SELECT 'a AS b'"), "SELECT 'a AS b'");
        assert_eq!(sqlite_query("CREATE VIEW v"), "");
    }
}
