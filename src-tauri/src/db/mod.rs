//! Connection pools per open connection and running-query tracking for cancel.
pub mod exec;
pub mod meta;
pub mod page;
pub mod preview;
pub mod value;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{ConnectOptions, Connection as _, Executor, Row};
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::model::{Connection, Driver, SslMode};
use crate::ssh::expand_tilde;

pub enum Pool {
    Pg(sqlx::PgPool),
    My(sqlx::MySqlPool),
    Lite(sqlx::SqlitePool),
}

/// A query in flight, kept so `cancel` can reach it.
#[derive(Debug, Clone)]
pub struct Running {
    pub conn_id: String,
    /// PostgreSQL backend pid or MySQL connection id; `None` for SQLite.
    pub server_id: Option<i64>,
}

#[derive(Default)]
pub struct Manager {
    pub pools: Mutex<HashMap<String, Arc<Pool>>>,
    pub running: Mutex<HashMap<String, Running>>,
    /// SSH tunnels of open connections that use one.
    pub tunnels: Mutex<HashMap<String, crate::ssh::Tunnel>>,
    /// Reviewed-but-not-applied plans by preview id.
    pub previews: Mutex<HashMap<String, preview::StoredPreview>>,
    /// Cancel flags of running import/export jobs by job id.
    pub jobs: Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
}

impl Manager {
    /// Pool of an open connection, or `NotFound("Not connected")`.
    pub async fn pool(&self, id: &str) -> AppResult<Arc<Pool>> {
        self.pools.lock().await.get(id).cloned().ok_or_else(|| AppError::NotFound("Not connected".into()))
    }
}

/// Opens a pool and returns it with the server version string (e.g. "PostgreSQL 16.4").
/// Applies SSL mode (+ CA/client cert files), connect timeout and, for read-only connections, a
/// read-only session. With `tunnel_port` the database is reached through `127.0.0.1:<tunnel_port>`
/// (an SSH tunnel opened by the caller) instead of `c.host:c.port`.
pub async fn connect(c: &Connection, password: Option<&str>, tunnel_port: Option<u16>) -> AppResult<(Pool, String)> {
    if c.ssh.is_some() && tunnel_port.is_none() && c.driver != Driver::Sqlite {
        return Err(AppError::Internal("SSH connection opened without its tunnel".into()));
    }
    // shortcut: through a tunnel the driver sees host 127.0.0.1, so verify-full hostname checks fail;
    // fine for CA/Require modes, needs a TLS server-name override if users ask for verify-full over SSH.
    let (host, port) = match tunnel_port {
        Some(p) => (Some("127.0.0.1"), Some(p)),
        None => (c.host.as_deref(), c.port),
    };
    let tunneled = |e: AppError| match (e, tunnel_port) {
        (AppError::Connection(m), Some(_)) => AppError::Connection(format!(
            "{m} (through the SSH tunnel to {}:{})",
            c.host.as_deref().unwrap_or("127.0.0.1"),
            c.port.map(|p| p.to_string()).unwrap_or_else(|| "default port".into())
        )),
        (e, _) => e,
    };
    let secs = c.timeout_secs.unwrap_or(10);
    let timeout = Duration::from_secs(secs);
    let ro = c.read_only;
    // A direct first connection reports the real error (refused, auth); the pool would only say
    // "timed out" because it retries refused connections until acquire_timeout.
    match c.driver {
        Driver::Postgres => {
            let mut o = PgConnectOptions::new().ssl_mode(match c.ssl_mode {
                SslMode::Disable => PgSslMode::Disable,
                SslMode::Prefer => PgSslMode::Prefer,
                SslMode::Require => PgSslMode::Require,
                SslMode::VerifyFull => PgSslMode::VerifyFull,
            });
            let [ca, cert, key] = tls_files(c)?;
            if let Some(p) = ca { o = o.ssl_root_cert(p) }
            if let Some(p) = cert { o = o.ssl_client_cert(p) }
            if let Some(p) = key { o = o.ssl_client_key(p) }
            if let Some(h) = host { o = o.host(h) }
            if let Some(p) = port { o = o.port(p) }
            if let Some(u) = &c.user { o = o.username(u) }
            if let Some(p) = password { o = o.password(p) }
            if let Some(d) = c.base_database() { o = o.database(&d) }
            let v: String = with_timeout(secs, async {
                let mut conn = o.connect().await?;
                let v = sqlx::query("SHOW server_version").fetch_one(&mut conn).await?.try_get_unchecked(0)?;
                conn.close().await?;
                Ok::<_, AppError>(v)
            })
            .await
            .map_err(tunneled)?;
            let pool = PgPoolOptions::new()
                .max_connections(5)
                .acquire_timeout(timeout)
                .after_connect(move |conn, _| {
                    Box::pin(async move {
                        if ro {
                            conn.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY").await?;
                        }
                        Ok(())
                    })
                })
                .connect_lazy_with(o);
            Ok((Pool::Pg(pool), format!("PostgreSQL {}", v.split_whitespace().next().unwrap_or(&v))))
        }
        Driver::Mysql | Driver::Mariadb => {
            let mut o = MySqlConnectOptions::new().ssl_mode(match c.ssl_mode {
                SslMode::Disable => MySqlSslMode::Disabled,
                SslMode::Prefer => MySqlSslMode::Preferred,
                SslMode::Require => MySqlSslMode::Required,
                SslMode::VerifyFull => MySqlSslMode::VerifyIdentity,
            });
            let [ca, cert, key] = tls_files(c)?;
            if let Some(p) = ca { o = o.ssl_ca(p) }
            if let Some(p) = cert { o = o.ssl_client_cert(p) }
            if let Some(p) = key { o = o.ssl_client_key(p) }
            if let Some(h) = host { o = o.host(h) }
            if let Some(p) = port { o = o.port(p) }
            if let Some(u) = &c.user { o = o.username(u) }
            if let Some(p) = password { o = o.password(p) }
            if let Some(d) = c.base_database() { o = o.database(&d) }
            let v: String = with_timeout(secs, async {
                let mut conn = o.connect().await?;
                let v = sqlx::query("SELECT VERSION()").fetch_one(&mut conn).await?.try_get_unchecked(0)?;
                conn.close().await?;
                Ok::<_, AppError>(v)
            })
            .await
            .map_err(tunneled)?;
            let pool = MySqlPoolOptions::new()
                .max_connections(5)
                .acquire_timeout(timeout)
                .after_connect(move |conn, _| {
                    Box::pin(async move {
                        if ro {
                            conn.execute("SET SESSION TRANSACTION READ ONLY").await?;
                        }
                        Ok(())
                    })
                })
                .connect_lazy_with(o);
            let num = v.split('-').next().unwrap_or(&v);
            let label = if v.contains("MariaDB") { format!("MariaDB {num}") } else { format!("MySQL {num}") };
            Ok((Pool::My(pool), label))
        }
        Driver::Sqlite => {
            let path = c.file.as_deref().unwrap_or_default();
            if path.is_empty() || !Path::new(path).is_file() {
                return Err(AppError::Io(format!("File not found: {path}")));
            }
            let o = SqliteConnectOptions::new().filename(path).create_if_missing(false).read_only(ro);
            let pool = SqlitePoolOptions::new().max_connections(5).acquire_timeout(timeout).connect_with(o).await?;
            let v: String = sqlx::query_scalar("select sqlite_version()").fetch_one(&pool).await?;
            Ok((Pool::Lite(pool), format!("SQLite {v}")))
        }
    }
}

