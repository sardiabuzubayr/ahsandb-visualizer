//! Triggers: read definition, generate save/drop SQL.
use super::{MY_DDL_WARNING, is_my, not_sql, text_rows};
use crate::db::Pool;
use crate::db::preview::{Plan, PlannedStatement};
use crate::ddl::{qualified, quote_ident};
use crate::error::{AppError, AppResult};
use crate::model::{Driver, Trigger};

const TIMINGS: [&str; 3] = ["BEFORE", "AFTER", "INSTEAD OF"];
const EVENTS: [&str; 4] = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"];

fn not_found(schema: &str, name: &str) -> AppError {
    AppError::NotFound(format!("The trigger {schema}.{name} does not exist"))
}

/// Reads a trigger into the editor model. PG trigger names are unique per table, not per schema:
/// the first match (lowest oid) is returned.
pub async fn load_trigger(pool: &Pool, schema: &str, name: &str) -> AppResult<Trigger> {
    match pool {
        Pool::Pg(_) => load_pg(pool, schema, name).await,
        Pool::My(_) => {
            let rows = text_rows(
                pool,
                "SELECT EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
                 FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME = ?",
                &[schema, name],
            )
            .await?;
            let r = rows.into_iter().next().ok_or_else(|| not_found(schema, name))?;
            Ok(Trigger {
                schema: schema.into(),
                name: name.into(),
                table: r[0].clone(),
                timing: r[1].clone(),
                events: vec![r[2].clone()],
                for_each_row: true,
                condition: None,
                body: r[3].trim().to_string(),
            })
        }
        Pool::Lite(_) => {
            let sql = format!(
                "SELECT tbl_name, sql FROM {}.sqlite_master WHERE type = 'trigger' AND name = ?",
                quote_ident(Driver::Sqlite, if schema.is_empty() { "main" } else { schema })
            );
            let r = text_rows(pool, &sql, &[name]).await?.into_iter().next().ok_or_else(|| not_found(schema, name))?;
            let (timing, event, condition, body) = parse_sqlite(&r[1], name);
            Ok(Trigger {
                schema: schema.into(),
                name: name.into(),
                table: r[0].clone(),
                timing,
                events: vec![event],
                for_each_row: true,
                condition,
                body,
            })
        }
    }
}

async fn load_pg(pool: &Pool, schema: &str, name: &str) -> AppResult<Trigger> {
    // shortcut: same-named triggers on other tables of the schema are not reachable; add the table to the key if users ask.
    let rows = text_rows(
        pool,
        "SELECT c.relname::text, t.tgtype::text, (t.tgqual IS NOT NULL)::text, pg_get_triggerdef(t.oid)
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal AND n.nspname = $1 AND t.tgname = $2
         ORDER BY t.oid LIMIT 1",
        &[schema, name],
    )
    .await?;
    let r = rows.into_iter().next().ok_or_else(|| not_found(schema, name))?;
    let bits: i32 = r[1].parse().unwrap_or_default();
    let timing = if bits & 64 != 0 {
        "INSTEAD OF"
    } else if bits & 2 != 0 {
        "BEFORE"
    } else {
        "AFTER"
    };
    let events = [(4, "INSERT"), (16, "UPDATE"), (8, "DELETE"), (32, "TRUNCATE")]
        .iter()
        .filter(|(b, _)| bits & b != 0)
        .map(|(_, e)| e.to_string())
        .collect();
    let (condition, body) = split_pg_triggerdef(&r[3], r[2] == "true");
    Ok(Trigger {
        schema: schema.into(),
        name: name.into(),
        table: r[0].clone(),
        timing: timing.into(),
        events,
        for_each_row: bits & 1 != 0,
        condition,
        body,
    })
}

/// `(WHEN condition, function call)` from `pg_get_triggerdef` output.
// shortcut: text search, so ` EXECUTE FUNCTION ` inside a string literal of the condition/arguments confuses it;
// read tgfoid/tgargs if that ever happens.
fn split_pg_triggerdef(def: &str, has_when: bool) -> (Option<String>, String) {
    let Some((at, len)) = [" EXECUTE FUNCTION ", " EXECUTE PROCEDURE "].iter().find_map(|k| def.rfind(k).map(|i| (i, k.len()))) else {
        return (None, String::new());
    };
    let head = &def[..at];
    let condition = has_when
        .then(|| head.find(" WHEN (").map(|w| strip_parens(&head[w + 7..head.len().saturating_sub(1)])))
        .flatten();
    (condition, def[at + len..].trim().to_string())
}

