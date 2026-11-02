//! Functions and stored procedures: read definition, generate save SQL, build the call for "Run".
use super::{MY_DDL_WARNING, cell_lit, is_my, not_sql, not_supported_sqlite, q, split_list, text_rows};
use crate::db::preview::{Plan, PlannedStatement};
use crate::db::Pool;
use crate::error::{AppError, AppResult};
use crate::model::{Cell, Connection, Driver, Routine, RoutineParam};

/// Reads a function/procedure (`kind` = "function" | "procedure") into the editor model.
/// SQLite has no routines → `NotSupported`.
pub async fn load_routine(pool: &Pool, _conn: &Connection, schema: &str, name: &str, kind: &str) -> AppResult<Routine> {
    if !matches!(kind, "function" | "procedure") {
        return Err(AppError::Query(format!("Unknown routine kind: {kind}")));
    }
    match pool {
        Pool::Pg(_) => load_pg(pool, schema, name, kind).await,
        Pool::My(_) => load_my(pool, schema, name, kind).await,
        Pool::Lite(_) => not_supported_sqlite("stored routines"),
    }
}

fn not_found(kind: &str, schema: &str, name: &str) -> AppError {
    AppError::NotFound(format!("The {kind} {schema}.{name} does not exist"))
}

async fn load_pg(pool: &Pool, schema: &str, name: &str, kind: &str) -> AppResult<Routine> {
    let prokind = if kind == "function" { "f" } else { "p" };
    // shortcut: overloads → the first one (lowest oid) is opened; add a signature picker if users ask.
    // shortcut: parameter defaults are not read (they are dropped on save).
    let rows = text_rows(
        pool,
        "SELECT COALESCE(pg_get_function_result(p.oid), ''), l.lanname::text,
           CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END, p.prosrc,
           COALESCE(array_to_string(p.proargmodes, chr(31)), ''),
           COALESCE(array_to_string(p.proargnames, chr(31)), ''),
           COALESCE((SELECT string_agg(format_type(t, NULL), chr(31) ORDER BY o)
                     FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY AS u(t, o)), '')
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
         WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = $3::\"char\"
         ORDER BY p.oid LIMIT 1",
        &[schema, name, prokind],
    )
    .await?;
    let r = rows.into_iter().next().ok_or_else(|| not_found(kind, schema, name))?;
    let (modes, names, types) = (split_list(&r[4]), split_list(&r[5]), split_list(&r[6]));
    let params = types
        .iter()
        .enumerate()
        .filter_map(|(i, t)| {
            let mode = match modes.get(i).map(String::as_str) {
                None | Some("i") => "IN",
                Some("o") => "OUT",
                Some("b") => "INOUT",
                Some("v") => "VARIADIC",
                _ => return None, // 't' = RETURNS TABLE column, part of `returns`
            };
            Some(RoutineParam { mode: mode.into(), name: names.get(i).cloned().unwrap_or_default(), type_name: t.clone() })
        })
        .collect();
    Ok(Routine {
        kind: kind.into(),
        name: name.into(),
        database: schema.into(),
        security: r[2].clone(),
        params,
        returns: (kind == "function" && !r[0].is_empty()).then(|| r[0].clone()),
        language: Some(r[1].clone()),
        body: r[3].trim().to_string(),
    })
}

async fn load_my(pool: &Pool, schema: &str, name: &str, kind: &str) -> AppResult<Routine> {
    let ty = kind.to_uppercase();
    let rows = text_rows(
        pool,
        "SELECT LOWER(SECURITY_TYPE), COALESCE(DTD_IDENTIFIER, ''), COALESCE(ROUTINE_DEFINITION, ''), IS_DETERMINISTIC, SQL_DATA_ACCESS
         FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? AND ROUTINE_TYPE = ?",
        &[schema, name, &ty],
    )
    .await?;
    let r = rows.into_iter().next().ok_or_else(|| not_found(kind, schema, name))?;
    let mut def = r[2].clone();
    if def.is_empty() {
        // ROUTINE_DEFINITION is NULL without privileges on the routine; SHOW CREATE may still work.
        let sql = format!("SHOW CREATE {ty} {}.{}", q(Driver::Mysql, schema), q(Driver::Mysql, name));
        let create = text_rows(pool, &sql, &[]).await?.into_iter().next().and_then(|r| r.into_iter().nth(2)).unwrap_or_default();
        def = body_from_show_create(&create)
            .ok_or_else(|| AppError::Query(format!("No privilege to read the definition of {schema}.{name}")))?;
    }
    // Non-default characteristics stay in the body so a save keeps them (binary logging needs them).
    let mut chars = Vec::new();
    if r[3] == "YES" {
        chars.push("DETERMINISTIC");
    }
    if !r[4].is_empty() && r[4] != "CONTAINS SQL" {
        chars.push(r[4].as_str());
    }
    let body = if chars.is_empty() { def.trim().to_string() } else { format!("{}\n{}", chars.join("\n"), def.trim()) };
    let params = text_rows(
        pool,
        "SELECT COALESCE(PARAMETER_MODE, 'IN'), COALESCE(PARAMETER_NAME, ''), COALESCE(DTD_IDENTIFIER, '')
         FROM information_schema.PARAMETERS
         WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ROUTINE_TYPE = ? AND ORDINAL_POSITION > 0
         ORDER BY ORDINAL_POSITION",
        &[schema, name, &ty],
    )
    .await?
    .into_iter()
    .map(|p| RoutineParam { mode: p[0].clone(), name: p[1].clone(), type_name: p[2].clone() })
    .collect();
    Ok(Routine {
        kind: kind.into(),
        name: name.into(),
        database: schema.into(),
        security: r[0].clone(),
        params,
        returns: (kind == "function" && !r[1].is_empty()).then(|| r[1].clone()),
        language: None,
        body,
    })
}