/// CA, client certificate and client key paths (`~` expanded); `Io` error if a set file is missing.
fn tls_files(c: &Connection) -> AppResult<[Option<PathBuf>; 3]> {
    let file = |p: &Option<String>| -> AppResult<Option<PathBuf>> {
        let Some(raw) = p.as_deref().filter(|s| !s.trim().is_empty()) else { return Ok(None) };
        let path = expand_tilde(raw);
        if path.is_file() { Ok(Some(path)) } else { Err(AppError::Io(format!("File not found: {raw}"))) }
    };
    Ok([file(&c.ssl_ca_path)?, file(&c.ssl_cert_path)?, file(&c.ssl_key_path)?])
}

async fn with_timeout<T>(secs: u64, fut: impl Future<Output = AppResult<T>>) -> AppResult<T> {
    tokio::time::timeout(Duration::from_secs(secs), fut)
        .await
        .map_err(|_| AppError::Connection(format!("Timed out after {secs}s")))?
}

/// Creates an empty SQLite file at `path`; `Io` error if it exists or the folder is missing.
/// `connect` never creates files, so a mistyped path fails instead of making an empty database.
pub async fn create_sqlite_file(path: &str) -> AppResult<()> {
    let p = Path::new(path);
    if p.exists() {
        return Err(AppError::Io(format!("File already exists: {path}")));
    }
    if let Some(dir) = p.parent()
        && !dir.as_os_str().is_empty()
        && !dir.is_dir()
    {
        return Err(AppError::Io(format!("Folder not found: {}", dir.display())));
    }
    let mut conn = SqliteConnectOptions::new().filename(p).create_if_missing(true).connect().await?;
    sqlx::query("PRAGMA user_version").execute(&mut conn).await?;
    conn.close().await?;
    Ok(())
}
