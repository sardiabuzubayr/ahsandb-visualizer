//! Routines and roles against real servers. PG/MySQL parts run only when AHSANDB_TEST_PG /
//! AHSANDB_TEST_MYSQL are set; everything they create is uniquely named and removed at the end.
mod common;

use std::future::Future;
use std::panic::AssertUnwindSafe;

use ahsandb_lib::db::preview::Plan;
use ahsandb_lib::db::Pool;
use ahsandb_lib::error::AppError;
use ahsandb_lib::model::*;
use ahsandb_lib::objects::{roles, routines};
use common::*;
use futures::FutureExt;
use serde_json::json;

fn uniq() -> String {
    format!("ahsandb_t_{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
}

/// Runs SQL on the text protocol (like apply does), panicking on error.
async fn raw(pool: &Pool, sql: &str) {
    let r = match pool {
        Pool::Pg(p) => sqlx::raw_sql(sql).execute(p).await.map(|_| ()),
        Pool::My(p) => sqlx::raw_sql(sql).execute(p).await.map(|_| ()),
        Pool::Lite(p) => sqlx::raw_sql(sql).execute(p).await.map(|_| ()),
    };
    r.unwrap_or_else(|e| panic!("{sql}: {e}"));
}

/// Applies a plan by running its statements directly (preview::apply belongs to another group).
async fn run_plan(pool: &Pool, plan: &Plan) {
    for s in &plan.statements {
        raw(pool, &s.sql).await;
    }
}

/// Runs `body`, then `cleanup` even if `body` panicked.
async fn with_cleanup(body: impl Future<Output = ()>, cleanup: impl Future<Output = ()>) {
    let res = AssertUnwindSafe(body).catch_unwind().await;
    cleanup.await;
    if let Err(p) = res {
        std::panic::resume_unwind(p);
    }
}

fn param(mode: &str, name: &str, ty: &str) -> RoutineParam {
    RoutineParam { mode: mode.into(), name: name.into(), type_name: ty.into() }
}

fn priv_row<'a>(rows: &'a [PrivilegeRow], kind: &str, name: &str) -> &'a PrivilegeRow {
    rows.iter().find(|r| r.kind == kind && r.name == name).unwrap_or_else(|| panic!("no {kind} {name} in {rows:?}"))
}

fn set(rows: &mut [PrivilegeRow], kind: &str, name: &str, privilege: &str) {
    let i = PRIVILEGES.iter().position(|p| *p == privilege).unwrap();
    let r = rows.iter_mut().find(|r| r.kind == kind && r.name == name).unwrap();
    r.cells[i] = "on".into();
}

/// Rows minus objects other tests create concurrently in the shared MySQL database.
fn seed_rows(rows: Vec<PrivilegeRow>) -> Vec<PrivilegeRow> {
    rows.into_iter().filter(|r| !r.name.starts_with("ahsandb_t_")).collect()
}

fn on(r: &PrivilegeRow) -> Vec<&str> {
    PRIVILEGES.iter().zip(&r.cells).filter(|(_, c)| *c == "on").map(|(p, _)| *p).collect()
}

#[tokio::test]
async fn sqlite_not_supported() {
    let c = conn(Driver::Sqlite);
    let pool = Pool::Lite(sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap());
    assert!(matches!(routines::load_routine(&pool, &c, "main", "x", "function").await, Err(AppError::NotSupported(_))));
    assert!(matches!(roles::load_roles(&pool, &c).await, Err(AppError::NotSupported(_))));
}

// ---------- PostgreSQL ----------

fn pg() -> Option<Connection> {
    from_env("AHSANDB_TEST_PG", Driver::Postgres)
}

#[tokio::test]
async fn pg_seed_routines() {
    let Some(c) = pg() else { return };
    let (_mgr, pool) = open(&c).await;
    let f = routines::load_routine(&pool, &c, "public", "fn_order_total", "function").await.unwrap();
    assert_eq!(f.params, [param("IN", "p_order", "bigint")]);
    assert_eq!((f.returns.as_deref(), f.language.as_deref(), f.security.as_str()), (Some("numeric"), Some("sql"), "invoker"));
    assert!(f.body.starts_with("SELECT COALESCE(SUM(qty * price), 0)"), "{}", f.body);
    let p = routines::load_routine(&pool, &c, "public", "close_paid_orders", "procedure").await.unwrap();
    assert!(p.params.is_empty() && p.returns.is_none());
    assert_eq!(p.language.as_deref(), Some("plpgsql"));
    assert!(p.body.starts_with("BEGIN UPDATE orders"), "{}", p.body);
    assert!(matches!(routines::load_routine(&pool, &c, "public", "fn_order_total", "procedure").await, Err(AppError::NotFound(_))));
}

