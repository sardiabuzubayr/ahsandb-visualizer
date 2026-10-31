//! Multi-database connections. Runs only when AHSANDB_TEST_PG / AHSANDB_TEST_MYSQL are set.
mod common;

use ahsandb_lib::db::{self, Pool, meta};
use ahsandb_lib::model::*;
use common::*;

fn db_nodes(tree: &[SchemaNode]) -> Vec<&SchemaNode> {
    tree.iter().filter(|n| n.kind == NodeKind::Database).collect()
}

async fn pg_exec(pool: &Pool, sql: &str) {
    let Pool::Pg(p) = pool else { panic!("not PostgreSQL") };
    sqlx::query(sql).execute(p).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
}

#[tokio::test]
async fn postgres_lists_databases_lazily() {
    let Some(c) = from_env("AHSANDB_TEST_PG", Driver::Postgres) else { return };
    let tmp = format!("ahsandb_t_{}", rand_suffix());
    let (_mgr, admin) = open(&c).await;
    pg_exec(&admin, &format!("CREATE DATABASE {tmp}")).await;
    // The body runs in its own task so a failed assertion still reaches the cleanup below.
    let outcome = tokio::spawn(pg_body(c.clone(), tmp.clone())).await;
    pg_exec(&admin, &format!("DROP DATABASE IF EXISTS {tmp} WITH (FORCE)")).await;
    if let Err(e) = outcome {
        std::panic::resume_unwind(e.into_panic());
    }
}

async fn pg_body(c: Connection, tmp: String) {
    let (_mgr, base) = open(&c).await;

    // One database = the pool's own: populated as before, not lazy.
    let tree = meta::schema_tree(&base, &c).await.unwrap();
    let dbs = db_nodes(&tree);
    assert_eq!(dbs.len(), 1);
    assert!(!dbs[0].lazy && dbs[0].children.is_some());
    assert!(has_suffix(&tree_ids(&c, &tree), "/ahsandb_test/public/tables/orders"));

    // Two listed databases: lazy nodes without children, plus Roles.
    let multi = Connection { database: Some(format!(" ahsandb_test ,{tmp},")), ..c.clone() };
    let tree = meta::schema_tree(&base, &multi).await.unwrap();
    let dbs = db_nodes(&tree);
    let ids: Vec<&str> = dbs.iter().map(|n| n.id.as_str()).collect();
    assert_eq!(ids, [format!("{}/ahsandb_test", c.id), format!("{}/{tmp}", c.id)]);
    assert!(dbs.iter().all(|n| n.lazy && n.children.is_none() && n.schema.is_none()));
    assert!(tree.iter().any(|n| n.id == format!("{}/roles", c.id)));

    // Expanding the temp database: a pool on it, then database_tree with the bare connection id.
    let scoped = Connection { database: Some(tmp.clone()), ..c.clone() };
    let (tp, _) = db::connect(&scoped, None, None).await.unwrap();
    pg_exec(&tp, "CREATE TABLE t_items (id int PRIMARY KEY)").await;
    let node = meta::database_tree(&tp, &multi).await.unwrap();
    assert_eq!(node.id, format!("{}/{tmp}", c.id));
    assert!(!node.lazy);
    let ids = tree_ids(&c, std::slice::from_ref(&node));
    assert!(ids.contains(&format!("{}/{tmp}/public/tables/t_items", c.id)), "{ids:?}");
    assert!(!has_suffix(&ids, "/tables/orders"));
    if let Pool::Pg(p) = &tp {
        p.close().await;
    }

    // Empty database field: every connectable database, all lazy.
    let all = Connection { database: None, ..c.clone() };
    let (_m, pp) = open(&all).await;
    let tree = meta::schema_tree(&pp, &all).await.unwrap();
    let labels: Vec<&str> = db_nodes(&tree).iter().map(|n| n.label.as_str()).collect();
    assert!(labels.contains(&"ahsandb_test") && labels.contains(&tmp.as_str()), "{labels:?}");
    assert!(!labels.iter().any(|l| l.starts_with("template")));
    assert!(db_nodes(&tree).iter().all(|n| n.lazy));

    // A listed database that doesn't exist still shows; opening it fails without affecting the others.
    let missing = format!("{tmp}_missing");
    let bad = Connection { database: Some(format!("ahsandb_test, {missing}")), ..c.clone() };
    let tree = meta::schema_tree(&base, &bad).await.unwrap();
    assert_eq!(db_nodes(&tree).len(), 2);
    assert!(db::connect(&Connection { database: Some(missing), ..c.clone() }, None, None).await.is_err());
    assert!(meta::database_tree(&base, &c).await.is_ok());
}

#[tokio::test]
async fn mariadb_filters_listed_databases() {
    let Some(c) = from_env("AHSANDB_TEST_MYSQL", Driver::Mariadb) else { return };
    let (_mgr, pool) = open(&c).await;
    let tree = meta::schema_tree(&pool, &c).await.unwrap();
    let labels: Vec<&str> = db_nodes(&tree).iter().map(|n| n.label.as_str()).collect();
    assert_eq!(labels, ["ahsandb_test"]);
    assert!(has_suffix(&tree_ids(&c, &tree), "/ahsandb_test/tables/orders"));

    // Two entries (one missing): both shown, not lazy; objects only from the listed ones.
    let two = Connection { database: Some("ahsandb_test, ahsandb_t_missing".into()), ..c.clone() };
    let tree = meta::schema_tree(&pool, &two).await.unwrap();
    let dbs = db_nodes(&tree);
    assert_eq!(dbs.iter().map(|n| n.label.as_str()).collect::<Vec<_>>(), ["ahsandb_test", "ahsandb_t_missing"]);
    assert!(dbs.iter().all(|n| !n.lazy));
    assert!(tree_ids(&c, &tree).iter().filter(|i| i.contains("/tables/")).all(|i| i.contains("/ahsandb_test/")));
}
