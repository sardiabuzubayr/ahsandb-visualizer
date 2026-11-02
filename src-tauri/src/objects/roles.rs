//! Roles/users and privileges: read, and GRANT/REVOKE/ALTER generation from a diff.
use std::collections::HashMap;

use super::{lit, not_sql, not_supported_sqlite, q, split_list, text_rows};
use crate::db::preview::{Plan, PlannedStatement};
use crate::db::Pool;
use crate::error::{AppError, AppResult};
use crate::model::{Connection, Driver, PrivilegeRow, Role, RoleAttrs, PRIVILEGES};

const MASK: &str = "'••••••'";
/// MySQL routine rows carry this suffix so plan_role knows to say `ON PROCEDURE` (kind stays `function`).
const MY_PROC_SUFFIX: &str = " (procedure)";

/// PG: pg_roles (excluding pg_* roles) with attributes and memberships. MySQL/MariaDB: `user@host`
/// accounts (+ roles where supported). SQLite → `NotSupported`. Missing privileges → `Query` error.
pub async fn load_roles(pool: &Pool, conn: &Connection) -> AppResult<Vec<Role>> {
    match pool {
        Pool::Pg(_) => load_pg_roles(pool).await,
        Pool::My(_) => load_my_roles(pool, conn.driver).await,
        Pool::Lite(_) => not_supported_sqlite("roles"),
    }
}

fn tag(a: &RoleAttrs) -> String {
    if a.superuser { "superuser" } else if a.login { "login" } else { "group" }.into()
}

async fn load_pg_roles(pool: &Pool) -> AppResult<Vec<Role>> {
    let rows = text_rows(
        pool,
        "SELECT r.rolname::text, r.rolcanlogin::text, r.rolsuper::text, r.rolcreatedb::text, r.rolcreaterole::text,
           r.rolinherit::text, r.rolreplication::text, r.rolconnlimit::text,
           CASE WHEN isfinite(r.rolvaliduntil) THEN to_char(r.rolvaliduntil AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') END,
           COALESCE((SELECT string_agg(g.rolname::text, chr(31) ORDER BY g.rolname)
                     FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid), '')
         FROM pg_roles r WHERE r.rolname NOT LIKE 'pg\\_%' ORDER BY 1",
        &[],
    )
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let b = |i: usize| r[i] == "true";
            let attrs = RoleAttrs { login: b(1), superuser: b(2), createdb: b(3), createrole: b(4), inherit: b(5), replication: b(6) };
            Role {
                name: r[0].clone(),
                tag: tag(&attrs),
                attrs,
                conn_limit: r[7].parse().ok().filter(|n| *n >= 0),
                valid_until: Some(r[8].clone()).filter(|s| !s.is_empty()),
                member_of: split_list(&r[9]),
            }
        })
        .collect())
}