/// Removes one pair of parentheses wrapping the whole expression (PG prints `WHEN ((a > b))`).
fn strip_parens(s: &str) -> String {
    let s = s.trim();
    if s.starts_with('(') && s.ends_with(')') {
        let mut depth = 0;
        let closes_at_end = s.char_indices().all(|(i, c)| {
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            depth > 0 || i == s.len() - 1
        });
        if closes_at_end {
            return s[1..s.len() - 1].trim().to_string();
        }
    }
    s.to_string()
}

/// Byte index of `w` as a whole word in the (upper-cased) `u`, at or after `from`.
fn word(u: &str, w: &str, from: usize) -> Option<usize> {
    let ident = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    u[from..]
        .match_indices(w)
        .map(|(i, _)| from + i)
        .find(|&i| !ident(u[..i].chars().next_back()) && !ident(u[i + w.len()..].chars().next()))
}

/// `(timing, event, WHEN condition, body)` from a SQLite `CREATE TRIGGER` statement.
// shortcut: keyword search after the trigger name; `UPDATE OF cols` loses its columns and keywords inside
// a quoted table name or the WHEN text can confuse it. Use a tokenizer if users hit it.
fn parse_sqlite(sql: &str, name: &str) -> (String, String, Option<String>, String) {
    let u = sql.to_ascii_uppercase();
    let after_kw = word(&u, "TRIGGER", 0).map_or(0, |i| i + 7);
    let start = sql[after_kw..].find(name).map_or(after_kw, |i| after_kw + i + name.len());
    let begin = word(&u, "BEGIN", start).unwrap_or(sql.len());
    let head = &u[..begin];
    let timing = if word(head, "INSTEAD", start).is_some() {
        "INSTEAD OF"
    } else if word(head, "AFTER", start).is_some() {
        "AFTER"
    } else {
        "BEFORE"
    };
    let event = ["INSERT", "UPDATE", "DELETE"].into_iter().filter_map(|e| word(head, e, start).map(|i| (i, e))).min().map_or("", |(_, e)| e);
    let condition = word(head, "WHEN", start).map(|i| sql[i + 4..begin].trim().to_string()).filter(|c| !c.is_empty());
    (timing.into(), event.into(), condition, sql[begin..].trim().to_string())
}

fn validate(d: Driver, t: &Trigger) -> AppResult<()> {
    if d == Driver::Redis {
        return not_sql();
    }
    let err = |m: &str| Err(AppError::Query(m.into()));
    if t.name.trim().is_empty() {
        return err("The trigger needs a name");
    }
    if t.table.trim().is_empty() {
        return err("The trigger needs a table");
    }
    if t.body.trim().is_empty() {
        return err("The trigger body is empty");
    }
    if !TIMINGS.contains(&t.timing.as_str()) {
        return Err(AppError::Query(format!("Unknown trigger timing: {}", t.timing)));
    }
    if t.timing == "INSTEAD OF" && is_my(d) {
        return err("MySQL/MariaDB do not support INSTEAD OF triggers");
    }
    if t.events.is_empty() {
        return err("The trigger needs at least one event");
    }
    if let Some(e) = t.events.iter().find(|e| !EVENTS.contains(&e.as_str())) {
        return Err(AppError::Query(format!("Unknown trigger event: {e}")));
    }
    let truncate = t.events.iter().any(|e| e == "TRUNCATE");
    if d != Driver::Postgres {
        if truncate {
            return err("TRUNCATE triggers exist only on PostgreSQL");
        }
        if t.events.len() != 1 {
            return err("MySQL/MariaDB/SQLite triggers fire on exactly one event");
        }
    }
    if truncate && t.for_each_row {
        return err("TRUNCATE triggers must be FOR EACH STATEMENT");
    }
    Ok(())
}

