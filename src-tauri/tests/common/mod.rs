//! Shared helpers for driver integration tests.
#![allow(dead_code)]
pub mod sshd;

use std::sync::Arc;

use ahsandb_lib::db::{self, Manager, Pool};
use ahsandb_lib::error::AppResult;
use ahsandb_lib::model::*;

pub fn conn(driver: Driver) -> Connection {
    Connection {
        id: format!("test-{driver:?}").to_lowercase(),
        name: "test".into(),
        folder: "".into(),
        driver,
        env: Env::Dev,
        host: None,
        port: None,
        database: None,
        user: None,
        file: None,
        read_only: false,
        connected: false,
        ssh: None,
        ssl_mode: SslMode::Disable,
        ai_access: AiAccess::Off,
        server_version: None,
        timeout_secs: Some(5),
        ssl_ca_path: None,
        ssl_cert_path: None,
        ssl_key_path: None,
        default_database: None,
    }
}

/// Connection from `scheme://[user@]host[:port]/db` in env `var`; `None` (test skipped) when unset.
pub fn from_env(var: &str, driver: Driver) -> Option<Connection> {
    let Ok(url) = std::env::var(var) else {
        eprintln!("skipped: {var} not set");
        return None;
    };
    let rest = url.split_once("://").expect("url scheme").1;
    let (user, rest) = match rest.split_once('@') {
        Some((u, r)) => (Some(u.to_string()), r),
        None => (None, rest),
    };
    let (hostport, database) = rest.split_once('/').expect("url database");
    let (host, port) = match hostport.split_once(':') {
        Some((h, p)) => (h, Some(p.parse().expect("port"))),
        None => (hostport, None),
    };
    Some(Connection { host: Some(host.into()), port, user, database: Some(database.into()), ..conn(driver) })
}

pub async fn open(c: &Connection) -> (Manager, Arc<Pool>) {
    let (pool, _) = db::connect(c, None, None).await.expect("connect");
    let mgr = Manager::default();
    mgr.pools.lock().await.insert(c.id.clone(), Arc::new(pool));
    let pool = mgr.pool(&c.id).await.expect("pool");
    (mgr, pool)
}

pub async fn exec(mgr: &Manager, pool: &Pool, c: &Connection, sql: &str) -> AppResult<Vec<StatementResult>> {
    db::exec::execute(mgr, pool, c, sql, false, 1000, "run").await
}

/// Runs a script that must succeed and returns the last statement's rows.
pub async fn rows(mgr: &Manager, pool: &Pool, c: &Connection, sql: &str) -> Vec<Vec<Cell>> {
    let res = exec(mgr, pool, c, sql).await.expect("execute");
    for r in &res {
        assert!(r.error.is_none(), "{}: {:?}", r.sql, r.error);
    }
    res.last().expect("a result").rows.clone()
}

pub fn flatten(nodes: &[SchemaNode]) -> Vec<&SchemaNode> {
    let mut out = Vec::new();
    for n in nodes {
        out.push(n);
        out.extend(flatten(n.children.as_deref().unwrap_or_default()));
    }
    out
}

/// Asserts ids are unique and prefixed with the connection id; returns all ids.
pub fn tree_ids(c: &Connection, tree: &[SchemaNode]) -> Vec<String> {
    let ids: Vec<String> = flatten(tree).iter().map(|n| n.id.clone()).collect();
    let mut sorted = ids.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), ids.len(), "duplicate node ids");
    assert!(ids.iter().all(|i| i.starts_with(&format!("{}/", c.id))));
    ids
}

pub fn has_suffix(ids: &[String], suffix: &str) -> bool {
    ids.iter().any(|i| i.ends_with(suffix))
}

// ---------- DDL / apply helpers ----------

/// Short random suffix for temp schemas/tables.
pub fn rand_suffix() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// Stores the plan as a preview and applies it (not confirmed).
pub async fn apply_plan(mgr: &Manager, pool: &Pool, c: &Connection, plan: db::preview::Plan) -> AppResult<ApplyReport> {
    let preview = db::preview::store(mgr, &c.id, plan).await?;
    db::preview::apply(mgr, pool, c, &preview.id, false).await
}

/// Applies a plan that must fully succeed.
pub async fn apply_ok(mgr: &Manager, pool: &Pool, c: &Connection, plan: db::preview::Plan) {
    let shown: Vec<String> = plan.statements.iter().map(|s| s.sql.clone()).collect();
    let r = apply_plan(mgr, pool, c, plan).await.expect("apply");
    assert!(r.failed.is_none(), "{:?}\n{}", r.failed, shown.join(";\n"));
}

/// Comparable form of a table definition: no original names, sorted indexes/checks, unnamed FKs when
/// the driver doesn't name them, check expressions without quoting/outer parentheses.
pub fn normalized(t: &TableDef, fk_names: bool) -> TableDef {
    let mut t = t.clone();
    for c in &mut t.columns {
        c.original_name = None;
    }
    if !fk_names {
        for f in &mut t.foreign_keys {
            f.name = None;
        }
    }
    t.indexes.sort_by(|a, b| a.name.cmp(&b.name));
    t.foreign_keys.sort_by(|a, b| a.columns.cmp(&b.columns));
    for c in &mut t.checks {
        let e = c.expression.replace(['`', '"'], "");
        c.expression = e.trim_matches(|ch| ch == '(' || ch == ')' || ch == ' ').to_string();
    }
    t.checks.sort_by(|a, b| a.expression.cmp(&b.expression));
    t
}