async fn load_my_roles(pool: &Pool, driver: Driver) -> AppResult<Vec<Role>> {
    // account_locked exists in MySQL ≥ 5.7.6, is_role in MariaDB; probe so one query fits both.
    let cols: Vec<String> = text_rows(
        pool,
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'mysql' AND TABLE_NAME = 'user'
           AND COLUMN_NAME IN ('account_locked', 'is_role')",
        &[],
    )
    .await?
    .into_iter()
    .map(|mut r| r.remove(0).to_lowercase())
    .collect();
    let has = |c: &str| cols.iter().any(|x| x == c);
    // shortcut: MariaDB 10.4+ keeps account locking in mysql.global_priv JSON → login shows true there.
    let locked = if has("account_locked") { "account_locked" } else { "'N'" };
    // shortcut: MariaDB roles (is_role = 'Y') are not listed as editable entries, only as memberships.
    // Filtered in Rust: comparing mysql.user columns with literals hits collation mixes on MariaDB.
    let is_role = if has("is_role") { "is_role" } else { "'N'" };
    let rows = text_rows(
        pool,
        &format!("SELECT User, Host, Super_priv, CAST(max_user_connections AS CHAR), {locked}, {is_role} FROM mysql.user ORDER BY User, Host"),
        &[],
    )
    .await?;
    // Memberships: MariaDB roles_mapping / MySQL 8 role_edges; absent or unreadable → none.
    let edges_sql = if driver == Driver::Mariadb {
        "SELECT User, Host, Role FROM mysql.roles_mapping"
    } else {
        "SELECT TO_USER, TO_HOST, CONCAT(FROM_USER, '@', FROM_HOST) FROM mysql.role_edges"
    };
    let mut member_of: HashMap<String, Vec<String>> = HashMap::new();
    for e in text_rows(pool, edges_sql, &[]).await.unwrap_or_default() {
        member_of.entry(format!("{}@{}", e[0], e[1])).or_default().push(e[2].clone());
    }
    Ok(rows
        .into_iter()
        .filter(|r| r[5] != "Y")
        .map(|r| {
            let name = format!("{}@{}", r[0], r[1]);
            let attrs = RoleAttrs { login: r[4] != "Y", superuser: r[2] == "Y", ..Default::default() };
            Role {
                tag: tag(&RoleAttrs { login: true, ..attrs.clone() }),
                attrs,
                conn_limit: r[3].parse().ok().filter(|n| *n > 0),
                valid_until: None,
                member_of: member_of.remove(&name).unwrap_or_default(),
                name,
            }
        })
        .collect())
}

/// Privileges that can be granted per object kind and driver.
fn applicable(driver: Driver, kind: &str) -> &'static [&'static str] {
    match (driver, kind) {
        (Driver::Postgres, "schema") => &["USAGE", "CREATE"],
        (Driver::Postgres, "table") => &["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES"],
        (Driver::Postgres, "sequence") => &["SELECT", "UPDATE", "USAGE"],
        (_, "schema") => &["SELECT", "INSERT", "UPDATE", "DELETE", "REFERENCES", "CREATE", "EXECUTE"],
        (_, "table") => &["SELECT", "INSERT", "UPDATE", "DELETE", "REFERENCES"],
        (_, "view") => &["SELECT"],
        (_, "function") => &["EXECUTE"],
        _ => &[],
    }
}

fn row(driver: Driver, kind: &str, name: String, granted: &[String]) -> PrivilegeRow {
    let ok = applicable(driver, kind);
    let cells = PRIVILEGES
        .iter()
        .map(|p| {
            if !ok.contains(p) {
                "na"
            } else if granted.iter().any(|g| g.eq_ignore_ascii_case(p)) {
                "on"
            } else {
                "off"
            }
            .to_string()
        })
        .collect();
    PrivilegeRow { kind: kind.into(), name, cells }
}

/// Direct privileges of `role` on the objects of `schema` (PG) / database (MySQL), one row per object
/// (the schema/database itself first), cells in PRIVILEGES order; inapplicable cells are `na`.
pub async fn load_privileges(pool: &Pool, conn: &Connection, role: &str, schema: &str) -> AppResult<Vec<PrivilegeRow>> {
    match pool {
        Pool::Pg(_) => load_pg_privileges(pool, role, schema).await,
        Pool::My(_) => load_my_privileges(pool, conn.driver, role, schema).await,
        Pool::Lite(_) => not_supported_sqlite("roles"),
    }
}