/// Body of a `SHOW CREATE PROCEDURE/FUNCTION` text: after the parameter list, the rest of that line
/// (RETURNS …) and the server-printed characteristic lines.
// shortcut: relies on the server's layout (characteristics on their own indented lines, body on a new line).
fn body_from_show_create(create: &str) -> Option<String> {
    let open = create.find('(')?;
    let mut depth = 0;
    let close = create[open..].char_indices().find_map(|(i, c)| {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        (depth == 0).then_some(open + i)
    })?;
    let rest = &create[close + 1..];
    let rest = &rest[rest.find('\n')? + 1..];
    const CHARS: [&str; 9] = [
        "COMMENT", "LANGUAGE", "DETERMINISTIC", "NOT DETERMINISTIC", "CONTAINS SQL", "NO SQL", "READS SQL DATA",
        "MODIFIES SQL DATA", "SQL SECURITY",
    ];
    let mut lines = rest.lines().peekable();
    while let Some(l) = lines.peek() {
        let t = l.trim_start();
        if l.starts_with(' ') && CHARS.iter().any(|c| t.to_uppercase().starts_with(c)) {
            lines.next();
        } else {
            break;
        }
    }
    let body = lines.collect::<Vec<_>>().join("\n");
    (!body.trim().is_empty()).then_some(body)
}

fn qualified(d: Driver, db: &str, name: &str) -> String {
    if db.is_empty() { q(d, name) } else { format!("{}.{}", q(d, db), q(d, name)) }
}

fn validate(r: &Routine) -> AppResult<()> {
    if !matches!(r.kind.as_str(), "function" | "procedure") {
        return Err(AppError::Query(format!("Unknown routine kind: {}", r.kind)));
    }
    if r.name.trim().is_empty() {
        return Err(AppError::Query("The routine needs a name".into()));
    }
    if r.body.trim().is_empty() {
        return Err(AppError::Query("The routine body is empty".into()));
    }
    if r.kind == "function" && r.returns.as_deref().is_none_or(|t| t.trim().is_empty()) {
        return Err(AppError::Query("A function needs a return type".into()));
    }
    Ok(())
}

fn pg_param(p: &RoutineParam) -> String {
    let name = if p.name.is_empty() { String::new() } else { format!("{} ", q(Driver::Postgres, &p.name)) };
    format!("{} {name}{}", p.mode, p.type_name)
}

fn pg_create(r: &Routine) -> String {
    let params = r.params.iter().map(pg_param).collect::<Vec<_>>().join(", ");
    let mut s = format!("CREATE OR REPLACE {} {}({params})", r.kind.to_uppercase(), qualified(Driver::Postgres, &r.database, &r.name));
    if r.kind == "function" {
        s += &format!(" RETURNS {}", r.returns.as_deref().unwrap_or_default().trim());
    }
    s += &format!(" LANGUAGE {}", r.language.as_deref().filter(|l| !l.trim().is_empty()).unwrap_or("plpgsql").trim());
    if r.security == "definer" {
        s += " SECURITY DEFINER";
    }
    let body = r.body.trim();
    let mut tag = "$body$".to_string();
    let mut n = 0;
    while body.contains(&tag) {
        n += 1;
        tag = format!("$body{n}$");
    }
    s + &format!(" AS {tag}\n{body}\n{tag}")
}