#[tokio::test]
async fn pg_routine_save_and_run() {
    let Some(c) = pg() else { return };
    let (mgr, pool) = open(&c).await;
    let s = uniq();
    raw(&pool, &format!("CREATE SCHEMA {s}")).await;
    with_cleanup(
        async {
            let f = Routine {
                kind: "function".into(),
                name: "label_double".into(),
                database: s.clone(),
                security: "invoker".into(),
                params: vec![param("IN", "p_amount", "numeric"), param("IN", "p_label", "text")],
                returns: Some("text".into()),
                language: Some("sql".into()),
                body: "SELECT p_label || '=' || (p_amount * 2)::text".into(),
            };
            run_plan(&pool, &routines::plan_routine(Driver::Postgres, None, &f).unwrap()).await;
            let loaded = routines::load_routine(&pool, &c, &s, "label_double", "function").await.unwrap();
            assert_eq!(loaded, f);
            let call = routines::call_sql(Driver::Postgres, &loaded, &[json!(21), json!("it's")]).unwrap();
            assert_eq!(rows(&mgr, &pool, &c, &call).await, [[json!("it's=42")]]);

            // Return type change → DROP + CREATE.
            let g = Routine { returns: Some("varchar".into()), body: "SELECT p_label".into(), ..loaded.clone() };
            let plan = routines::plan_routine(Driver::Postgres, Some(&loaded), &g).unwrap();
            assert!(plan.statements[0].sql.starts_with("DROP FUNCTION"));
            run_plan(&pool, &plan).await;
            let loaded = routines::load_routine(&pool, &c, &s, "label_double", "function").await.unwrap();
            assert_eq!(loaded.returns.as_deref(), Some("character varying"));

            let p = Routine {
                kind: "procedure".into(),
                name: "add_up".into(),
                database: s.clone(),
                security: "definer".into(),
                params: vec![param("IN", "a", "integer"), param("INOUT", "b", "integer"), param("OUT", "c", "text")],
                returns: None,
                language: Some("plpgsql".into()),
                body: "BEGIN b := a + b; c := 'done'; END".into(),
            };
            run_plan(&pool, &routines::plan_routine(Driver::Postgres, None, &p).unwrap()).await;
            let loaded = routines::load_routine(&pool, &c, &s, "add_up", "procedure").await.unwrap();
            assert_eq!(loaded, p);
            let call = routines::call_sql(Driver::Postgres, &loaded, &[json!(1), json!(2)]).unwrap();
            assert_eq!(rows(&mgr, &pool, &c, &call).await, [[json!(3), json!("done")]]);
        },
        async { raw(&pool, &format!("DROP SCHEMA {s} CASCADE")).await },
    )
    .await;
}

