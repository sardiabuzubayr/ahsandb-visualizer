//! Redis connections (standalone): connect (TLS, through the SSH tunnel), keyspaces, SCAN, values by
//! type, edits from the key browser, the console and INFO.
//!
//! Keys and values are shown as UTF-8 text. shortcut: binary keys are read lossily, so the browser
//! can't edit or delete them; use the console (or add byte-safe keys) when that's needed.
pub mod command;

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use redis::aio::MultiplexedConnection;
use redis::{AsyncConnectionConfig, Client, ConnectionAddr, IntoConnectionInfo, RedisConnectionInfo, RedisError, Value};

use crate::error::{AppError, AppResult};
use crate::model::{
    Connection, KvEdit, KvEntry, KvInfoSection, KvKey, KvReply, KvScanPage, KvStreamEntry, KvValue, NodeKind, SchemaNode, SslMode,
};
use crate::ssh::expand_tilde;
use command::command_line;

/// One multiplexed connection per (connection, database); cheap to clone per call.
pub type Conn = MultiplexedConnection;

/// Longer than this and a reply counts as lost (blocking commands are refused before they run).
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
/// Items loaded per collection and bytes per string in the value viewer.
pub const MAX_ITEMS: usize = 1000;
pub const MAX_BYTES: usize = 1 << 20;
/// SCAN round trips per page, so a sparse match on a huge database still answers quickly.
const SCAN_ROUNDS: usize = 50;

/// Database index from the connection's Database field ("" = 0).
pub fn base_db(c: &Connection) -> AppResult<i64> {
    let d = c.database.as_deref().unwrap_or_default().trim();
    if d.is_empty() {
        return Ok(0);
    }
    parse_db(d)
}

pub fn parse_db(d: &str) -> AppResult<i64> {
    d.parse::<i64>().ok().filter(|n| *n >= 0).ok_or_else(|| AppError::Query(format!("A Redis database is a number (0, 1, …), not {d}")))
}

/// Maps a client error: lost/unreachable → `Connection` (the UI marks the connection lost), bad
/// credentials → `Auth`, everything else (server errors) → `Query`.
pub fn err(e: RedisError) -> AppError {
    if e.is_io_error() || e.is_connection_dropped() || e.is_timeout() {
        return AppError::Connection(e.to_string());
    }
    if e.kind() == redis::ErrorKind::AuthenticationFailed || matches!(e.code(), Some("WRONGPASS" | "NOAUTH")) {
        return AppError::Auth(e.to_string());
    }
    AppError::Query(e.to_string())
}