fn create_sql(d: Driver, t: &Trigger, or_replace: bool) -> String {
    let events = t.events.join(" OR ");
    let replace = if or_replace { "OR REPLACE " } else { "" };
    let when = t.condition.as_deref().map(|c| if d == Driver::Postgres { format!(" WHEN ({c})") } else { format!(" WHEN {c}") });
    let when = when.unwrap_or_default();
    match d {
        Driver::Postgres => {
            let each = if t.for_each_row { "ROW" } else { "STATEMENT" };
            format!(
                "CREATE TRIGGER {} {} {events} ON {} FOR EACH {each}{when} EXECUTE FUNCTION {}",
                quote_ident(d, &t.name),
                t.timing,
                qualified(d, &t.schema, &t.table),
                t.body
            )
        }
        // SQLite: the table of a trigger can't be schema-qualified (it lives in the trigger's schema).
        Driver::Sqlite | Driver::Redis => format!(
            "CREATE TRIGGER {} {} {events} ON {} FOR EACH ROW{when}\n{}",
            qualified(d, &t.schema, &t.name),
            t.timing,
            quote_ident(d, &t.table),
            t.body
        ),
        Driver::Mysql | Driver::Mariadb => format!(
            "CREATE {replace}TRIGGER {} {} {events} ON {} FOR EACH ROW\n{}",
            qualified(d, &t.schema, &t.name),
            t.timing,
            qualified(d, &t.schema, &t.table),
            t.body
        ),
    }
}

fn drop_sql(d: Driver, t: &Trigger, if_exists: bool) -> String {
    let ie = if if_exists { "IF EXISTS " } else { "" };
    match d {
        Driver::Postgres => format!("DROP TRIGGER {ie}{} ON {}", quote_ident(d, &t.name), qualified(d, &t.schema, &t.table)),
        _ => format!("DROP TRIGGER {ie}{}", qualified(d, &t.schema, &t.name)),
    }
}

