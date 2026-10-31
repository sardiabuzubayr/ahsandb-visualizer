//! Create / rename / drop database. Runs only when AHSANDB_TEST_PG /
//! AHSANDB_TEST_MYSQL are set. Only databases named `ahsandb_t_<rand>` created here are ever dropped.
mod common;

use ahsandb_lib::db::{Pool, meta};
use ahsandb_lib::error::AppError;
use ahsandb_lib::model::*;
use ahsandb_lib::objects::databases;
use common::*;

fn def(name: &str) -> DatabaseDef {
    DatabaseDef { name: name.into(), owner: None, charset: None, collation: None }
}

fn db_node<'a>(tree: &'a [SchemaNode], name: &str) -> Option<&'a SchemaNode> {
    tree.iter().find(|n| n.kind == NodeKind::Database && n.label == name)
}

/// Runs `body` in its own task so a failed assertion still reaches `cleanup`, then re-raises it.
async fn guarded(body: impl Future<Output = ()> + Send + 'static, cleanup: impl Future<Output = ()>) {
    let outcome = tokio::spawn(body).await;
    cleanup.await;
    if let Err(e) = outcome {
        std::panic::resume_unwind(e.into_panic());
    }
}

#[tokio::test]
async fn postgres_create_rename_drop() {
    let Some(c) = from_env("AHSANDB_TEST_PG", Driver::Postgres) else { return };
    let (a, b) = (format!("ahsandb_t_{}", rand_suffix()), format!("ahsandb_t_{}", rand_suffix()));
    let (_mgr, admin) = open(&c).await;
    let Pool::Pg(p) = &*admin else { panic!("not PostgreSQL") };
    guarded(pg_body(c.clone(), a.clone(), b.clone()), async {
        for name in [&a, &b] {
            sqlx::query(&format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)")).execute(p).await.expect("cleanup");
        }
    })
    .await;
}

async fn pg_body(c: Connection, a: String, b: String) {
    let (mgr, pool) = open(&c).await;
    let base = c.base_database();
    let d = Driver::Postgres;

    // The connection's own database and system databases are refused before anything runs.
    for r in [
        databases::plan_drop_database(d, base.as_deref(), "ahsandb_test"),
        databases::plan_rename_database(d, base.as_deref(), "ahsandb_test", &a),
        databases::plan_drop_database(d, base.as_deref(), "postgres"),
        databases::plan_drop_database(d, base.as_deref(), "template1"),
        databases::plan_rename_database(d, base.as_deref(), "template0", &a),
    ] {
        assert!(matches!(r, Err(AppError::Query(_))), "{r:?}");
    }

    // Create, on the main pool (non-transactional: CREATE DATABASE fails inside BEGIN).
    apply_ok(&mgr, &pool, &c, databases::plan_create_database(d, &def(&a)).unwrap()).await;
    let multi = Connection { database: Some(format!("ahsandb_test, {a}")), ..c.clone() };
    let tree = meta::schema_tree(&pool, &multi).await.unwrap();
    let node = db_node(&tree, &a).expect("created database in the tree");
    assert!(node.lazy && node.size.is_some_and(|s| s > 0), "{node:?}");
    assert!(db_node(&tree, "ahsandb_test").and_then(|n| n.size).is_some_and(|s| s > 0));
    // The populated (single database) node has a size too.
    let tree = meta::schema_tree(&pool, &c).await.unwrap();
    assert!(db_node(&tree, "ahsandb_test").and_then(|n| n.size).is_some_and(|s| s > 0));

    apply_ok(&mgr, &pool, &c, databases::plan_rename_database(d, base.as_deref(), &a, &b).unwrap()).await;
    let tree = meta::schema_tree(&pool, &Connection { database: Some(format!("ahsandb_test, {b}")), ..c.clone() }).await.unwrap();
    assert!(db_node(&tree, &b).and_then(|n| n.size).is_some_and(|s| s > 0));

    apply_ok(&mgr, &pool, &c, databases::plan_drop_database(d, base.as_deref(), &b).unwrap()).await;
    let left = rows(&mgr, &pool, &c, &format!("SELECT count(*) FROM pg_database WHERE datname IN ('{a}', '{b}')")).await;
    assert_eq!(left[0][0], serde_json::json!(0));
}

#[tokio::test]
async fn mariadb_create_drop() {
    let Some(c) = from_env("AHSANDB_TEST_MYSQL", Driver::Mariadb) else { return };
    // Empty Database field: the tree lists every database on the server.
    let c = Connection { database: None, ..c };
    let a = format!("ahsandb_t_{}", rand_suffix());
    let (_mgr, admin) = open(&c).await;
    let Pool::My(p) = &*admin else { panic!("not MySQL") };
    guarded(my_body(c.clone(), a.clone()), async {
        sqlx::query(&format!("DROP DATABASE IF EXISTS `{a}`")).execute(p).await.expect("cleanup");
    })
    .await;
}

async fn my_body(c: Connection, a: String) {
    let (mgr, pool) = open(&c).await;
    let d = Driver::Mariadb;
    assert!(matches!(databases::plan_rename_database(d, None, "ahsandb_test", &a), Err(AppError::NotSupported(_))));
    assert!(matches!(databases::plan_drop_database(d, None, "mysql"), Err(AppError::Query(_))));

    let create = DatabaseDef { charset: Some("utf8mb4".into()), collation: Some("utf8mb4_unicode_ci".into()), ..def(&a) };
    apply_ok(&mgr, &pool, &c, databases::plan_create_database(d, &create).unwrap()).await;
    let tree = meta::schema_tree(&pool, &c).await.unwrap();
    assert_eq!(db_node(&tree, &a).expect("created database in the tree").size, Some(0));
    assert!(db_node(&tree, "ahsandb_test").and_then(|n| n.size).is_some_and(|s| s > 0));

    apply_ok(&mgr, &pool, &c, databases::plan_drop_database(d, None, &a).unwrap()).await;
    let tree = meta::schema_tree(&pool, &c).await.unwrap();
    assert!(db_node(&tree, &a).is_none());
}