/// Opens a connection on database `db` and returns it with the server version ("Redis 7.2.4").
/// With `tunnel_port` the server is reached through `127.0.0.1:<tunnel_port>` (an SSH tunnel).
pub async fn connect(c: &Connection, password: Option<&str>, tunnel_port: Option<u16>, db: i64) -> AppResult<(Conn, String)> {
    // rustls is built with both ring and aws-lc-rs (from different dependencies), so it can't pick a
    // provider on its own and would panic on the first TLS connection.
    static PROVIDER: std::sync::Once = std::sync::Once::new();
    PROVIDER.call_once(|| drop(rustls::crypto::ring::default_provider().install_default()));
    if c.ssh.is_some() && tunnel_port.is_none() {
        return Err(AppError::Internal("SSH connection opened without its tunnel".into()));
    }
    // shortcut: through a tunnel the host is 127.0.0.1, so verify-full hostname checks fail (same as SQL).
    let (host, port) = match tunnel_port {
        Some(p) => ("127.0.0.1".to_string(), p),
        None => (c.host.clone().filter(|h| !h.is_empty()).unwrap_or_else(|| "127.0.0.1".into()), c.port.unwrap_or(6379)),
    };
    let addr = match c.ssl_mode {
        // Redis can't negotiate TLS, so "prefer" means plain.
        SslMode::Disable | SslMode::Prefer => ConnectionAddr::Tcp(host, port),
        SslMode::Require => ConnectionAddr::TcpTls { host, port, insecure: true, tls_params: None },
        SslMode::VerifyFull => ConnectionAddr::TcpTls { host, port, insecure: false, tls_params: None },
    };
    let tls = !matches!(addr, ConnectionAddr::Tcp(..));
    let mut settings = RedisConnectionInfo::default().set_db(db);
    if let Some(u) = c.user.as_deref().filter(|u| !u.is_empty()) {
        settings = settings.set_username(u);
    }
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        settings = settings.set_password(p);
    }
    let info = addr.into_connection_info().map_err(err)?.set_redis_settings(settings);
    let read = |p: &Option<String>| -> AppResult<Option<Vec<u8>>> {
        match p.as_deref().filter(|p| !p.trim().is_empty()) {
            None => Ok(None),
            Some(p) => std::fs::read(expand_tilde(p)).map(Some).map_err(|e| AppError::Io(format!("{p}: {e}"))),
        }
    };
    let (ca, cert, key) = (read(&c.ssl_ca_path)?, read(&c.ssl_cert_path)?, read(&c.ssl_key_path)?);
    let client = if tls && (ca.is_some() || cert.is_some()) {
        let client_tls = match (cert, key) {
            (Some(client_cert), Some(client_key)) => Some(redis::ClientTlsConfig { client_cert, client_key }),
            (None, None) => None,
            _ => return Err(AppError::Query("A client certificate needs both the certificate and the key file".into())),
        };
        Client::build_with_tls(info, redis::TlsCertificates { client_tls, root_cert: ca }).map_err(err)?
    } else {
        Client::open(info).map_err(err)?
    };
    let cfg = AsyncConnectionConfig::new()
        .set_connection_timeout(Some(Duration::from_secs(c.timeout_secs.unwrap_or(10))))
        .set_response_timeout(Some(RESPONSE_TIMEOUT));
    let mut conn = client.get_multiplexed_async_connection_with_config(&cfg).await.map_err(|e| {
        let e = err(e);
        match (e, tunnel_port) {
            (AppError::Connection(m), Some(_)) => AppError::Connection(format!(
                "{m} (through the SSH tunnel to {}:{})",
                c.host.as_deref().unwrap_or("127.0.0.1"),
                c.port.unwrap_or(6379)
            )),
            (e, _) => e,
        }
    })?;
    let info: String = redis::cmd("INFO").arg("server").query_async(&mut conn).await.map_err(err)?;
    Ok((conn, server_version(&info)))
}

/// "Redis 7.2.4" / "Valkey 8.0.1" from `INFO server`.
fn server_version(info: &str) -> String {
    let field = |name: &str| info.lines().find_map(|l| l.strip_prefix(name)?.strip_prefix(':').map(str::trim));
    match field("server_name") {
        Some("valkey") => format!("Valkey {}", field("valkey_version").or(field("redis_version")).unwrap_or("?")),
        _ => format!("Redis {}", field("redis_version").unwrap_or("?")),
    }
}

/// Navigator nodes: `db0`, `db1`, … with key counts. Up to 16 configured databases are all listed;
/// with more, only non-empty ones plus `base`.
pub async fn keyspaces(conn: &mut Conn, conn_id: &str, base: i64) -> AppResult<Vec<SchemaNode>> {
    // CONFIG may be renamed or denied (managed services): assume the default 16.
    let configured = match redis::cmd("CONFIG").arg("GET").arg("databases").query_async::<Vec<String>>(conn).await {
        Ok(v) => v.get(1).and_then(|n| n.parse::<i64>().ok()).unwrap_or(16),
        Err(e) if e.is_io_error() || e.is_connection_dropped() => return Err(err(e)),
        Err(_) => 16,
    };
    let info: String = redis::cmd("INFO").arg("keyspace").query_async(conn).await.map_err(err)?;
    let counts = keyspace_counts(&info);
    let mut dbs: Vec<i64> = if configured <= 16 { (0..configured).collect() } else { counts.keys().copied().chain([base]).collect() };
    dbs.sort_unstable();
    dbs.dedup();
    Ok(dbs
        .into_iter()
        .map(|d| SchemaNode {
            id: format!("{conn_id}/db{d}"),
            label: format!("db{d}"),
            kind: NodeKind::Keyspace,
            count: Some(counts.get(&d).copied().unwrap_or(0)),
            schema: Some(d.to_string()),
            children: None,
            lazy: false,
            size: None,
        })
        .collect())
}

/// `db0:keys=12,expires=0,avg_ttl=0` lines → {0: 12}.
fn keyspace_counts(info: &str) -> HashMap<i64, u64> {
    info.lines()
        .filter_map(|l| {
            let (db, rest) = l.trim().strip_prefix("db")?.split_once(':')?;
            let keys = rest.split(',').find_map(|kv| kv.strip_prefix("keys="))?;
            Some((db.parse().ok()?, keys.parse().ok()?))
        })
        .collect()
}

