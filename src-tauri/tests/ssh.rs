//! SSH tunnel tests against a throwaway sshd. Run only with AHSANDB_TEST_SSHD=1; the database parts
//! also need AHSANDB_TEST_PG / AHSANDB_TEST_MYSQL.
mod common;

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use ahsandb_lib::db::{self, Pool};
use ahsandb_lib::error::{AppError, AppResult};
use ahsandb_lib::model::*;
use ahsandb_lib::ssh::{self, SshSecrets, Tunnel};
use common::sshd::{self, Sshd};
use tokio::io::AsyncReadExt;

fn no_lost() -> Box<dyn FnOnce(String) + Send> {
    Box::new(|_| {})
}

fn secrets(passphrase: Option<&str>) -> SshSecrets {
    SshSecrets { password: None, passphrase: passphrase.map(String::from) }
}

/// Opens a tunnel to `target_port` on the sshd host, trusting the fixture host key.
async fn tunnel(s: &Sshd, cfg: &SshConfig, sec: &SshSecrets, target_port: u16) -> AppResult<Tunnel> {
    ssh::open_tunnel(cfg, sec, "127.0.0.1", target_port, None, Some(&s.host_key_line()), no_lost()).await
}

/// Nothing holds `port` any more. Retried briefly: macOS keeps a just-closed accepted socket in
/// LAST_ACK for a moment, which blocks bind even with SO_REUSEADDR.
async fn port_is_free(port: u16) -> bool {
    for _ in 0..20 {
        if tokio::net::TcpListener::bind(("127.0.0.1", port)).await.is_ok() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

async fn banner(port: u16) -> String {
    let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut buf = [0u8; 7];
    tokio::time::timeout(Duration::from_secs(5), sock.read_exact(&mut buf)).await.unwrap().unwrap();
    String::from_utf8_lossy(&buf).into_owned()
}

#[tokio::test]
async fn host_key_unknown_mismatch_and_known_hosts() {
    let Some(s) = sshd::start() else { return };
    let cfg = s.cfg(SshAuth::Key, Some("client"));
    let err = ssh::open_tunnel(&cfg, &secrets(None), "127.0.0.1", 1, None, None, no_lost()).await.err().expect("must fail");
    let AppError::HostKeyUnknown(info) = err else { panic!("{err:?}") };
    assert_eq!(info, HostKeyInfo {
        host: "127.0.0.1".into(),
        port: s.port,
        algorithm: "ssh-ed25519".into(),
        fingerprint: s.fingerprint(),
        key: s.host_key_line(),
    });

    let other = std::fs::read_to_string(s.path("stranger.pub")).unwrap();
    let err = ssh::open_tunnel(&cfg, &secrets(None), "127.0.0.1", 1, None, Some(&other), no_lost()).await.err().expect("must fail");
    assert!(matches!(&err, AppError::HostKeyMismatch(i) if i.fingerprint == s.fingerprint()), "{err:?}");

    // A `[host]:port` entry in a known_hosts file is accepted without a trusted key.
    let known = s.path("known_hosts");
    std::fs::write(&known, format!("[127.0.0.1]:{} {}\n", s.port, s.host_key_line())).unwrap();
    let t = ssh::open_tunnel(&cfg, &secrets(None), "127.0.0.1", s.port, Some(&known), None, no_lost()).await.unwrap();
    t.close().await;
}

#[tokio::test]
async fn key_auth_forwards_and_close_frees_port() {
    let Some(s) = sshd::start() else { return };
    let (tx, mut rx) = tokio::sync::oneshot::channel::<String>();
    let on_lost: Box<dyn FnOnce(String) + Send> = Box::new(move |m| {
        let _ = tx.send(m);
    });
    let cfg = s.cfg(SshAuth::Key, Some("client"));
    // Tunnel to the sshd port itself: the forwarded socket must greet with the SSH banner.
    let t = ssh::open_tunnel(&cfg, &secrets(None), "127.0.0.1", s.port, None, Some(&s.host_key_line()), on_lost)
        .await
        .unwrap();
    let port = t.local_port;
    assert_eq!(banner(port).await, "SSH-2.0");
    assert_eq!(banner(port).await, "SSH-2.0");
    t.close().await;
    assert!(port_is_free(port).await, "port still in use after close");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(rx.try_recv().is_err(), "on_lost must not run after close");

    // RSA key, signed with the server's best RSA hash.
    let t = tunnel(&s, &s.cfg(SshAuth::Key, Some("client_rsa")), &secrets(None), s.port).await.unwrap();
    assert_eq!(banner(t.local_port).await, "SSH-2.0");
    t.close().await;
}

#[tokio::test]
async fn key_auth_failures() {
    let Some(s) = sshd::start() else { return };
    let user = std::env::var("USER").unwrap();
    let err = tunnel(&s, &s.cfg(SshAuth::Key, Some("stranger")), &secrets(None), 1).await.err().unwrap();
    assert!(matches!(&err, AppError::Auth(m) if *m == format!("SSH authentication failed for {user}@127.0.0.1")), "{err:?}");

    let err = tunnel(&s, &s.cfg(SshAuth::Key, Some("missing_key")), &secrets(None), 1).await.err().unwrap();
    assert!(matches!(&err, AppError::Auth(m) if m.contains("not found")), "{err:?}");

    let enc = s.cfg(SshAuth::Key, Some("client_enc"));
    let err = tunnel(&s, &enc, &secrets(None), 1).await.err().unwrap();
    assert!(matches!(&err, AppError::Auth(m) if m.contains("passphrase required")), "{err:?}");
    let err = tunnel(&s, &enc, &secrets(Some("wrong")), 1).await.err().unwrap();
    assert!(matches!(&err, AppError::Auth(m) if m.contains("passphrase")), "{err:?}");
    let t = tunnel(&s, &enc, &secrets(Some("secret")), s.port).await.unwrap();
    assert_eq!(banner(t.local_port).await, "SSH-2.0");
    t.close().await;

    let err = tunnel(&s, &s.cfg(SshAuth::Password, None), &secrets(None), 1).await.err().unwrap();
    assert!(matches!(&err, AppError::Auth(m) if m == "SSH password required"), "{err:?}");
}

#[tokio::test]
async fn agent_auth() {
    let Some(s) = sshd::start() else { return };
    let sock = s.path("agent.sock");
    let mut agent = Command::new("ssh-agent").arg("-D").arg("-a").arg(&sock).stdout(Stdio::null()).spawn().unwrap();
    for _ in 0..100 {
        if sock.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let cfg = s.cfg(SshAuth::Agent, None);
    let open = |sock: &Path| {
        let (cfg, key, sock) = (cfg.clone(), s.host_key_line(), sock.to_path_buf());
        async move {
            ssh::open_tunnel_with_agent(&cfg, &secrets(None), "127.0.0.1", 1, None, Some(&key), no_lost(), Some(&sock)).await
        }
    };
    let err = open(&sock).await.err().unwrap();
    assert!(matches!(&err, AppError::Auth(m) if m == "No SSH agent identities available"), "{err:?}");
    let err = open(&s.path("nope.sock")).await.err().unwrap();
    assert!(matches!(&err, AppError::Auth(m) if m.contains("agent unreachable")), "{err:?}");

    // A key the server rejects, then the authorized one: every identity is tried.
    for key in ["stranger", "client"] {
        sshd::run(Command::new("ssh-add").arg("-q").arg(s.path(key)).env("SSH_AUTH_SOCK", &sock));
    }
    let t = open(&sock).await.unwrap();
    t.close().await;
    let _ = agent.kill();
    let _ = agent.wait();
}

#[tokio::test]
async fn unreachable_server_is_connection_error() {
    if std::env::var("AHSANDB_TEST_SSHD").as_deref() != Ok("1") {
        eprintln!("skipped: AHSANDB_TEST_SSHD not set");
        return;
    }
    let cfg = SshConfig { host: "127.0.0.1".into(), port: sshd::free_port(), user: "u".into(), auth: SshAuth::Agent, key_path: None, keepalive_secs: None };
    let err = ssh::open_tunnel(&cfg, &secrets(None), "127.0.0.1", 1, None, None, no_lost()).await.err().unwrap();
    assert!(matches!(&err, AppError::Connection(m) if m.starts_with("SSH: ") && m.contains("127.0.0.1")), "{err:?}");
}

fn dial(s: &Sshd) -> ssh::Dial {
    ssh::Dial {
        cfg: s.cfg(SshAuth::Key, Some("client")),
        secrets: secrets(None),
        known_hosts: None,
        trusted: Some(s.host_key_line()),
        agent_sock: None,
    }
}

const QUICK: [Duration; 3] = [Duration::from_millis(200), Duration::from_millis(400), Duration::from_millis(800)];

#[tokio::test]
async fn killing_sshd_reports_lost_after_reconnect_attempts() {
    let Some(mut s) = sshd::start() else { return };
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let on_lost: Box<dyn FnOnce(String) + Send> = Box::new(move |m| {
        let _ = tx.send(m);
    });
    let t = ssh::open_tunnel_with(dial(&s), "127.0.0.1", s.port, on_lost, QUICK.to_vec()).await.unwrap();
    s.kill();
    let msg = tokio::time::timeout(Duration::from_secs(10), rx).await.expect("on_lost after the retries").unwrap();
    assert!(msg.contains("lost"), "{msg}");
    // The accept loop stops with the session.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(port_is_free(t.local_port).await, "accept loop still listening");
    t.close().await;
}

#[tokio::test]
async fn tunnel_reconnects_on_the_same_port_when_sshd_comes_back() {
    let Some(mut s) = sshd::start() else { return };
    let (tx, mut rx) = tokio::sync::oneshot::channel::<String>();
    let on_lost: Box<dyn FnOnce(String) + Send> = Box::new(move |m| {
        let _ = tx.send(m);
    });
    // Generous schedule: sshd is back well before it runs out.
    let delays = vec![Duration::from_millis(300); 20];
    let t = ssh::open_tunnel_with(dial(&s), "127.0.0.1", s.port, on_lost, delays).await.unwrap();
    assert!(banner(t.local_port).await.starts_with("SSH-2.0"));
    s.kill();
    tokio::time::sleep(Duration::from_millis(500)).await;
    s.restart();
    // A new connection on the same local port goes through the restored session.
    let mut ok = false;
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if tokio::time::timeout(Duration::from_secs(3), banner(t.local_port)).await.is_ok_and(|b| b.starts_with("SSH-2.0")) {
            ok = true;
            break;
        }
    }
    assert!(ok, "tunnel did not recover");
    assert!(rx.try_recv().is_err(), "on_lost must not run when the reconnect succeeds");
    t.close().await;
}

async fn query_one(pool: &Pool) -> i64 {
    match pool {
        Pool::Pg(p) => sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(p).await.unwrap().into(),
        Pool::My(p) => sqlx::query_scalar::<_, i64>("SELECT 1").fetch_one(p).await.unwrap(),
        Pool::Lite(_) => unreachable!(),
    }
}

#[tokio::test]
async fn databases_through_tunnel() {
    let Some(s) = sshd::start() else { return };
    let cfg = s.cfg(SshAuth::Key, Some("client"));
    for (var, driver, default_port) in [("AHSANDB_TEST_PG", Driver::Postgres, 5432), ("AHSANDB_TEST_MYSQL", Driver::Mysql, 3306)] {
        let Some(mut c) = common::from_env(var, driver) else { continue };
        c.ssh = Some(cfg.clone());
        let host = c.host.clone().unwrap();
        let port = c.port.unwrap_or(default_port);
        let t = ssh::open_tunnel(&cfg, &secrets(None), &host, port, None, Some(&s.host_key_line()), no_lost()).await.unwrap();
        let (pool, version) = db::connect(&c, None, Some(t.local_port)).await.unwrap();
        assert!(!version.is_empty());
        assert_eq!(query_one(&pool).await, 1);
        t.close().await;

        // Target closed on the bastion: the DB error names the target through SSH.
        let dead = sshd::free_port();
        let t = ssh::open_tunnel(&cfg, &secrets(None), "127.0.0.1", dead, None, Some(&s.host_key_line()), no_lost()).await.unwrap();
        let c = Connection { host: Some("127.0.0.1".into()), port: Some(dead), ..c };
        let err = db::connect(&c, None, Some(t.local_port)).await.err().expect("must fail");
        assert!(matches!(&err, AppError::Connection(m) if m.contains(&format!("SSH tunnel to 127.0.0.1:{dead}"))), "{driver:?}: {err:?}");
        t.close().await;
    }
}

#[tokio::test]
async fn test_ssh_checks_login_and_target() {
    let Some(s) = sshd::start() else { return };
    let ok = ssh::test_ssh(&dial(&s), "127.0.0.1", s.port).await.unwrap();
    assert!(ok.target_reachable, "{ok:?}");
    assert_eq!(ok.target, format!("127.0.0.1:{}", s.port));
    // SSH works, the database host doesn't answer: reported, not an error.
    let dead = sshd::free_port();
    let r = ssh::test_ssh(&dial(&s), "127.0.0.1", dead).await.unwrap();
    assert!(!r.target_reachable && r.target_error.is_some(), "{r:?}");
    // A key the server doesn't accept fails the SSH part itself.
    let mut bad = dial(&s);
    bad.cfg = s.cfg(SshAuth::Key, Some("stranger"));
    assert!(matches!(ssh::test_ssh(&bad, "127.0.0.1", s.port).await, Err(AppError::Auth(_))));
}