#[tokio::test]
async fn pg_role_grants() {
    let Some(c) = pg() else { return };
    let (_mgr, pool) = open(&c).await;
    let name = uniq();
    let s = uniq();
    raw(&pool, &format!("CREATE SCHEMA {s}; CREATE TABLE {s}.t (id int); CREATE SEQUENCE {s}.sq")).await;
    with_cleanup(
        async {
            let role = Role {
                name: name.clone(),
                tag: "group".into(),
                attrs: RoleAttrs { inherit: true, ..Default::default() },
                conn_limit: None,
                valid_until: None,
                member_of: vec![],
            };
            let plan = roles::plan_role(Driver::Postgres, None, Some(&role), Some("pw'1"), &s, &[], &[]).unwrap();
            assert!(plan.statements[0].display.ends_with("PASSWORD '••••••'"));
            run_plan(&pool, &plan).await;
            let all = roles::load_roles(&pool, &c).await.unwrap();
            let loaded = all.iter().find(|r| r.name == name).expect("role listed");
            assert_eq!(loaded, &role);
            assert!(all.iter().all(|r| !r.name.starts_with("pg_")));

            let before = roles::load_privileges(&pool, &c, &name, &s).await.unwrap();
            assert_eq!(before[0].kind, "schema");
            assert_eq!(before[0].cells, ["na", "na", "na", "na", "na", "na", "off", "off", "na"]);
            assert!(on(priv_row(&before, "table", "t")).is_empty());
            let mut target = before.clone();
            set(&mut target, "table", "t", "SELECT");
            set(&mut target, "schema", &s, "USAGE");
            set(&mut target, "sequence", "sq", "USAGE");
            let altered = Role { conn_limit: Some(3), ..role.clone() };
            run_plan(&pool, &roles::plan_role(Driver::Postgres, Some(&role), Some(&altered), None, &s, &before, &target).unwrap()).await;
            assert_eq!(roles::load_privileges(&pool, &c, &name, &s).await.unwrap(), target);
            let all = roles::load_roles(&pool, &c).await.unwrap();
            assert_eq!(all.iter().find(|r| r.name == name).unwrap().conn_limit, Some(3));

            let plan = roles::plan_role(Driver::Postgres, Some(&altered), Some(&altered), None, &s, &target, &before).unwrap();
            run_plan(&pool, &plan).await;
            assert_eq!(roles::load_privileges(&pool, &c, &name, &s).await.unwrap(), before);
        },
        async {
            raw(&pool, &format!("DROP SCHEMA {s} CASCADE")).await;
            raw(&pool, &format!("DROP OWNED BY {name}; DROP ROLE {name}")).await;
        },
    )
    .await;
}

// ---------- MySQL / MariaDB ----------

fn my() -> Option<Connection> {
    from_env("AHSANDB_TEST_MYSQL", Driver::Mariadb)
}

#[tokio::test]
async fn my_seed_routines() {
    let Some(c) = my() else { return };
    let (_mgr, pool) = open(&c).await;
    let f = routines::load_routine(&pool, &c, "ahsandb_test", "fn_order_total", "function").await.unwrap();
    assert_eq!(f.params.len(), 1);
    assert_eq!((f.params[0].mode.as_str(), f.params[0].name.as_str()), ("IN", "p_order"));
    assert!(f.params[0].type_name.starts_with("bigint"));
    assert_eq!(f.returns.as_deref(), Some("decimal(14,2)"));
    assert!(f.body.starts_with("READS SQL DATA\nBEGIN"), "{}", f.body);
    let p = routines::load_routine(&pool, &c, "ahsandb_test", "close_paid_orders", "procedure").await.unwrap();
    assert!(p.params.is_empty() && p.returns.is_none());
    assert_eq!(p.security, "definer");
    assert!(p.body.starts_with("BEGIN") && p.body.ends_with("END"), "{}", p.body);
    assert!(matches!(routines::load_routine(&pool, &c, "ahsandb_test", "nope", "function").await, Err(AppError::NotFound(_))));
}