/// Keys matching `pattern` (glob, "" = all), optionally of one type and with (`has_ttl` true) or
/// without (false) an expiry, with type and TTL. Loops SCAN until about `count` keys pass the filters
/// or `SCAN_ROUNDS` round trips; continue from the returned cursor.
pub async fn scan(
    conn: &mut Conn,
    cursor: &str,
    pattern: &str,
    type_filter: Option<&str>,
    has_ttl: Option<bool>,
    count: u32,
) -> AppResult<KvScanPage> {
    let pattern = if pattern.trim().is_empty() { "*" } else { pattern };
    let mut cursor = if cursor.is_empty() { "0".to_string() } else { cursor.to_string() };
    let mut keys: Vec<KvKey> = vec![];
    let mut seen = HashSet::new();
    for _ in 0..SCAN_ROUNDS {
        let mut cmd = redis::cmd("SCAN");
        cmd.arg(&cursor).arg("MATCH").arg(pattern).arg("COUNT").arg(count.max(100));
        if let Some(t) = type_filter.filter(|t| !t.is_empty()) {
            cmd.arg("TYPE").arg(t);
        }
        let (next, batch): (String, Vec<Vec<u8>>) = cmd.query_async(conn).await.map_err(err)?;
        cursor = next;
        // SCAN may return a key twice while the table rehashes.
        let names: Vec<Vec<u8>> = batch.into_iter().filter(|k| seen.insert(k.clone())).collect();
        if !names.is_empty() {
            // ignore_errors: a refused MEMORY USAGE (ACL, Redis < 4) leaves that key without a size.
            let mut pipe = redis::pipe();
            pipe.ignore_errors();
            for k in &names {
                pipe.cmd("TYPE").arg(k).cmd("PTTL").arg(k).cmd("MEMORY").arg("USAGE").arg(k);
            }
            let replies: Vec<Value> = pipe.query_async(conn).await.map_err(err)?;
            keys.extend(
                names
                    .iter()
                    .zip(replies.chunks(3))
                    .map(|(k, r)| KvKey {
                        key: String::from_utf8_lossy(k).into_owned(),
                        type_name: text_of(&r[0]),
                        ttl_ms: int_of(&r[1]).unwrap_or(-1),
                        memory: int_of(&r[2]).and_then(|n| u64::try_from(n).ok()),
                    })
                    // -2 = deleted between SCAN and PTTL.
                    .filter(|k| k.ttl_ms != -2 && has_ttl.is_none_or(|want| (k.ttl_ms >= 0) == want)),
            );
        }
        if cursor == "0" || keys.len() >= count as usize {
            break;
        }
    }
    Ok(KvScanPage { cursor, keys })
}