async fn load_pg_privileges(pool: &Pool, role: &str, schema: &str) -> AppResult<Vec<PrivilegeRow>> {
    if text_rows(pool, "SELECT 1::text FROM pg_roles WHERE rolname = $1", &[role]).await?.is_empty() {
        return Err(AppError::NotFound(format!("The role {role} does not exist")));
    }
    // aclexplode on the ACL (NULL ACL = owner defaults via acldefault) keeps direct grants only — no PUBLIC/inherited.
    let rows = text_rows(
        pool,
        "WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
         SELECT kind, name, privs FROM (
           SELECT 'schema' AS kind, n.nspname::text AS name, 0 AS ord,
             (SELECT string_agg(a.privilege_type, chr(31)) FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a, r WHERE a.grantee = r.oid) AS privs
           FROM pg_namespace n WHERE n.nspname = $2
           UNION ALL
           SELECT CASE WHEN c.relkind IN ('r','p') THEN 'table' WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'sequence' END,
             c.relname::text, CASE WHEN c.relkind IN ('r','p') THEN 1 WHEN c.relkind IN ('v','m') THEN 2 ELSE 3 END,
             (SELECT string_agg(a.privilege_type, chr(31))
              FROM aclexplode(COALESCE(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::\"char\", c.relowner))) a, r
              WHERE a.grantee = r.oid)
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $2 AND c.relkind IN ('r','p','v','m','S')
           UNION ALL
           SELECT 'function', p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')', 4,
             (SELECT string_agg(a.privilege_type, chr(31)) FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a, r WHERE a.grantee = r.oid)
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = $2 AND p.prokind IN ('f','p')
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
         ) x ORDER BY ord, name",
        &[role, schema],
    )
    .await?;
    Ok(rows.into_iter().map(|r| row(Driver::Postgres, &r[0], r[1].clone(), &split_list(&r[2]))).collect())
}

/// `user@host` → (user, host); no `@` → host `%`.
fn account(name: &str) -> (&str, &str) {
    name.rsplit_once('@').unwrap_or((name, "%"))
}

fn my_account(name: &str) -> String {
    let (u, h) = account(name);
    format!("{}@{}", lit(Driver::Mysql, u), lit(Driver::Mysql, h))
}

async fn load_my_privileges(pool: &Pool, driver: Driver, role: &str, db: &str) -> AppResult<Vec<PrivilegeRow>> {
    let (user, host) = account(role);
    let grantee = format!("'{user}'@'{host}'");
    // shortcut: database grants with wildcards (`db\_%`, `%`) are not matched — exact database name only.
    let schema_privs: Vec<String> = text_rows(
        pool,
        "SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ? AND TABLE_SCHEMA = ?",
        &[&grantee, db],
    )
    .await?
    .into_iter()
    .map(|mut r| r.remove(0))
    .collect();
    let mut out = vec![row(driver, "schema", db.to_string(), &schema_privs)];
    let mut table_privs: HashMap<String, Vec<String>> = HashMap::new();
    for r in text_rows(
        pool,
        "SELECT TABLE_NAME, PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE = ? AND TABLE_SCHEMA = ?",
        &[&grantee, db],
    )
    .await?
    {
        table_privs.entry(r[0].clone()).or_default().push(r[1].clone());
    }
    let tables = text_rows(
        pool,
        // Type mapped in Rust: comparing TABLE_TYPE with a literal hits collation mixes on MariaDB.
        "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY 1",
        &[db],
    )
    .await?;
    for kind in ["table", "view"] {
        for t in tables.iter().filter(|t| (t[1] == "VIEW") == (kind == "view") && t[1] != "SYSTEM VIEW") {
            out.push(row(driver, kind, t[0].clone(), table_privs.get(&t[0]).map(Vec::as_slice).unwrap_or_default()));
        }
    }
    // Routine grants live in mysql.procs_priv; unreadable → routine rows are left out.
    if let Ok(granted) = text_rows(
        pool,
        "SELECT Routine_name, Routine_type FROM mysql.procs_priv WHERE User = ? AND Host = ? AND Db = ? AND FIND_IN_SET('Execute', Proc_priv) > 0",
        &[user, host, db],
    )
    .await
    {
        let routines = text_rows(
            pool,
            "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY 1, 2",
            &[db],
        )
        .await?;
        for r in routines {
            let on = granted.iter().any(|g| g[0].eq_ignore_ascii_case(&r[0]) && g[1] == r[1]);
            let name = if r[1] == "PROCEDURE" { format!("{}{MY_PROC_SUFFIX}", r[0]) } else { r[0].clone() };
            let privs = if on { vec!["EXECUTE".to_string()] } else { vec![] };
            out.push(row(driver, "function", name, &privs));
        }
    }
    Ok(out)
}

/// The GRANT/REVOKE target for a privilege row.
fn object(driver: Driver, schema: &str, r: &PrivilegeRow) -> String {
    let qs = q(driver, schema);
    if driver == Driver::Postgres {
        return match r.kind.as_str() {
            "schema" => format!("SCHEMA {}", q(driver, &r.name)),
            "sequence" => format!("SEQUENCE {qs}.{}", q(driver, &r.name)),
            // Name carries the signature from load_privileges, e.g. `fn(bigint)`; ROUTINE covers procedures too.
            "function" => match r.name.split_once('(') {
                Some((n, args)) => format!("ROUTINE {qs}.{}({args}", q(driver, n)),
                None => format!("ROUTINE {qs}.{}", q(driver, &r.name)),
            },
            _ => format!("TABLE {qs}.{}", q(driver, &r.name)),
        };
    }
    match r.kind.as_str() {
        "schema" => format!("{}.*", q(driver, &r.name)),
        "function" => match r.name.strip_suffix(MY_PROC_SUFFIX) {
            Some(n) => format!("PROCEDURE {qs}.{}", q(driver, n)),
            None => format!("FUNCTION {qs}.{}", q(driver, &r.name)),
        },
        _ => format!("{qs}.{}", q(driver, &r.name)),
    }
}

/// GRANT/REVOKE statements for the matrix diff (`na` ignored; missing original row = all off).
fn privilege_statements(driver: Driver, schema: &str, grantee: &str, original: &[PrivilegeRow], target: &[PrivilegeRow]) -> Vec<String> {
    let mut out = Vec::new();
    for t in target {
        let o = original.iter().find(|o| o.kind == t.kind && o.name == t.name);
        let (mut grant, mut revoke) = (vec![], vec![]);
        for (i, cell) in t.cells.iter().enumerate() {
            let before = o.and_then(|o| o.cells.get(i)).map(String::as_str).unwrap_or("off");
            match (cell.as_str(), before) {
                ("on", "off") => grant.push(PRIVILEGES[i]),
                ("off", "on") => revoke.push(PRIVILEGES[i]),
                _ => {}
            }
        }
        let obj = object(driver, schema, t);
        if !grant.is_empty() {
            out.push(format!("GRANT {} ON {obj} TO {grantee}", grant.join(", ")));
        }
        if !revoke.is_empty() {
            out.push(format!("REVOKE {} ON {obj} FROM {grantee}", revoke.join(", ")));
        }
    }
    out
}

/// Statement built around the password literal; the display gets the mask instead.
fn secret(build: impl Fn(&str) -> String, password_lit: &str) -> PlannedStatement {
    PlannedStatement { sql: build(password_lit), display: build(MASK), expect_rows: None }
}

/// CREATE/ALTER/DROP ROLE (or USER), membership GRANT/REVOKE, and privilege GRANT/REVOKE from the diff
/// of `privileges_original` → `privileges_target`. `password` is set when given; its display text is
/// masked as `'••••••'`. `original: None` = create, `target: None` = drop.
#[allow(clippy::too_many_arguments)]
pub fn plan_role(
    driver: Driver,
    original: Option<&Role>,
    target: Option<&Role>,
    password: Option<&str>,
    schema: &str,
    privileges_original: &[PrivilegeRow],
    privileges_target: &[PrivilegeRow],
) -> AppResult<Plan> {
    match driver {
        Driver::Postgres => plan_pg(original, target, password, schema, privileges_original, privileges_target),
        Driver::Mysql | Driver::Mariadb => plan_my(driver, original, target, password, schema, privileges_original, privileges_target),
        Driver::Sqlite => not_supported_sqlite("roles"),
        Driver::Redis => not_sql(),
    }
}

fn check_name(r: &Role) -> AppResult<()> {
    if r.name.trim().is_empty() { Err(AppError::Query("The role needs a name".into())) } else { Ok(()) }
}

fn plan_pg(
    original: Option<&Role>,
    target: Option<&Role>,
    password: Option<&str>,
    schema: &str,
    priv_o: &[PrivilegeRow],
    priv_t: &[PrivilegeRow],
) -> AppResult<Plan> {
    let d = Driver::Postgres;
    let mut plan = Plan { transactional: true, ..Default::default() };
    let Some(t) = target else {
        let o = original.ok_or_else(|| AppError::Query("Nothing to apply".into()))?;
        plan.statements.push(PlannedStatement::new(format!("DROP ROLE {}", q(d, &o.name))));
        plan.destructive = true;
        plan.warnings.push("DROP ROLE fails while the role still owns objects or holds privileges.".into());
        return Ok(plan);
    };
    check_name(t)?;
    let name = q(d, &t.name);
    let pw = password.filter(|p| !p.is_empty()).map(|p| lit(d, p));
    let flag = |on: bool, kw: &str| if on { kw.to_string() } else { format!("NO{kw}") };
    let attrs = |a: &RoleAttrs| {
        [
            flag(a.login, "LOGIN"),
            flag(a.superuser, "SUPERUSER"),
            flag(a.createdb, "CREATEDB"),
            flag(a.createrole, "CREATEROLE"),
            flag(a.inherit, "INHERIT"),
            flag(a.replication, "REPLICATION"),
        ]
    };
    let limit = |r: &Role| format!("CONNECTION LIMIT {}", r.conn_limit.unwrap_or(-1));
    let until = |r: &Role| format!("VALID UNTIL {}", lit(d, r.valid_until.as_deref().filter(|v| !v.is_empty()).unwrap_or("infinity")));
    let valid = |r: &Role| r.valid_until.clone().filter(|v| !v.is_empty());
    let mut stmts: Vec<PlannedStatement> = Vec::new();
    match original {
        None => {
            let mut s = format!("CREATE ROLE {name} WITH {}", attrs(&t.attrs).join(" "));
            if t.conn_limit.is_some() {
                s += &format!(" {}", limit(t));
            }
            if valid(t).is_some() {
                s += &format!(" {}", until(t));
            }
            match &pw {
                Some(p) => stmts.push(secret(|p| format!("{s} PASSWORD {p}"), p)),
                None => stmts.push(PlannedStatement::new(s)),
            }
        }
        Some(o) => {
            if o.name != t.name {
                stmts.push(PlannedStatement::new(format!("ALTER ROLE {} RENAME TO {name}", q(d, &o.name))));
            }
            let mut changed: Vec<String> =
                attrs(&o.attrs).into_iter().zip(attrs(&t.attrs)).filter(|(a, b)| a != b).map(|(_, b)| b).collect();
            if o.conn_limit != t.conn_limit {
                changed.push(limit(t));
            }
            if valid(o) != valid(t) {
                changed.push(until(t));
            }
            if !changed.is_empty() {
                stmts.push(PlannedStatement::new(format!("ALTER ROLE {name} WITH {}", changed.join(" "))));
            }
            if let Some(p) = &pw {
                stmts.push(secret(|p| format!("ALTER ROLE {name} WITH PASSWORD {p}"), p));
            }
        }
    }
    let before = original.map(|o| o.member_of.as_slice()).unwrap_or_default();
    for g in t.member_of.iter().filter(|g| !before.contains(g)) {
        stmts.push(PlannedStatement::new(format!("GRANT {} TO {name}", q(d, g))));
    }
    for g in before.iter().filter(|g| !t.member_of.contains(g)) {
        stmts.push(PlannedStatement::new(format!("REVOKE {} FROM {name}", q(d, g))));
    }
    stmts.extend(privilege_statements(d, schema, &name, priv_o, priv_t).into_iter().map(PlannedStatement::new));
    plan.destructive = stmts.iter().any(|s| s.sql.starts_with("REVOKE"));
    plan.statements = stmts;
    Ok(plan)
}

fn plan_my(
    d: Driver,
    original: Option<&Role>,
    target: Option<&Role>,
    password: Option<&str>,
    schema: &str,
    priv_o: &[PrivilegeRow],
    priv_t: &[PrivilegeRow],
) -> AppResult<Plan> {
    let mut plan = Plan {
        transactional: false,
        warnings: vec!["MySQL/MariaDB account changes are not transactional: statements that already ran stay applied if a later one fails.".into()],
        ..Default::default()
    };
    let Some(t) = target else {
        let o = original.ok_or_else(|| AppError::Query("Nothing to apply".into()))?;
        plan.statements.push(PlannedStatement::new(format!("DROP USER {}", my_account(&o.name))));
        plan.destructive = true;
        return Ok(plan);
    };
    check_name(t)?;
    let before = original.map(|o| o.attrs.clone()).unwrap_or_default();
    let unsupported = [
        ("superuser", before.superuser != t.attrs.superuser),
        ("createdb", before.createdb != t.attrs.createdb),
        ("createrole", before.createrole != t.attrs.createrole),
        ("replication", before.replication != t.attrs.replication),
        ("valid until", original.map(|o| o.valid_until.clone()).unwrap_or_default().filter(|v| !v.is_empty())
            != t.valid_until.clone().filter(|v| !v.is_empty())),
    ];
    if let Some((attr, _)) = unsupported.iter().find(|(_, changed)| *changed) {
        return Err(AppError::Query(format!("Not supported for MySQL/MariaDB: {attr}")));
    }
    let acc = my_account(&t.name);
    let pw = password.filter(|p| !p.is_empty()).map(|p| lit(d, p));
    let limit = format!("WITH MAX_USER_CONNECTIONS {}", t.conn_limit.unwrap_or(0));
    let lock = if t.attrs.login { "ACCOUNT UNLOCK" } else { "ACCOUNT LOCK" };
    let mut stmts: Vec<PlannedStatement> = Vec::new();
    match original {
        None => {
            let mut rest = String::new();
            if t.conn_limit.is_some() {
                rest += &format!(" {limit}");
            }
            if !t.attrs.login {
                rest += " ACCOUNT LOCK";
            }
            stmts.push(match &pw {
                Some(p) => secret(|p| format!("CREATE USER {acc} IDENTIFIED BY {p}{rest}"), p),
                None => PlannedStatement::new(format!("CREATE USER {acc}{rest}")),
            });
        }
        Some(o) => {
            if o.name != t.name {
                stmts.push(PlannedStatement::new(format!("RENAME USER {} TO {acc}", my_account(&o.name))));
            }
            if let Some(p) = &pw {
                stmts.push(secret(|p| format!("ALTER USER {acc} IDENTIFIED BY {p}"), p));
            }
            if o.conn_limit != t.conn_limit {
                stmts.push(PlannedStatement::new(format!("ALTER USER {acc} {limit}")));
            }
            if o.attrs.login != t.attrs.login {
                stmts.push(PlannedStatement::new(format!("ALTER USER {acc} {lock}")));
            }
        }
    }
    // Roles: MySQL 8 `role@host` accounts, MariaDB plain role names.
    let role = |r: &str| if r.contains('@') { my_account(r) } else { q(d, r) };
    let before = original.map(|o| o.member_of.as_slice()).unwrap_or_default();
    for g in t.member_of.iter().filter(|g| !before.contains(g)) {
        stmts.push(PlannedStatement::new(format!("GRANT {} TO {acc}", role(g))));
    }
    for g in before.iter().filter(|g| !t.member_of.contains(g)) {
        stmts.push(PlannedStatement::new(format!("REVOKE {} FROM {acc}", role(g))));
    }
    stmts.extend(privilege_statements(d, schema, &acc, priv_o, priv_t).into_iter().map(PlannedStatement::new));
    plan.destructive = stmts.iter().any(|s| s.sql.starts_with("REVOKE"));
    plan.statements = stmts;
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn role(name: &str) -> Role {
        Role {
            name: name.into(),
            tag: "group".into(),
            attrs: RoleAttrs { inherit: true, ..Default::default() },
            conn_limit: None,
            valid_until: None,
            member_of: vec![],
        }
    }

    fn prow(kind: &str, name: &str, cells: &[&str]) -> PrivilegeRow {
        PrivilegeRow { kind: kind.into(), name: name.into(), cells: cells.iter().map(|c| c.to_string()).collect() }
    }

    fn sqls(p: &Plan) -> Vec<&str> {
        p.statements.iter().map(|s| s.sql.as_str()).collect()
    }

    fn shown(p: &Plan) -> Vec<&str> {
        p.statements.iter().map(|s| s.display.as_str()).collect()
    }

    #[test]
    fn pg_create_alter_drop() {
        let mut t = role("app");
        t.attrs.login = true;
        t.conn_limit = Some(5);
        let plan = plan_role(Driver::Postgres, None, Some(&t), Some("s3'cret"), "public", &[], &[]).unwrap();
        assert!(plan.transactional && !plan.destructive);
        assert_eq!(
            sqls(&plan),
            ["CREATE ROLE \"app\" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION CONNECTION LIMIT 5 PASSWORD 's3''cret'"]
        );
        assert_eq!(
            shown(&plan),
            ["CREATE ROLE \"app\" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION CONNECTION LIMIT 5 PASSWORD '••••••'"]
        );

        let mut n = t.clone();
        n.name = "app2".into();
        n.attrs.createdb = true;
        n.conn_limit = None;
        n.valid_until = Some("2030-01-01T00:00:00Z".into());
        n.member_of = vec!["readers".into()];
        let o = Role { member_of: vec!["old".into()], ..t.clone() };
        let plan = plan_role(Driver::Postgres, Some(&o), Some(&n), Some("pw"), "public", &[], &[]).unwrap();
        assert_eq!(
            sqls(&plan),
            [
                "ALTER ROLE \"app\" RENAME TO \"app2\"",
                "ALTER ROLE \"app2\" WITH CREATEDB CONNECTION LIMIT -1 VALID UNTIL '2030-01-01T00:00:00Z'",
                "ALTER ROLE \"app2\" WITH PASSWORD 'pw'",
                "GRANT \"readers\" TO \"app2\"",
                "REVOKE \"old\" FROM \"app2\"",
            ]
        );
        assert_eq!(shown(&plan)[2], "ALTER ROLE \"app2\" WITH PASSWORD '••••••'");

        let plan = plan_role(Driver::Postgres, Some(&t), None, None, "public", &[], &[]).unwrap();
        assert_eq!(sqls(&plan), ["DROP ROLE \"app\""]);
        assert!(plan.destructive);
    }

    #[test]
    fn pg_privilege_diff_ignores_na() {
        let r = role("ro");
        let o = vec![
            prow("schema", "s", &["na", "na", "na", "na", "na", "na", "off", "off", "na"]),
            prow("table", "t", &["off", "on", "off", "off", "off", "off", "na", "na", "na"]),
            prow("function", "f(bigint)", &["na", "na", "na", "na", "na", "na", "na", "na", "off"]),
        ];
        let mut t = o.clone();
        t[0].cells[6] = "on".into();
        t[1].cells = ["on", "off", "on", "off", "off", "off", "na", "na", "na"].map(String::from).to_vec();
        t[2].cells[8] = "on".into();
        t.push(prow("sequence", "seq", &["na", "na", "na", "na", "na", "na", "on", "na", "na"]));
        let plan = plan_role(Driver::Postgres, Some(&r), Some(&r), None, "s", &o, &t).unwrap();
        assert_eq!(
            sqls(&plan),
            [
                "GRANT USAGE ON SCHEMA \"s\" TO \"ro\"",
                "GRANT SELECT, UPDATE ON TABLE \"s\".\"t\" TO \"ro\"",
                "REVOKE INSERT ON TABLE \"s\".\"t\" FROM \"ro\"",
                "GRANT EXECUTE ON ROUTINE \"s\".\"f\"(bigint) TO \"ro\"",
                "GRANT USAGE ON SEQUENCE \"s\".\"seq\" TO \"ro\"",
            ]
        );
        assert!(plan.destructive);
        // Cells that are `na` never produce statements.
        let na = vec![prow("view", "v", &["off", "na", "na", "na", "na", "na", "na", "na", "na"])];
        let na_t = vec![prow("view", "v", &["off", "on", "on", "na", "na", "na", "na", "na", "na"])];
        assert!(plan_role(Driver::Postgres, Some(&r), Some(&r), None, "s", &na, &na_t).unwrap().statements.is_empty());
    }

    #[test]
    fn mysql_users() {
        let mut t = role("app@localhost");
        t.attrs = RoleAttrs { login: true, ..Default::default() };
        t.conn_limit = Some(3);
        let plan = plan_role(Driver::Mariadb, None, Some(&t), Some("a'b\\c"), "shop", &[], &[]).unwrap();
        assert!(!plan.transactional && !plan.warnings.is_empty());
        assert_eq!(sqls(&plan), ["CREATE USER 'app'@'localhost' IDENTIFIED BY 'a''b\\\\c' WITH MAX_USER_CONNECTIONS 3"]);
        assert_eq!(shown(&plan), ["CREATE USER 'app'@'localhost' IDENTIFIED BY '••••••' WITH MAX_USER_CONNECTIONS 3"]);

        let mut n = t.clone();
        n.name = "app2@%".into();
        n.attrs.login = false;
        n.member_of = vec!["dev".into()];
        let o = vec![
            prow("schema", "shop", &["off", "off", "off", "off", "na", "off", "na", "off", "off"]),
            prow("function", "close_orders (procedure)", &["na", "na", "na", "na", "na", "na", "na", "na", "off"]),
            prow("function", "fn_total", &["na", "na", "na", "na", "na", "na", "na", "na", "on"]),
            prow("table", "orders", &["off", "off", "off", "off", "na", "off", "na", "na", "na"]),
        ];
        let mut p = o.clone();
        p[0].cells[0] = "on".into();
        p[1].cells[8] = "on".into();
        p[2].cells[8] = "off".into();
        p[3].cells[0] = "on".into();
        let plan = plan_role(Driver::Mysql, Some(&t), Some(&n), Some("x"), "shop", &o, &p).unwrap();
        assert_eq!(
            sqls(&plan),
            [
                "RENAME USER 'app'@'localhost' TO 'app2'@'%'",
                "ALTER USER 'app2'@'%' IDENTIFIED BY 'x'",
                "ALTER USER 'app2'@'%' ACCOUNT LOCK",
                "GRANT `dev` TO 'app2'@'%'",
                "GRANT SELECT ON `shop`.* TO 'app2'@'%'",
                "GRANT EXECUTE ON PROCEDURE `shop`.`close_orders` TO 'app2'@'%'",
                "REVOKE EXECUTE ON FUNCTION `shop`.`fn_total` FROM 'app2'@'%'",
                "GRANT SELECT ON `shop`.`orders` TO 'app2'@'%'",
            ]
        );
        assert_eq!(shown(&plan)[1], "ALTER USER 'app2'@'%' IDENTIFIED BY '••••••'");

        let mut su = t.clone();
        su.attrs.superuser = true;
        assert!(matches!(plan_role(Driver::Mysql, Some(&t), Some(&su), None, "shop", &[], &[]),
            Err(AppError::Query(m)) if m == "Not supported for MySQL/MariaDB: superuser"));
        assert_eq!(sqls(&plan_role(Driver::Mariadb, Some(&t), None, None, "shop", &[], &[]).unwrap()), ["DROP USER 'app'@'localhost'"]);
        assert!(matches!(plan_role(Driver::Sqlite, None, Some(&t), None, "", &[], &[]), Err(AppError::NotSupported(_))));
    }
}