#[tokio::test]
async fn my_routine_save_and_run() {
    let Some(c) = my() else { return };
    let (mgr, pool) = open(&c).await;
    let (pname, fname) = (format!("{}_p", uniq()), format!("{}_f", uniq()));
    with_cleanup(
        async {
            let p = Routine {
                kind: "procedure".into(),
                name: pname.clone(),
                database: "ahsandb_test".into(),
                security: "invoker".into(),
                params: vec![param("IN", "a", "int(11)"), param("INOUT", "b", "int(11)"), param("OUT", "c", "varchar(20)")],
                returns: None,
                language: None,
                body: "BEGIN\n  SET b = a + b;\n  SET c = 'done';\nEND".into(),
            };
            run_plan(&pool, &routines::plan_routine(c.driver, None, &p).unwrap()).await;
            let loaded = routines::load_routine(&pool, &c, "ahsandb_test", &pname, "procedure").await.unwrap();
            assert_eq!(loaded, p);
            let call = routines::call_sql(c.driver, &loaded, &[json!(1), json!(2)]).unwrap();
            let r = rows(&mgr, &pool, &c, &call).await;
            assert_eq!((r[0][0].to_string().trim_matches('"'), &r[0][1]), ("3", &json!("done")));

            // MySQL path: DROP IF EXISTS + CREATE, original kept in the warning.
            let edited = Routine { body: "BEGIN\n  SET b = a * b;\n  SET c = 'x';\nEND".into(), ..loaded.clone() };
            let plan = routines::plan_routine(Driver::Mysql, Some(&loaded), &edited).unwrap();
            assert!(plan.warnings[0].contains("SET b = a + b"));
            run_plan(&pool, &plan).await;
            assert_eq!(routines::load_routine(&pool, &c, "ahsandb_test", &pname, "procedure").await.unwrap(), edited);

            let f = Routine {
                kind: "function".into(),
                name: fname.clone(),
                database: "ahsandb_test".into(),
                security: "definer".into(),
                params: vec![param("IN", "p", "int(11)")],
                returns: Some("int(11)".into()),
                language: None,
                body: "DETERMINISTIC\nRETURN p * 2".into(),
            };
            run_plan(&pool, &routines::plan_routine(c.driver, None, &f).unwrap()).await;
            let loaded = routines::load_routine(&pool, &c, "ahsandb_test", &fname, "function").await.unwrap();
            assert_eq!(loaded, f);
            let call = routines::call_sql(c.driver, &loaded, &[json!(21)]).unwrap();
            assert_eq!(rows(&mgr, &pool, &c, &call).await[0][0].to_string().trim_matches('"'), "42");
        },
        async {
            raw(&pool, &format!("DROP PROCEDURE IF EXISTS ahsandb_test.{pname}")).await;
            raw(&pool, &format!("DROP FUNCTION IF EXISTS ahsandb_test.{fname}")).await;
        },
    )
    .await;
}

#[tokio::test]
async fn my_user_grants() {
    let Some(c) = my() else { return };
    let (_mgr, pool) = open(&c).await;
    let name = format!("{}@localhost", uniq());
    with_cleanup(
        async {
            let user = Role {
                name: name.clone(),
                tag: "login".into(),
                attrs: RoleAttrs { login: true, ..Default::default() },
                conn_limit: None,
                valid_until: None,
                member_of: vec![],
            };
            let plan = roles::plan_role(c.driver, None, Some(&user), Some("pw'\\1"), "ahsandb_test", &[], &[]).unwrap();
            assert!(plan.statements[0].display.contains("IDENTIFIED BY '••••••'"));
            run_plan(&pool, &plan).await;
            let all = roles::load_roles(&pool, &c).await.unwrap();
            assert_eq!(all.iter().find(|r| r.name == name).expect("user listed"), &user);

            let before = seed_rows(roles::load_privileges(&pool, &c, &name, "ahsandb_test").await.unwrap());
            assert_eq!((before[0].kind.as_str(), before[0].name.as_str()), ("schema", "ahsandb_test"));
            assert!(on(priv_row(&before, "table", "orders")).is_empty());
            priv_row(&before, "function", "close_paid_orders (procedure)");
            let mut target = before.clone();
            set(&mut target, "table", "orders", "SELECT");
            set(&mut target, "view", "v_open_orders", "SELECT");
            set(&mut target, "function", "fn_order_total", "EXECUTE");
            set(&mut target, "function", "close_paid_orders (procedure)", "EXECUTE");
            let limited = Role { conn_limit: Some(4), ..user.clone() };
            run_plan(&pool, &roles::plan_role(c.driver, Some(&user), Some(&limited), Some("new"), "ahsandb_test", &before, &target).unwrap())
                .await;
            assert_eq!(seed_rows(roles::load_privileges(&pool, &c, &name, "ahsandb_test").await.unwrap()), target);
            let all = roles::load_roles(&pool, &c).await.unwrap();
            assert_eq!(all.iter().find(|r| r.name == name).unwrap().conn_limit, Some(4));

            run_plan(&pool, &roles::plan_role(c.driver, Some(&limited), Some(&limited), None, "ahsandb_test", &target, &before).unwrap())
                .await;
            assert_eq!(seed_rows(roles::load_privileges(&pool, &c, &name, "ahsandb_test").await.unwrap()), before);
        },
        async {
            let (u, h) = name.rsplit_once('@').unwrap();
            raw(&pool, &format!("DROP USER IF EXISTS '{u}'@'{h}'")).await;
        },
    )
    .await;
}