/// A key's type, TTL, size and value (first `MAX_ITEMS` items / `MAX_BYTES` bytes).
pub async fn entry(conn: &mut Conn, key: &str) -> AppResult<KvEntry> {
    let (type_name, ttl_ms): (String, i64) = redis::pipe().cmd("TYPE").arg(key).cmd("PTTL").arg(key).query_async(conn).await.map_err(err)?;
    let mut binary = false;
    let mut text = |b: Vec<u8>| match String::from_utf8(b) {
        Ok(s) => s,
        Err(e) => {
            binary = true;
            String::from_utf8_lossy(e.as_bytes()).into_owned()
        }
    };
    let max = MAX_ITEMS as i64;
    let (length, value) = match type_name.as_str() {
        "none" => (0, KvValue::None),
        "string" => {
            let len: u64 = redis::cmd("STRLEN").arg(key).query_async(conn).await.map_err(err)?;
            let bytes: Vec<u8> = redis::cmd("GETRANGE").arg(key).arg(0).arg(MAX_BYTES as i64 - 1).query_async(conn).await.map_err(err)?;
            let value = text(bytes);
            (len, KvValue::String { value, binary: false })
        }
        "hash" => {
            let len: u64 = redis::cmd("HLEN").arg(key).query_async(conn).await.map_err(err)?;
            let flat = scan_collection(conn, "HSCAN", key, 2).await?;
            let entries = flat.chunks(2).map(|p| (text(p[0].clone()), text(p[1].clone()))).collect();
            (len, KvValue::Hash { entries })
        }
        "list" => {
            let len: u64 = redis::cmd("LLEN").arg(key).query_async(conn).await.map_err(err)?;
            let items: Vec<Vec<u8>> = redis::cmd("LRANGE").arg(key).arg(0).arg(max - 1).query_async(conn).await.map_err(err)?;
            (len, KvValue::List { items: items.into_iter().map(&mut text).collect() })
        }
        "set" => {
            let len: u64 = redis::cmd("SCARD").arg(key).query_async(conn).await.map_err(err)?;
            let members = scan_collection(conn, "SSCAN", key, 1).await?;
            (len, KvValue::Set { members: members.into_iter().map(&mut text).collect() })
        }
        "zset" => {
            let len: u64 = redis::cmd("ZCARD").arg(key).query_async(conn).await.map_err(err)?;
            let flat: Vec<(Vec<u8>, f64)> =
                redis::cmd("ZRANGE").arg(key).arg(0).arg(max - 1).arg("WITHSCORES").query_async(conn).await.map_err(err)?;
            (len, KvValue::Zset { entries: flat.into_iter().map(|(m, s)| (text(m), s)).collect() })
        }
        "stream" => {
            let len: u64 = redis::cmd("XLEN").arg(key).query_async(conn).await.map_err(err)?;
            let raw: Vec<(String, Vec<Vec<u8>>)> =
                redis::cmd("XRANGE").arg(key).arg("-").arg("+").arg("COUNT").arg(max).query_async(conn).await.map_err(err)?;
            let entries = raw
                .into_iter()
                .map(|(id, flat)| KvStreamEntry { id, fields: flat.chunks(2).map(|p| (text(p[0].clone()), text(p.get(1).cloned().unwrap_or_default()))).collect() })
                .collect();
            (len, KvValue::Stream { entries })
        }
        _ => (0, KvValue::Other),
    };
    let truncated = match &value {
        KvValue::String { .. } => length > MAX_BYTES as u64,
        KvValue::None | KvValue::Other => false,
        _ => length > MAX_ITEMS as u64,
    };
    let value = match value {
        KvValue::String { value, .. } => KvValue::String { value, binary },
        v => v,
    };
    let memory = memory_usage(conn, key).await;
    Ok(KvEntry { key: key.into(), type_name, ttl_ms, length, truncated, binary, memory, value })
}

/// `MEMORY USAGE` in bytes; `None` when missing or refused (ACL, Redis < 4).
async fn memory_usage(conn: &mut Conn, key: &str) -> Option<u64> {
    redis::cmd("MEMORY").arg("USAGE").arg(key).query_async::<Option<u64>>(conn).await.ok().flatten()
}

/// Memory the whole server uses (`used_memory`); Redis has no per-database figure.
pub async fn server_memory(conn: &mut Conn) -> AppResult<Option<u64>> {
    let info: String = redis::cmd("INFO").arg("memory").query_async(conn).await.map_err(err)?;
    Ok(info.lines().find_map(|l| l.strip_prefix("used_memory:")?.trim().parse().ok()))
}

/// HSCAN/SSCAN until `MAX_ITEMS` items (of `width` elements each) or the end; duplicates dropped.
async fn scan_collection(conn: &mut Conn, cmd: &str, key: &str, width: usize) -> AppResult<Vec<Vec<u8>>> {
    let (mut cursor, mut out, mut seen) = ("0".to_string(), vec![], HashSet::new());
    loop {
        let (next, batch): (String, Vec<Vec<u8>>) =
            redis::cmd(cmd).arg(key).arg(&cursor).arg("COUNT").arg(500).query_async(conn).await.map_err(err)?;
        for item in batch.chunks(width) {
            if out.len() / width >= MAX_ITEMS {
                break;
            }
            if seen.insert(item[0].clone()) {
                out.extend(item.iter().cloned());
            }
        }
        cursor = next;
        if cursor == "0" || out.len() / width >= MAX_ITEMS {
            return Ok(out);
        }
    }
}

fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// The commands an edit runs, in order (one MULTI/EXEC). Reads what it needs first: the TTL a
/// string keeps, whether a new key already exists.
pub async fn plan_edit(conn: &mut Conn, e: &KvEdit) -> AppResult<Vec<Vec<String>>> {
    let empty = |k: &str| if k.is_empty() { Err(AppError::Query("The key name is empty".into())) } else { Ok(()) };
    Ok(match e {
        KvEdit::SetString { key, value } => {
            // SET drops the expiry; put the remaining one back (KEEPTTL needs Redis 6).
            let ttl: i64 = redis::cmd("PTTL").arg(key).query_async(conn).await.map_err(err)?;
            let mut v = vec![args(&["SET", key, value])];
            if ttl > 0 {
                v.push(args(&["PEXPIRE", key, &ttl.to_string()]));
            }
            v
        }
        KvEdit::HashSet { key, field, value, replace } => {
            let mut v = vec![];
            if let Some(old) = replace.as_deref().filter(|o| o != field) {
                v.push(args(&["HDEL", key, old]));
            }
            v.push(args(&["HSET", key, field, value]));
            v
        }
        KvEdit::HashDel { key, field } => vec![args(&["HDEL", key, field])],
        KvEdit::ListSet { key, index, value } => vec![args(&["LSET", key, &index.to_string(), value])],
        KvEdit::ListPush { key, value, head } => vec![args(&[if *head { "LPUSH" } else { "RPUSH" }, key, value])],
        KvEdit::ListRemove { key, value } => vec![args(&["LREM", key, "1", value])],
        KvEdit::SetAdd { key, member, replace } => {
            let mut v = vec![];
            if let Some(old) = replace.as_deref().filter(|o| o != member) {
                v.push(args(&["SREM", key, old]));
            }
            v.push(args(&["SADD", key, member]));
            v
        }
        KvEdit::SetRemove { key, member } => vec![args(&["SREM", key, member])],
        KvEdit::ZsetAdd { key, member, score, replace } => {
            if !score.is_finite() {
                return Err(AppError::Query("The score must be a number".into()));
            }
            let mut v = vec![];
            if let Some(old) = replace.as_deref().filter(|o| o != member) {
                v.push(args(&["ZREM", key, old]));
            }
            v.push(args(&["ZADD", key, &score.to_string(), member]));
            v
        }
        KvEdit::ZsetRemove { key, member } => vec![args(&["ZREM", key, member])],
        KvEdit::StreamAdd { key, fields } => {
            if fields.is_empty() {
                return Err(AppError::Query("A stream entry needs at least one field".into()));
            }
            let mut a = args(&["XADD", key, "*"]);
            for (f, v) in fields {
                a.extend([f.clone(), v.clone()]);
            }
            vec![a]
        }
        KvEdit::StreamDel { key, id } => vec![args(&["XDEL", key, id])],
        KvEdit::Expire { key, ttl_secs: Some(s) } if *s <= 0 => return Err(AppError::Query(format!("The TTL must be positive, not {s} ({key})"))),
        KvEdit::Expire { key, ttl_secs: Some(s) } => vec![args(&["EXPIRE", key, &s.to_string()])],
        KvEdit::Expire { key, ttl_secs: None } => vec![args(&["PERSIST", key])],
        KvEdit::Rename { key, to } => {
            empty(to)?;
            vec![args(&["RENAMENX", key, to])]
        }
        KvEdit::Delete { keys } => {
            if keys.is_empty() {
                return Err(AppError::Query("No keys to delete".into()));
            }
            let mut a = args(&["UNLINK"]);
            a.extend(keys.iter().cloned());
            vec![a]
        }
        KvEdit::Create { key, kind, field, value, score, ttl_secs } => {
            empty(key)?;
            let exists: i64 = redis::cmd("EXISTS").arg(key).query_async(conn).await.map_err(err)?;
            if exists > 0 {
                return Err(AppError::Query(format!("A key named {key} already exists")));
            }
            let field = || field.clone().filter(|f| !f.is_empty()).ok_or_else(|| AppError::Query("The field name is empty".into()));
            let first = match kind.as_str() {
                "string" => args(&["SET", key, value]),
                "hash" => args(&["HSET", key, &field()?, value]),
                "list" => args(&["RPUSH", key, value]),
                "set" => args(&["SADD", key, value]),
                "zset" => args(&["ZADD", key, &score.filter(|s| s.is_finite()).unwrap_or(0.0).to_string(), value]),
                "stream" => args(&["XADD", key, "*", &field()?, value]),
                other => return Err(AppError::Query(format!("Unknown key type {other}"))),
            };
            let mut v = vec![first];
            match ttl_secs {
                Some(s) if *s > 0 => v.push(args(&["EXPIRE", key, &s.to_string()])),
                Some(s) if *s <= 0 => return Err(AppError::Query(format!("The TTL must be positive, not {s}"))),
                _ => {}
            }
            v
        }
    })
}