/// `original: None` = create; `target: None` = drop (destructive); both = replace.
/// PG/SQLite: DROP TRIGGER IF EXISTS + CREATE in one transaction. MariaDB: CREATE OR REPLACE TRIGGER
/// (DROP old first when renamed or moved to another table). MySQL: DROP + CREATE, non-transactional,
/// with a warning carrying the original definition.
pub fn plan_trigger(driver: Driver, original: Option<&Trigger>, target: Option<&Trigger>) -> AppResult<Plan> {
    let mut plan = Plan { transactional: !is_my(driver), ..Default::default() };
    let Some(target) = target else {
        let o = original.ok_or_else(|| AppError::Query("Nothing to drop".into()))?;
        plan.statements.push(PlannedStatement::new(drop_sql(driver, o, false)));
        plan.destructive = true;
        return Ok(plan);
    };
    let t = Trigger {
        body: target.body.trim().to_string(),
        condition: target.condition.as_deref().map(str::trim).filter(|c| !c.is_empty()).map(str::to_string),
        ..target.clone()
    };
    validate(driver, &t)?;
    let push = |plan: &mut Plan, sql: String| plan.statements.push(PlannedStatement::new(sql));
    match driver {
        // `validate` already rejected Redis.
        Driver::Postgres | Driver::Sqlite | Driver::Redis => {
            if let Some(o) = original {
                push(&mut plan, drop_sql(driver, o, true));
            }
            push(&mut plan, create_sql(driver, &t, false));
        }
        Driver::Mariadb => {
            if let Some(o) = original.filter(|o| o.name != t.name || o.table != t.table || o.schema != t.schema) {
                push(&mut plan, drop_sql(driver, o, true));
            }
            push(&mut plan, create_sql(driver, &t, true));
            plan.warnings.push(MY_DDL_WARNING.into());
        }
        Driver::Mysql => {
            if let Some(o) = original {
                push(&mut plan, drop_sql(driver, o, true));
                plan.warnings.push(format!(
                    "MySQL has no CREATE OR REPLACE for triggers: the trigger is dropped first, so if CREATE fails it stays dropped. Original definition to restore it:\n{}",
                    create_sql(driver, o, false)
                ));
            }
            push(&mut plan, create_sql(driver, &t, false));
            plan.warnings.push(MY_DDL_WARNING.into());
        }
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trg(schema: &str, body: &str) -> Trigger {
        Trigger {
            schema: schema.into(),
            name: "trg_touch".into(),
            table: "orders".into(),
            timing: "BEFORE".into(),
            events: vec!["INSERT".into()],
            for_each_row: true,
            condition: None,
            body: body.into(),
        }
    }

    fn sqls(plan: &Plan) -> Vec<&str> {
        plan.statements.iter().map(|s| s.sql.as_str()).collect()
    }

    fn query_err(d: Driver, t: &Trigger) -> String {
        match plan_trigger(d, None, Some(t)) {
            Err(AppError::Query(m)) => m,
            other => panic!("expected a query error, got {other:?}"),
        }
    }

    #[test]
    fn postgres() {
        let t = Trigger {
            events: vec!["INSERT".into(), "UPDATE".into()],
            condition: Some("  NEW.total > 0 ".into()),
            ..trg("public", " public.trg_touch() ")
        };
        let plan = plan_trigger(Driver::Postgres, None, Some(&t)).unwrap();
        assert!(plan.transactional && !plan.destructive && plan.warnings.is_empty());
        assert_eq!(
            sqls(&plan),
            [r#"CREATE TRIGGER "trg_touch" BEFORE INSERT OR UPDATE ON "public"."orders" FOR EACH ROW WHEN (NEW.total > 0) EXECUTE FUNCTION public.trg_touch()"#]
        );
        // Rename + move: drop the old one on its own table, in the same transaction.
        let moved = Trigger { name: r#"we"ird"#.into(), table: "items".into(), for_each_row: false, events: vec!["TRUNCATE".into()], ..t.clone() };
        let plan = plan_trigger(Driver::Postgres, Some(&t), Some(&moved)).unwrap();
        assert!(plan.transactional && !plan.destructive);
        assert_eq!(
            sqls(&plan),
            [
                r#"DROP TRIGGER IF EXISTS "trg_touch" ON "public"."orders""#,
                r#"CREATE TRIGGER "we""ird" BEFORE TRUNCATE ON "public"."items" FOR EACH STATEMENT WHEN (NEW.total > 0) EXECUTE FUNCTION public.trg_touch()"#
            ]
        );
        let plan = plan_trigger(Driver::Postgres, Some(&t), None).unwrap();
        assert_eq!(sqls(&plan), [r#"DROP TRIGGER "trg_touch" ON "public"."orders""#]);
        assert!(plan.destructive && plan.transactional);
    }

    #[test]
    fn mariadb_and_mysql() {
        let body = "BEGIN\n  SET NEW.note = COALESCE(NEW.note, '');\nEND";
        let t = trg("shop", body);
        let plan = plan_trigger(Driver::Mariadb, Some(&t), Some(&t)).unwrap();
        assert!(!plan.transactional && !plan.destructive && plan.warnings == [MY_DDL_WARNING]);
        assert_eq!(sqls(&plan), [format!("CREATE OR REPLACE TRIGGER `shop`.`trg_touch` BEFORE INSERT ON `shop`.`orders` FOR EACH ROW\n{body}")]);
        let renamed = Trigger { name: "we`ird".into(), ..t.clone() };
        let plan = plan_trigger(Driver::Mariadb, Some(&t), Some(&renamed)).unwrap();
        assert_eq!(sqls(&plan)[0], "DROP TRIGGER IF EXISTS `shop`.`trg_touch`");
        assert!(sqls(&plan)[1].starts_with("CREATE OR REPLACE TRIGGER `shop`.`we``ird` "));

        let edited = Trigger { timing: "AFTER".into(), events: vec!["DELETE".into()], ..t.clone() };
        let plan = plan_trigger(Driver::Mysql, Some(&t), Some(&edited)).unwrap();
        assert!(!plan.transactional && !plan.destructive);
        assert_eq!(
            sqls(&plan),
            [
                "DROP TRIGGER IF EXISTS `shop`.`trg_touch`".to_string(),
                format!("CREATE TRIGGER `shop`.`trg_touch` AFTER DELETE ON `shop`.`orders` FOR EACH ROW\n{body}")
            ]
        );
        assert!(plan.warnings[0].contains(&format!("CREATE TRIGGER `shop`.`trg_touch` BEFORE INSERT ON `shop`.`orders` FOR EACH ROW\n{body}")));
        assert_eq!(plan_trigger(Driver::Mysql, None, Some(&t)).unwrap().statements.len(), 1);
        let plan = plan_trigger(Driver::Mysql, Some(&t), None).unwrap();
        assert_eq!(sqls(&plan), ["DROP TRIGGER `shop`.`trg_touch`"]);
        assert!(plan.destructive && !plan.transactional);
    }

    #[test]
    fn sqlite() {
        let body = "BEGIN UPDATE t SET n = 'END;' WHERE id = NEW.id; END";
        let t = Trigger { name: r#"a"b"#.into(), condition: Some("NEW.id > 0".into()), ..trg("main", body) };
        let plan = plan_trigger(Driver::Sqlite, Some(&t), Some(&t)).unwrap();
        assert!(plan.transactional && !plan.destructive);
        assert_eq!(
            sqls(&plan),
            [r#"DROP TRIGGER IF EXISTS "a""b""#.to_string(), format!("CREATE TRIGGER \"a\"\"b\" BEFORE INSERT ON \"orders\" FOR EACH ROW WHEN NEW.id > 0\n{body}")]
        );
        let plan = plan_trigger(Driver::Sqlite, Some(&t), None).unwrap();
        assert_eq!(sqls(&plan), [r#"DROP TRIGGER "a""b""#]);
        assert!(plan.destructive);
    }

    #[test]
    fn validation() {
        let t = trg("s", "BEGIN END");
        let two = Trigger { events: vec!["INSERT".into(), "UPDATE".into()], ..t.clone() };
        for d in [Driver::Mysql, Driver::Mariadb, Driver::Sqlite] {
            assert!(query_err(d, &two).contains("exactly one event"));
            let trunc = Trigger { events: vec!["TRUNCATE".into()], for_each_row: false, ..t.clone() };
            assert!(query_err(d, &trunc).contains("TRUNCATE"));
        }
        assert!(plan_trigger(Driver::Postgres, None, Some(&two)).is_ok());
        let trunc_row = Trigger { events: vec!["TRUNCATE".into()], ..t.clone() };
        assert_eq!(query_err(Driver::Postgres, &trunc_row), "TRUNCATE triggers must be FOR EACH STATEMENT");
        let instead = Trigger { timing: "INSTEAD OF".into(), ..t.clone() };
        assert_eq!(query_err(Driver::Mysql, &instead), "MySQL/MariaDB do not support INSTEAD OF triggers");
        assert_eq!(query_err(Driver::Mariadb, &instead), "MySQL/MariaDB do not support INSTEAD OF triggers");
        assert!(plan_trigger(Driver::Sqlite, None, Some(&instead)).is_ok());
        assert_eq!(query_err(Driver::Postgres, &Trigger { timing: "LATER".into(), ..t.clone() }), "Unknown trigger timing: LATER");
        assert_eq!(query_err(Driver::Postgres, &Trigger { events: vec!["SELECT".into()], ..t.clone() }), "Unknown trigger event: SELECT");
        assert_eq!(query_err(Driver::Postgres, &Trigger { events: vec![], ..t.clone() }), "The trigger needs at least one event");
        assert_eq!(query_err(Driver::Postgres, &Trigger { name: " ".into(), ..t.clone() }), "The trigger needs a name");
        assert_eq!(query_err(Driver::Postgres, &Trigger { table: "".into(), ..t.clone() }), "The trigger needs a table");
        assert_eq!(query_err(Driver::Sqlite, &Trigger { body: "\n".into(), ..t.clone() }), "The trigger body is empty");
        assert!(matches!(plan_trigger(Driver::Postgres, None, None), Err(AppError::Query(_))));
    }

    #[test]
    fn parses_pg_triggerdef() {
        let def = "CREATE TRIGGER trg_orders_touch BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION trg_touch()";
        assert_eq!(split_pg_triggerdef(def, false), (None, "trg_touch()".into()));
        let def = "CREATE TRIGGER t AFTER UPDATE ON s.o FOR EACH ROW WHEN ((new.total > (0)::numeric)) EXECUTE PROCEDURE s.f('a)')";
        assert_eq!(split_pg_triggerdef(def, true), (Some("new.total > (0)::numeric".into()), "s.f('a)')".into()));
        assert_eq!(strip_parens("(a) AND (b)"), "(a) AND (b)");
        assert_eq!(strip_parens("new.paid"), "new.paid");
    }

    #[test]
    fn parses_sqlite_trigger() {
        let sql = "CREATE TRIGGER \"after insert\" AFTER UPDATE OF qty ON items FOR EACH ROW WHEN NEW.qty > 0\nBEGIN\n  SELECT 1;\nEND";
        assert_eq!(
            parse_sqlite(sql, "after insert"),
            ("AFTER".into(), "UPDATE".into(), Some("NEW.qty > 0".into()), "BEGIN\n  SELECT 1;\nEND".into())
        );
        let sql = "create trigger if not exists t delete on x begin delete from y; end";
        assert_eq!(parse_sqlite(sql, "t"), ("BEFORE".into(), "DELETE".into(), None, "begin delete from y; end".into()));
        let sql = "CREATE TRIGGER v_ins INSTEAD OF INSERT ON v BEGIN SELECT 1; END";
        assert_eq!(parse_sqlite(sql, "v_ins").0, "INSTEAD OF");
    }
}