fn my_create(d: Driver, r: &Routine, or_replace: bool) -> AppResult<String> {
    let function = r.kind == "function";
    let params = r
        .params
        .iter()
        .map(|p| {
            if function && p.mode != "IN" {
                return Err(AppError::Query("MySQL/MariaDB function parameters can only be IN".into()));
            }
            let mode = if function { String::new() } else { format!("{} ", p.mode) };
            Ok(format!("{mode}{} {}", q(d, &p.name), p.type_name))
        })
        .collect::<AppResult<Vec<_>>>()?
        .join(", ");
    let mut s = format!(
        "CREATE {}{} {}({params})",
        if or_replace { "OR REPLACE " } else { "" },
        r.kind.to_uppercase(),
        qualified(d, &r.database, &r.name)
    );
    if function {
        s += &format!(" RETURNS {}", r.returns.as_deref().unwrap_or_default().trim());
    }
    let security = if r.security == "invoker" { "INVOKER" } else { "DEFINER" };
    Ok(s + &format!(" SQL SECURITY {security}\n{}", r.body.trim()))
}

fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn renamed(o: &Routine, r: &Routine) -> bool {
    o.name != r.name || o.kind != r.kind || o.database != r.database
}

/// Save SQL. PG: CREATE OR REPLACE (DROP first when the signature/return type changed). MariaDB:
/// CREATE OR REPLACE. MySQL: DROP + CREATE (non-transactional; warning that a failed CREATE leaves the
/// routine dropped — the plan includes the original definition so it can be restored manually).
/// `original: None` = new routine.
pub fn plan_routine(driver: Driver, original: Option<&Routine>, routine: &Routine) -> AppResult<Plan> {
    validate(routine)?;
    let mut plan = Plan::default();
    let drop = |o: &Routine| format!("DROP {} {}", o.kind.to_uppercase(), qualified(driver, &o.database, &o.name));
    match driver {
        Driver::Postgres => {
            plan.transactional = true;
            if let Some(o) = original {
                let sig = |r: &Routine| {
                    let params: Vec<_> = r.params.iter().map(|p| (p.mode.clone(), p.name.clone(), norm(&p.type_name))).collect();
                    (params, r.returns.as_deref().map(norm))
                };
                if renamed(o, routine) || sig(o) != sig(routine) {
                    // DROP FUNCTION ignores OUT arguments; PG ≥ 14 procedures use them — modes cover both.
                    let types = o.params.iter().map(|p| format!("{} {}", p.mode, p.type_name)).collect::<Vec<_>>().join(", ");
                    plan.statements.push(PlannedStatement::new(format!("{}({types})", drop(o))));
                    plan.destructive = true;
                    plan.warnings.push("The signature changed: the routine is dropped and re-created, so its grants are lost.".into());
                }
            }
            plan.statements.push(PlannedStatement::new(pg_create(routine)));
        }
        Driver::Mariadb => {
            if let Some(o) = original.filter(|o| renamed(o, routine)) {
                plan.statements.push(PlannedStatement::new(drop(o)));
                plan.destructive = true;
            }
            plan.statements.push(PlannedStatement::new(my_create(driver, routine, true)?));
            plan.warnings.push(MY_DDL_WARNING.into());
        }
        Driver::Mysql => {
            if let Some(o) = original {
                plan.statements.push(PlannedStatement::new(format!(
                    "DROP {} IF EXISTS {}",
                    o.kind.to_uppercase(),
                    qualified(driver, &o.database, &o.name)
                )));
                let restore = my_create(driver, o, false).unwrap_or_else(|e| format!("-- {e}"));
                plan.warnings.push(format!(
                    "MySQL has no CREATE OR REPLACE for routines: the routine is dropped first, so if CREATE fails it stays dropped. Original definition to restore it:\n{restore}"
                ));
            }
            plan.statements.push(PlannedStatement::new(my_create(driver, routine, false)?));
            plan.warnings.push(MY_DDL_WARNING.into());
        }
        Driver::Sqlite => return not_supported_sqlite("stored routines"),
        Driver::Redis => return not_sql(),
    }
    Ok(plan)
}

/// MySQL user variable / alias: bare when a plain identifier, else backticked.
fn my_var(name: &str) -> String {
    let plain = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if plain { name.to_string() } else { q(Driver::Mysql, name) }
}