/// Runs planned commands in one MULTI/EXEC; a RENAMENX onto an existing key is an error.
pub async fn run_edit(conn: &mut Conn, cmds: &[Vec<String>]) -> AppResult<()> {
    let mut pipe = redis::pipe();
    pipe.atomic();
    for c in cmds {
        pipe.cmd(&c[0]);
        for a in &c[1..] {
            pipe.arg(a);
        }
    }
    let replies: Vec<Value> = pipe.query_async(conn).await.map_err(err)?;
    if let ([c], [r]) = (cmds, replies.as_slice())
        && c[0] == "RENAMENX"
        && int_of(r) == Some(0)
    {
        return Err(AppError::Query(format!("A key named {} already exists", c[2])));
    }
    Ok(())
}

/// Lines shown for a production confirmation.
pub fn plan_lines(cmds: &[Vec<String>]) -> Vec<String> {
    cmds.iter().map(|c| command_line(c)).collect()
}

/// Runs one console command (already classified). Server errors come back as an `(error)` reply;
/// only connection failures are `Err`.
pub async fn run_command(conn: &mut Conn, a: &[String]) -> AppResult<KvReply> {
    let mut cmd = redis::cmd(&a[0]);
    for x in &a[1..] {
        cmd.arg(x);
    }
    let started = Instant::now();
    let r = cmd.query_async::<Value>(conn).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match r {
        Ok(v) => Ok(KvReply { text: format_reply(&v), error: false, elapsed_ms }),
        Err(e) if e.is_io_error() || e.is_connection_dropped() => Err(err(e)),
        Err(e) => Ok(KvReply { text: format!("(error) {}", server_message(&e)), error: true, elapsed_ms }),
    }
}

/// "ERR unknown command 'X'…" without the client's wrapping.
fn server_message(e: &RedisError) -> String {
    match (e.code(), e.detail()) {
        (Some(code), Some(detail)) => format!("{code} {detail}"),
        _ => e.to_string(),
    }
}

/// Raw `INFO` sections.
pub async fn info(conn: &mut Conn) -> AppResult<Vec<KvInfoSection>> {
    let text: String = redis::cmd("INFO").arg("everything").query_async(conn).await.map_err(err)?;
    Ok(parse_info(&text))
}

pub fn parse_info(text: &str) -> Vec<KvInfoSection> {
    let mut out: Vec<KvInfoSection> = vec![];
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if let Some(name) = line.strip_prefix('#') {
            out.push(KvInfoSection { name: name.trim().into(), fields: vec![] });
        } else if let Some((k, v)) = line.split_once(':') {
            if out.is_empty() {
                out.push(KvInfoSection { name: String::new(), fields: vec![] });
            }
            out.last_mut().unwrap().fields.push((k.into(), v.into()));
        }
    }
    out
}

fn text_of(v: &Value) -> String {
    match v {
        Value::SimpleString(s) => s.clone(),
        Value::BulkString(b) => String::from_utf8_lossy(b).into_owned(),
        Value::Okay => "OK".into(),
        other => format!("{other:?}"),
    }
}

fn int_of(v: &Value) -> Option<i64> {
    match v {
        Value::Int(n) => Some(*n),
        _ => None,
    }
}

/// A reply as redis-cli prints it: `"text"`, `(integer) 1`, `(nil)`, numbered nested arrays.
/// Multi-line bulk replies (INFO, CLIENT LIST) print raw.
pub fn format_reply(v: &Value) -> String {
    match v {
        Value::BulkString(b) if b.windows(2).any(|w| w == b"\r\n") => String::from_utf8_lossy(b).trim_end().to_string(),
        Value::VerbatimString { text, .. } => text.trim_end().to_string(),
        _ => {
            let mut out = String::new();
            write_value(&mut out, v, 0);
            out.trim_end().to_string()
        }
    }
}

fn quoted(b: &[u8]) -> String {
    let mut s = String::from("\"");
    for chunk in b.utf8_chunks() {
        for c in chunk.valid().chars() {
            match c {
                '"' => s.push_str("\\\""),
                '\\' => s.push_str("\\\\"),
                '\n' => s.push_str("\\n"),
                '\r' => s.push_str("\\r"),
                '\t' => s.push_str("\\t"),
                c if (c as u32) < 0x20 => s.push_str(&format!("\\x{:02x}", c as u32)),
                c => s.push(c),
            }
        }
        for byte in chunk.invalid() {
            s.push_str(&format!("\\x{byte:02x}"));
        }
    }
    s.push('"');
    s
}

