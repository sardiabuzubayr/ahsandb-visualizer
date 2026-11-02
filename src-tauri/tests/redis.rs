//! Runs only when AHSANDB_TEST_REDIS is set (`redis://127.0.0.1:6379/<db>`). Every key the tests touch
//! starts with `ahsandb_t_<random>:` and is deleted at the end, so other data is left alone.
//! AHSANDB_TEST_REDIS_AUTH (`redis://user@host:port/0`) + AHSANDB_TEST_REDIS_PASSWORD add the auth test.
mod common;

use ahsandb_lib::error::AppError;
use ahsandb_lib::kv::{self, command};
use ahsandb_lib::model::*;
use common::*;

fn redis() -> Option<Connection> {
    from_env("AHSANDB_TEST_REDIS", Driver::Redis)
}

async fn open(c: &Connection) -> kv::Conn {
    kv::connect(c, None, None, kv::base_db(c).unwrap()).await.expect("connect").0
}

fn a(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

async fn run(conn: &mut kv::Conn, v: &[&str]) -> KvReply {
    kv::run_command(conn, &a(v)).await.unwrap()
}

async fn edit(conn: &mut kv::Conn, e: KvEdit) -> Result<(), AppError> {
    let cmds = kv::plan_edit(conn, &e).await?;
    kv::run_edit(conn, &cmds).await
}

#[tokio::test]
async fn connect_version_and_errors() {
    let Some(c) = redis() else { return };
    let (_, version) = kv::connect(&c, None, None, 0).await.unwrap();
    assert!(version.starts_with("Redis ") || version.starts_with("Valkey "), "{version}");
    let dead = Connection { port: Some(1), ..c.clone() };
    assert!(matches!(kv::connect(&dead, None, None, 0).await, Err(AppError::Connection(_))));
    let bad_db = Connection { database: Some("app".into()), ..c };
    assert!(matches!(kv::base_db(&bad_db), Err(AppError::Query(_))));
}

#[tokio::test]
async fn browse_edit_and_console() {
    let Some(c) = redis() else { return };
    let mut conn = open(&c).await;
    let p = format!("ahsandb_t_{}:", rand_suffix());
    let k = |s: &str| format!("{p}{s}");
    for (kind, field, value, score) in [
        ("string", None, "hello", None),
        ("hash", Some("name"), "Ahmad", None),
        ("list", None, "a", None),
        ("set", None, "x", None),
        ("zset", None, "m", Some(2.5)),
        ("stream", Some("ev"), "start", None),
    ] {
        let e = KvEdit::Create { key: k(kind), kind: kind.into(), field: field.map(String::from), value: value.into(), score, ttl_secs: None };
        edit(&mut conn, e).await.unwrap();
    }
    let dup = KvEdit::Create { key: k("string"), kind: "string".into(), field: None, value: "x".into(), score: None, ttl_secs: None };
    assert!(matches!(edit(&mut conn, dup).await, Err(AppError::Query(m)) if m.contains("already exists")));

    // SCAN: pattern, type filter, type + TTL per key.
    let page = kv::scan(&mut conn, "0", &format!("{p}*"), None, None, 100).await.unwrap();
    let mut seen: Vec<_> = page.keys.iter().map(|x| (x.key.trim_start_matches(&p).to_string(), x.type_name.clone(), x.ttl_ms)).collect();
    seen.sort();
    assert_eq!(seen.len(), 6, "{seen:?}");
    assert!(seen.iter().all(|(name, t, ttl)| name == t && *ttl == -1), "{seen:?}");
    assert!(page.keys.iter().all(|x| x.memory.is_some_and(|b| b > 0)), "MEMORY USAGE per key");
    assert!(kv::server_memory(&mut conn).await.unwrap().is_some_and(|b| b > 0));
    let hashes = kv::scan(&mut conn, "0", &format!("{p}*"), Some("hash"), None, 100).await.unwrap();
    assert_eq!(hashes.keys.iter().map(|x| x.key.clone()).collect::<Vec<_>>(), [k("hash")]);

    // Values by type and the edits on them.
    edit(&mut conn, KvEdit::Expire { key: k("string"), ttl_secs: Some(100) }).await.unwrap();
    let names = |page: KvScanPage| page.keys.into_iter().map(|x| x.key).collect::<Vec<_>>();
    let expiring = kv::scan(&mut conn, "0", &format!("{p}*"), None, Some(true), 100).await.unwrap();
    assert_eq!(names(expiring), [k("string")]);
    let lasting = kv::scan(&mut conn, "0", &format!("{p}*"), None, Some(false), 100).await.unwrap();
    assert_eq!(lasting.keys.len(), 5);
    assert!(!names(lasting).contains(&k("string")));
    edit(&mut conn, KvEdit::SetString { key: k("string"), value: "héllo\nworld".into() }).await.unwrap();
    let e = kv::entry(&mut conn, &k("string")).await.unwrap();
    assert_eq!(e.value, KvValue::String { value: "héllo\nworld".into(), binary: false });
    assert!(e.ttl_ms > 90_000, "SET kept the TTL: {}", e.ttl_ms);
    assert!(e.memory.is_some_and(|b| b > 0));
    assert_eq!(e.length, 12);

    edit(&mut conn, KvEdit::HashSet { key: k("hash"), field: "city".into(), value: "Bandung".into(), replace: None }).await.unwrap();
    edit(&mut conn, KvEdit::HashSet { key: k("hash"), field: "full_name".into(), value: "Ahmad".into(), replace: Some("name".into()) }).await.unwrap();
    let KvValue::Hash { mut entries } = kv::entry(&mut conn, &k("hash")).await.unwrap().value else { panic!() };
    entries.sort();
    assert_eq!(entries, [("city".to_string(), "Bandung".to_string()), ("full_name".to_string(), "Ahmad".to_string())]);
    edit(&mut conn, KvEdit::HashDel { key: k("hash"), field: "city".into() }).await.unwrap();

    edit(&mut conn, KvEdit::ListPush { key: k("list"), value: "b".into(), head: false }).await.unwrap();
    edit(&mut conn, KvEdit::ListPush { key: k("list"), value: "z".into(), head: true }).await.unwrap();
    edit(&mut conn, KvEdit::ListSet { key: k("list"), index: 1, value: "A".into() }).await.unwrap();
    edit(&mut conn, KvEdit::ListRemove { key: k("list"), value: "z".into() }).await.unwrap();
    assert_eq!(kv::entry(&mut conn, &k("list")).await.unwrap().value, KvValue::List { items: a(&["A", "b"]) });

    edit(&mut conn, KvEdit::SetAdd { key: k("set"), member: "y".into(), replace: Some("x".into()) }).await.unwrap();
    assert_eq!(kv::entry(&mut conn, &k("set")).await.unwrap().value, KvValue::Set { members: a(&["y"]) });

    edit(&mut conn, KvEdit::ZsetAdd { key: k("zset"), member: "n".into(), score: 1.0, replace: None }).await.unwrap();
    assert_eq!(kv::entry(&mut conn, &k("zset")).await.unwrap().value, KvValue::Zset { entries: vec![("n".into(), 1.0), ("m".into(), 2.5)] });

    edit(&mut conn, KvEdit::StreamAdd { key: k("stream"), fields: vec![("ev".into(), "stop".into())] }).await.unwrap();
    let KvValue::Stream { entries } = kv::entry(&mut conn, &k("stream")).await.unwrap().value else { panic!() };
    assert_eq!(entries.iter().map(|x| x.fields[0].1.as_str()).collect::<Vec<_>>(), ["start", "stop"]);
    edit(&mut conn, KvEdit::StreamDel { key: k("stream"), id: entries[0].id.clone() }).await.unwrap();
    assert_eq!(kv::entry(&mut conn, &k("stream")).await.unwrap().length, 1);

    // Rename refuses to overwrite; TTL can be removed again.
    let clash = edit(&mut conn, KvEdit::Rename { key: k("set"), to: k("list") }).await;
    assert!(matches!(clash, Err(AppError::Query(m)) if m.contains("already exists")));
    edit(&mut conn, KvEdit::Rename { key: k("set"), to: k("set2") }).await.unwrap();
    edit(&mut conn, KvEdit::Expire { key: k("string"), ttl_secs: None }).await.unwrap();
    assert_eq!(kv::entry(&mut conn, &k("string")).await.unwrap().ttl_ms, -1);
    assert!(edit(&mut conn, KvEdit::Expire { key: k("string"), ttl_secs: Some(0) }).await.is_err());

    // Large collections load only the first MAX_ITEMS items.
    let mut big = vec!["RPUSH".to_string(), k("big")];
    big.extend((0..kv::MAX_ITEMS + 5).map(|i| i.to_string()));
    kv::run_command(&mut conn, &big).await.unwrap();
    let e = kv::entry(&mut conn, &k("big")).await.unwrap();
    assert!(e.truncated && e.length == kv::MAX_ITEMS as u64 + 5);
    assert!(matches!(e.value, KvValue::List { items } if items.len() == kv::MAX_ITEMS));

    // Console replies print like redis-cli; server errors are replies, not failures.
    assert_eq!(run(&mut conn, &["HGET", &k("hash"), "full_name"]).await.text, "\"Ahmad\"");
    assert_eq!(run(&mut conn, &["GET", &k("missing")]).await.text, "(nil)");
    let r = run(&mut conn, &["NOSUCHCOMMAND"]).await;
    assert!(r.error && r.text.starts_with("(error) ERR"), "{}", r.text);
    assert!(kv::parse_info(&run(&mut conn, &["INFO", "server"]).await.text).iter().any(|s| s.name == "Server"));
    assert!(kv::info(&mut conn).await.unwrap().iter().any(|s| s.name == "Keyspace"));

    // The keyspace count includes our keys.
    let db = kv::base_db(&c).unwrap();
    let nodes = kv::keyspaces(&mut conn, "c", db).await.unwrap();
    let node = nodes.iter().find(|n| n.label == format!("db{db}")).expect("our db is listed");
    assert!(node.count.unwrap() >= 7 && node.kind == NodeKind::Keyspace && node.schema.as_deref() == Some(&*db.to_string()));

    let ours = kv::scan(&mut conn, "0", &format!("{p}*"), None, None, 1000).await.unwrap().keys;
    edit(&mut conn, KvEdit::Delete { keys: ours.into_iter().map(|x| x.key).collect() }).await.unwrap();
    assert!(kv::scan(&mut conn, "0", &format!("{p}*"), None, None, 100).await.unwrap().keys.is_empty());
}

#[tokio::test]
async fn other_database_index_is_separate() {
    let Some(c) = redis() else { return };
    let base = kv::base_db(&c).unwrap();
    let other = if base == 1 { 2 } else { 1 };
    let (mut a_conn, _) = kv::connect(&c, None, None, base).await.unwrap();
    let (mut b_conn, _) = kv::connect(&c, None, None, other).await.unwrap();
    let key = format!("ahsandb_t_{}:k", rand_suffix());
    run(&mut b_conn, &["SET", &key, "1"]).await;
    assert_eq!(run(&mut a_conn, &["EXISTS", &key]).await.text, "(integer) 0");
    assert_eq!(run(&mut b_conn, &["DEL", &key]).await.text, "(integer) 1");
}

#[tokio::test]
async fn blocked_commands_are_classified() {
    // Pure check, but kept here so the console's refusal list sits next to the console tests.
    for line in ["SELECT 1", "MONITOR", "BLPOP q 0", "MULTI", "SHUTDOWN NOSAVE", "subscribe ch"] {
        let args = command::split_args(line).unwrap();
        assert!(matches!(command::classify(&args), command::CmdClass::Blocked(_)), "{line}");
    }
}

#[tokio::test]
async fn auth_errors() {
    let (Some(c), Ok(password)) = (from_env("AHSANDB_TEST_REDIS_AUTH", Driver::Redis), std::env::var("AHSANDB_TEST_REDIS_PASSWORD")) else {
        return;
    };
    assert!(kv::connect(&c, Some(&password), None, 0).await.is_ok());
    assert!(matches!(kv::connect(&c, Some("wrong"), None, 0).await, Err(AppError::Auth(_))));
    assert!(matches!(kv::connect(&c, None, None, 0).await.map(|_| ()), Err(AppError::Auth(_)) | Err(AppError::Query(_))));
}

/// AHSANDB_TEST_REDIS_TLS (`redis://localhost:<tls port>/0`) + AHSANDB_TEST_REDIS_CA (CA file of the server cert).
#[tokio::test]
async fn tls_modes() {
    let (Some(c), Ok(ca)) = (from_env("AHSANDB_TEST_REDIS_TLS", Driver::Redis), std::env::var("AHSANDB_TEST_REDIS_CA")) else { return };
    let with = |ssl_mode, ca: Option<&str>| Connection { ssl_mode, ssl_ca_path: ca.map(String::from), ..c.clone() };
    assert!(kv::connect(&with(SslMode::Require, None), None, None, 0).await.is_ok(), "require skips verification");
    assert!(kv::connect(&with(SslMode::VerifyFull, Some(&ca)), None, None, 0).await.is_ok(), "verify-full with the CA");
    assert!(kv::connect(&with(SslMode::VerifyFull, None), None, None, 0).await.is_err(), "unknown CA is refused");
    assert!(kv::connect(&with(SslMode::Disable, None), None, None, 0).await.is_err(), "plain TCP to a TLS port");
}

/// AHSANDB_TEST_REDIS_NOMEM (`redis://user@host:port/0`, an ACL user without `MEMORY`) +
/// AHSANDB_TEST_REDIS_NOMEM_PASSWORD: keys still list, just without sizes.
#[tokio::test]
async fn refused_memory_usage_means_no_size() {
    let (Some(c), Ok(password)) = (from_env("AHSANDB_TEST_REDIS_NOMEM", Driver::Redis), std::env::var("AHSANDB_TEST_REDIS_NOMEM_PASSWORD")) else {
        return;
    };
    let (mut conn, _) = kv::connect(&c, Some(&password), None, 0).await.unwrap();
    let key = format!("ahsandb_t_{}:k", rand_suffix());
    run(&mut conn, &["SET", &key, "v"]).await;
    let page = kv::scan(&mut conn, "0", &key, None, None, 10).await.unwrap();
    assert_eq!(page.keys.len(), 1);
    assert_eq!((page.keys[0].type_name.as_str(), page.keys[0].memory), ("string", None));
    assert_eq!(kv::entry(&mut conn, &key).await.unwrap().memory, None);
    run(&mut conn, &["DEL", &key]).await;
}