/// SQL that runs the routine with literal IN/INOUT arguments (one per IN/INOUT param, in order).
/// PG function: `SELECT * FROM schema.fn(args)`; PG procedure: `CALL schema.proc(args)`;
/// MySQL/MariaDB procedure: `CALL db.proc(args, @out…); SELECT @out…`; function: `SELECT db.fn(args)`.
pub fn call_sql(driver: Driver, routine: &Routine, args: &[Cell]) -> AppResult<String> {
    if driver == Driver::Sqlite {
        return not_supported_sqlite("stored routines");
    }
    let inputs = routine.params.iter().filter(|p| p.mode != "OUT").count();
    if args.len() != inputs {
        return Err(AppError::Query(format!("{} expects {inputs} argument(s), got {}", routine.name, args.len())));
    }
    let name = qualified(driver, &routine.database, &routine.name);
    let mut args = args.iter().map(|a| cell_lit(driver, a));
    let function = routine.kind == "function";
    if !is_my(driver) {
        // PG: OUT params of a procedure take NULL in CALL and come back as the result row.
        let list: Vec<String> = routine
            .params
            .iter()
            .filter(|p| !(function && p.mode == "OUT"))
            .map(|p| if p.mode == "OUT" { "NULL".into() } else { args.next().unwrap_or_default() })
            .collect();
        let list = list.join(", ");
        return Ok(if function { format!("SELECT * FROM {name}({list})") } else { format!("CALL {name}({list})") });
    }
    if function {
        let list = args.collect::<Vec<_>>().join(", ");
        return Ok(format!("SELECT {name}({list}) AS result"));
    }
    let (mut pre, mut list, mut outs) = (vec![], vec![], vec![]);
    for p in &routine.params {
        let var = format!("@{}", my_var(&p.name));
        match p.mode.as_str() {
            "OUT" => list.push(var.clone()),
            "INOUT" => {
                pre.push(format!("SET {var} = {}", args.next().unwrap_or_default()));
                list.push(var.clone());
            }
            _ => {
                list.push(args.next().unwrap_or_default());
                continue;
            }
        }
        outs.push(format!("{var} AS {}", my_var(&p.name)));
    }
    pre.push(format!("CALL {name}({})", list.join(", ")));
    if !outs.is_empty() {
        pre.push(format!("SELECT {}", outs.join(", ")));
    }
    Ok(pre.join(";\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(mode: &str, name: &str, ty: &str) -> RoutineParam {
        RoutineParam { mode: mode.into(), name: name.into(), type_name: ty.into() }
    }

    fn func(db: &str) -> Routine {
        Routine {
            kind: "function".into(),
            name: "fn_total".into(),
            database: db.into(),
            security: "invoker".into(),
            params: vec![p("IN", "p_order", "bigint")],
            returns: Some("numeric".into()),
            language: Some("sql".into()),
            body: " SELECT 1; ".into(),
        }
    }

    fn proc_(db: &str) -> Routine {
        Routine {
            kind: "procedure".into(),
            name: "do_it".into(),
            database: db.into(),
            security: "definer".into(),
            params: vec![p("IN", "a", "int"), p("INOUT", "b", "int"), p("OUT", "c", "text")],
            returns: None,
            language: Some("plpgsql".into()),
            body: "BEGIN c := 'x'; END;".into(),
        }
    }

    fn sqls(plan: &Plan) -> Vec<&str> {
        plan.statements.iter().map(|s| s.sql.as_str()).collect()
    }

    #[test]
    fn pg_create_and_signature_drop() {
        let f = func("public");
        let plan = plan_routine(Driver::Postgres, None, &f).unwrap();
        assert!(plan.transactional && !plan.destructive);
        assert_eq!(
            sqls(&plan),
            [r#"CREATE OR REPLACE FUNCTION "public"."fn_total"(IN "p_order" bigint) RETURNS numeric LANGUAGE sql AS $body$
SELECT 1;
$body$"#]
        );
        // Body edit only → no drop.
        let edited = Routine { body: "SELECT 2".into(), ..f.clone() };
        assert_eq!(plan_routine(Driver::Postgres, Some(&f), &edited).unwrap().statements.len(), 1);
        // Return type change → drop old signature first.
        let changed = Routine { returns: Some("bigint".into()), ..f.clone() };
        let plan = plan_routine(Driver::Postgres, Some(&f), &changed).unwrap();
        assert_eq!(sqls(&plan)[0], r#"DROP FUNCTION "public"."fn_total"(IN bigint)"#);
        assert!(plan.destructive);

        let pr = Routine { body: "BEGIN RAISE NOTICE '$body$'; END".into(), ..proc_("s") };
        let plan = plan_routine(Driver::Postgres, None, &pr).unwrap();
        assert_eq!(
            sqls(&plan),
            [r#"CREATE OR REPLACE PROCEDURE "s"."do_it"(IN "a" int, INOUT "b" int, OUT "c" text) LANGUAGE plpgsql SECURITY DEFINER AS $body1$
BEGIN RAISE NOTICE '$body$'; END
$body1$"#]
        );
        // Rename → drop the old name.
        let plan = plan_routine(Driver::Postgres, Some(&pr), &Routine { name: "done".into(), ..pr.clone() }).unwrap();
        assert_eq!(sqls(&plan)[0], r#"DROP PROCEDURE "s"."do_it"(IN int, INOUT int, OUT text)"#);
    }

    #[test]
    fn validation() {
        let no_ret = Routine { returns: None, ..func("d") };
        assert!(matches!(plan_routine(Driver::Postgres, None, &no_ret), Err(AppError::Query(m)) if m == "A function needs a return type"));
        let empty = Routine { body: "  ".into(), ..func("d") };
        assert!(plan_routine(Driver::Mariadb, None, &empty).is_err());
        let out_fn = Routine { params: vec![p("OUT", "x", "int")], ..func("d") };
        assert!(plan_routine(Driver::Mysql, None, &out_fn).is_err());
        assert!(matches!(plan_routine(Driver::Sqlite, None, &func("d")), Err(AppError::NotSupported(_))));
    }

    #[test]
    fn mariadb_and_mysql() {
        let f = Routine { body: "READS SQL DATA\nBEGIN RETURN 1; END".into(), returns: Some("decimal(14,2)".into()), ..func("db") };
        let plan = plan_routine(Driver::Mariadb, Some(&f), &f).unwrap();
        assert!(!plan.transactional && !plan.destructive && !plan.warnings.is_empty());
        assert_eq!(
            sqls(&plan),
            ["CREATE OR REPLACE FUNCTION `db`.`fn_total`(`p_order` bigint) RETURNS decimal(14,2) SQL SECURITY INVOKER\nREADS SQL DATA\nBEGIN RETURN 1; END"]
        );
        let pr = proc_("db");
        let plan = plan_routine(Driver::Mariadb, Some(&pr), &Routine { name: "x".into(), ..pr.clone() }).unwrap();
        assert_eq!(sqls(&plan)[0], "DROP PROCEDURE `db`.`do_it`");

        let plan = plan_routine(Driver::Mysql, Some(&pr), &pr).unwrap();
        assert_eq!(
            sqls(&plan),
            [
                "DROP PROCEDURE IF EXISTS `db`.`do_it`",
                "CREATE PROCEDURE `db`.`do_it`(IN `a` int, INOUT `b` int, OUT `c` text) SQL SECURITY DEFINER\nBEGIN c := 'x'; END;"
            ]
        );
        assert!(plan.warnings[0].contains("CREATE PROCEDURE `db`.`do_it`("), "{}", plan.warnings[0]);
        // New routine: no DROP.
        assert_eq!(plan_routine(Driver::Mysql, None, &pr).unwrap().statements.len(), 1);
    }

    #[test]
    fn calls() {
        let args = [json!(1), json!("it's")];
        assert_eq!(call_sql(Driver::Postgres, &proc_("s"), &args).unwrap(), r#"CALL "s"."do_it"(1, 'it''s', NULL)"#);
        assert_eq!(call_sql(Driver::Postgres, &func("s"), &[json!(7)]).unwrap(), r#"SELECT * FROM "s"."fn_total"(7)"#);
        assert_eq!(call_sql(Driver::Mysql, &func("db"), &[json!(null)]).unwrap(), "SELECT `db`.`fn_total`(NULL) AS result");
        assert_eq!(
            call_sql(Driver::Mariadb, &proc_("db"), &[json!(1), json!("a\\b")]).unwrap(),
            "SET @b = 'a\\\\b';\nCALL `db`.`do_it`(1, @b, @c);\nSELECT @b AS b, @c AS c"
        );
        assert!(matches!(call_sql(Driver::Postgres, &func("s"), &[]), Err(AppError::Query(_))));
        assert!(matches!(call_sql(Driver::Sqlite, &func("s"), &[]), Err(AppError::NotSupported(_))));
    }

    #[test]
    fn show_create_body() {
        let create = "CREATE DEFINER=`root`@`localhost` FUNCTION `f`(p decimal(14,2)) RETURNS decimal(14,2)\n    READS SQL DATA\n    SQL SECURITY INVOKER\nBEGIN\n  RETURN p;\nEND";
        assert_eq!(body_from_show_create(create).unwrap(), "BEGIN\n  RETURN p;\nEND");
        assert_eq!(body_from_show_create("CREATE PROCEDURE `p`()\nSELECT 1").unwrap(), "SELECT 1");
        assert_eq!(body_from_show_create(""), None);
    }
}