/// Writes `v` with nested items indented under their `n) ` prefix (`indent` = column of the item).
fn write_value(out: &mut String, v: &Value, indent: usize) {
    let items = |out: &mut String, xs: &[Value], empty: &str| {
        if xs.is_empty() {
            out.push_str(empty);
            out.push('\n');
            return;
        }
        let width = xs.len().to_string().len();
        for (i, x) in xs.iter().enumerate() {
            if i > 0 {
                out.push_str(&" ".repeat(indent));
            }
            let prefix = format!("{:>width$}) ", i + 1);
            out.push_str(&prefix);
            write_value(out, x, indent + prefix.len());
        }
    };
    match v {
        Value::Nil => out.push_str("(nil)\n"),
        Value::Int(n) => out.push_str(&format!("(integer) {n}\n")),
        Value::BulkString(b) => {
            out.push_str(&quoted(b));
            out.push('\n');
        }
        Value::SimpleString(s) => {
            out.push_str(s);
            out.push('\n');
        }
        Value::Okay => out.push_str("OK\n"),
        Value::Double(d) => out.push_str(&format!("(double) {d}\n")),
        Value::Boolean(b) => out.push_str(&format!("({b})\n")),
        Value::VerbatimString { text, .. } => {
            out.push_str(&quoted(text.as_bytes()));
            out.push('\n');
        }
        Value::Array(xs) | Value::Set(xs) => items(out, xs, "(empty array)"),
        Value::Map(pairs) => {
            let flat: Vec<Value> = pairs.iter().flat_map(|(k, v)| [k.clone(), v.clone()]).collect();
            items(out, &flat, "(empty map)")
        }
        Value::ServerError(e) => {
            out.push_str(&format!("(error) {} {}\n", e.code(), e.details().unwrap_or_default()));
        }
        Value::Attribute { data, .. } => write_value(out, data, indent),
        Value::Push { data, .. } => items(out, data, "(empty array)"),
        other => out.push_str(&format!("{other:?}\n")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_print_like_redis_cli() {
        let b = |s: &str| Value::BulkString(s.as_bytes().to_vec());
        assert_eq!(format_reply(&Value::Nil), "(nil)");
        assert_eq!(format_reply(&Value::Int(3)), "(integer) 3");
        assert_eq!(format_reply(&b("a\"b\n")), r#""a\"b\n""#);
        assert_eq!(format_reply(&Value::BulkString(vec![0x61, 0xff])), r#""a\xff""#);
        assert_eq!(format_reply(&Value::Okay), "OK");
        assert_eq!(format_reply(&Value::Array(vec![])), "(empty array)");
        let nested = Value::Array(vec![b("0"), Value::Array(vec![b("k1"), b("k2")])]);
        assert_eq!(format_reply(&nested), "1) \"0\"\n2) 1) \"k1\"\n   2) \"k2\"");
        assert_eq!(format_reply(&b("# Server\r\nredis_version:7.0\r\n")), "# Server\r\nredis_version:7.0");
    }

    #[test]
    fn parses_info_and_keyspace() {
        let text = "# Server\r\nredis_version:7.0.5\r\nserver_name:valkey\r\nvalkey_version:8.0.1\r\n\r\n# Keyspace\r\ndb0:keys=12,expires=1,avg_ttl=0\r\ndb3:keys=2,expires=0,avg_ttl=0\r\n";
        let s = parse_info(text);
        assert_eq!(s.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["Server", "Keyspace"]);
        assert_eq!(s[0].fields[0], ("redis_version".to_string(), "7.0.5".to_string()));
        assert_eq!(keyspace_counts(text), HashMap::from([(0, 12), (3, 2)]));
        assert_eq!(server_version(text), "Valkey 8.0.1");
        assert_eq!(server_version("redis_version:7.2.4\r\n"), "Redis 7.2.4");
    }

    #[test]
    fn database_index_parses() {
        assert_eq!(parse_db("3").unwrap(), 3);
        assert!(parse_db("-1").is_err() && parse_db("app").is_err());
    }
}
