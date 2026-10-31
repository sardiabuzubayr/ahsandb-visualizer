//! SSH tunnels (russh): host key verification, password / key file / agent auth, and local port
//! forwarding to the database host as seen from the SSH server.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, DisconnectReason, Handle};
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::Disconnect;
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::error::{AppError, AppResult};
use crate::model::{HostKeyInfo, SshAuth, SshConfig};

const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Default)]
pub struct SshSecrets {
    pub password: Option<String>,
    pub passphrase: Option<String>,
}

/// The SSH session currently carrying the tunnel; `None` while reconnecting.
type Current = tokio::sync::watch::Sender<Option<Arc<Handle<Client>>>>;

/// A live tunnel. Dropping it without `close` also stops forwarding.
pub struct Tunnel {
    /// Local port on 127.0.0.1 that forwards to the target. It stays the same across reconnects,
    /// so database pools pointed at it keep working.
    pub local_port: u16,
    session: Arc<Current>,
    accept: Option<JoinHandle<()>>,
    supervisor: Option<JoinHandle<()>>,
    /// Set by `close`/drop (or once the loss was reported) so `on_lost` fires at most once.
    closed: Arc<AtomicBool>,
}

impl Tunnel {
    pub async fn close(mut self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Some(s) = self.supervisor.take() {
            s.abort();
        }
        if let Some(accept) = self.accept.take() {
            accept.abort();
            // Awaiting the aborted task drops the listener, so the port is free when close returns.
            let _ = accept.await;
        }
        let current = self.session.borrow().clone();
        if let Some(session) = current {
            let _ = session.disconnect(Disconnect::ByApplication, "", "en").await;
        }
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        for task in [&self.accept, &self.supervisor].into_iter().flatten() {
            task.abort();
        }
    }
}

/// Waits between reconnect attempts after the SSH session drops (≈1 min in total), then gives up
/// and reports the connection lost.
pub const RECONNECT_DELAYS: [Duration; 6] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(15),
    Duration::from_secs(30),
];

/// Expands a leading `~/` to the user's home directory.
pub fn expand_tilde(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), std::env::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

/// Connects to `cfg`, verifies the host key, authenticates, and forwards
/// `127.0.0.1:<random port>` → `target_host:target_port` (resolved by the SSH server).
///
/// Host key rules: accepted if it matches an entry in `known_hosts` (usually `~/.ssh/known_hosts`,
/// read-only) or equals `trusted` (OpenSSH key line from the app store). A different key in either
/// → `HostKeyMismatch`. No entry anywhere → `HostKeyUnknown` (nothing is sent before the user trusts).
/// Auth: `Password` uses `secrets.password`; `Key` loads `cfg.key_path` (OpenSSH/PEM, optional
/// `secrets.passphrase`); `Agent` asks the running ssh-agent (`SSH_AUTH_SOCK`) for identities.
/// Failures: unreachable → `Connection`, rejected credentials → `Auth`, bad key file/passphrase → `Auth`.
/// Keep-alive every `cfg.keepalive_secs` (default 15 s) plus TCP keep-alive on the socket. If the
/// session drops, it reconnects in the background (`RECONNECT_DELAYS`) on the same local port;
/// `on_lost(message)` runs once only when that fails (or the host key/credentials stop working),
/// never after `close`.
pub async fn open_tunnel(
    cfg: &SshConfig,
    secrets: &SshSecrets,
    target_host: &str,
    target_port: u16,
    known_hosts: Option<&Path>,
    trusted: Option<&str>,
    on_lost: Box<dyn FnOnce(String) + Send>,
) -> AppResult<Tunnel> {
    open_tunnel_with_agent(cfg, secrets, target_host, target_port, known_hosts, trusted, on_lost, None).await
}

/// `open_tunnel` with an explicit ssh-agent socket instead of `SSH_AUTH_SOCK` (tests).
#[doc(hidden)]
#[allow(clippy::too_many_arguments)]
pub async fn open_tunnel_with_agent(
    cfg: &SshConfig,
    secrets: &SshSecrets,
    target_host: &str,
    target_port: u16,
    known_hosts: Option<&Path>,
    trusted: Option<&str>,
    on_lost: Box<dyn FnOnce(String) + Send>,
    agent_sock: Option<&Path>,
) -> AppResult<Tunnel> {
    let dial = Dial {
        cfg: cfg.clone(),
        secrets: secrets.clone(),
        known_hosts: known_hosts.map(Path::to_path_buf),
        trusted: trusted.map(str::to_string),
        agent_sock: agent_sock.map(Path::to_path_buf),
    };
    open_tunnel_with(dial, target_host, target_port, on_lost, RECONNECT_DELAYS.to_vec()).await
}

/// Everything needed to (re)open the SSH session.
#[doc(hidden)]
pub struct Dial {
    pub cfg: SshConfig,
    pub secrets: SshSecrets,
    pub known_hosts: Option<PathBuf>,
    pub trusted: Option<String>,
    pub agent_sock: Option<PathBuf>,
}

/// `open_tunnel` with an explicit reconnect schedule (tests use a short one).
#[doc(hidden)]
pub async fn open_tunnel_with(
    dial: Dial,
    target_host: &str,
    target_port: u16,
    on_lost: Box<dyn FnOnce(String) + Send>,
    reconnect: Vec<Duration>,
) -> AppResult<Tunnel> {
    let (session, mut ended, mut reason) = connect_session(&dial).await?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let local_port = listener.local_addr()?.port();
    let (current, watch_rx) = tokio::sync::watch::channel(Some(Arc::new(session)));
    let current = Arc::new(current);
    let accept = tokio::spawn(forward(listener, watch_rx, target_host.to_string(), target_port));
    let closed = Arc::new(AtomicBool::new(false));
    let label = format!("{}:{}", dial.cfg.host, dial.cfg.port);
    let (stop_accept, closed2, current2) = (accept.abort_handle(), closed.clone(), current.clone());
    // Watches the session; the handler is dropped (and `ended` fires) when it ends, whatever the cause.
    let supervisor = tokio::spawn(async move {
        let mut on_lost = Some(on_lost);
        loop {
            let _ = (&mut ended).await;
            if closed2.load(Ordering::SeqCst) {
                return;
            }
            let why = reason.lock().ok().and_then(|mut r| r.take()).unwrap_or_else(|| "session closed".into());
            log::warn!("SSH connection to {label} dropped ({why}); reconnecting");
            let _ = current2.send(None); // new database connections wait for the new session
            let mut failure = why;
            let mut restored = None;
            for delay in &reconnect {
                tokio::time::sleep(*delay).await;
                if closed2.load(Ordering::SeqCst) {
                    return;
                }
                match connect_session(&dial).await {
                    Ok(s) => {
                        restored = Some(s);
                        break;
                    }
                    // A changed host key or rejected credentials won't fix themselves: stop now.
                    Err(e @ (AppError::HostKeyMismatch(_) | AppError::HostKeyUnknown(_) | AppError::Auth(_))) => {
                        failure = e.to_string();
                        break;
                    }
                    Err(e) => failure = e.to_string(),
                }
            }
            match restored {
                Some((session, e, r)) => {
                    log::info!("SSH connection to {label} restored");
                    let _ = current2.send(Some(Arc::new(session)));
                    (ended, reason) = (e, r);
                }
                None => {
                    stop_accept.abort();
                    if !closed2.swap(true, Ordering::SeqCst)
                        && let Some(f) = on_lost.take()
                    {
                        f(format!("SSH connection to {label} lost: {failure}"));
                    }
                    return;
                }
            }
        }
    });
    Ok(Tunnel { local_port, session: current, accept: Some(accept), supervisor: Some(supervisor), closed })
}

/// "Test SSH": opens a session (host key + auth, same rules as `open_tunnel`), then asks the SSH
/// server to connect to `target_host:target_port`. SSH failures are errors; an unreachable target
/// is reported in the result (the SSH part itself worked).
pub async fn test_ssh(dial: &Dial, target_host: &str, target_port: u16) -> AppResult<crate::model::SshTestResult> {
    let started = std::time::Instant::now();
    let (session, _ended, _reason) = connect_session(dial).await?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let target = format!("{target_host}:{target_port}");
    let opened =
        tokio::time::timeout(TIMEOUT, session.channel_open_direct_tcpip(target_host, target_port.into(), "127.0.0.1", 0)).await;
    let target_error = match opened {
        Ok(Ok(channel)) => {
            let _ = channel.close().await;
            None
        }
        Ok(Err(e)) => Some(e.to_string()),
        Err(_) => Some(format!("timed out after {}s", TIMEOUT.as_secs())),
    };
    let _ = session.disconnect(Disconnect::ByApplication, "", "en").await;
    Ok(crate::model::SshTestResult { elapsed_ms, target, target_reachable: target_error.is_none(), target_error })
}

type Session = (Handle<Client>, oneshot::Receiver<()>, Arc<Mutex<Option<String>>>);

/// Opens one SSH session: TCP (keep-alive, no delay), host key check, authentication.
async fn connect_session(d: &Dial) -> AppResult<Session> {
    let cfg = &d.cfg;
    let label = format!("{}:{}", cfg.host, cfg.port);
    let rejected = Arc::new(Mutex::new(None));
    let reason = Arc::new(Mutex::new(None));
    let (ended_tx, ended_rx) = oneshot::channel();
    let handler = Client {
        host: cfg.host.clone(),
        port: cfg.port,
        known_hosts: d.known_hosts.clone(),
        trusted: d.trusted.clone(),
        rejected: rejected.clone(),
        reason: reason.clone(),
        _ended: ended_tx,
    };
    let keepalive = cfg.keepalive_secs.unwrap_or(15);
    let config = Arc::new(client::Config {
        keepalive_interval: (keepalive > 0).then(|| Duration::from_secs(keepalive.into())),
        // Missed replies before the session counts as dead (≈1 min at the default interval).
        keepalive_max: 4,
        inactivity_timeout: None,
        ..Default::default()
    });
    let tcp = match tokio::time::timeout(TIMEOUT, TcpStream::connect((cfg.host.as_str(), cfg.port))).await {
        Err(_) => return Err(AppError::Connection(format!("SSH: timed out connecting to {label}"))),
        Ok(Err(e)) => return Err(AppError::Connection(format!("SSH: {label}: {e}"))),
        Ok(Ok(t)) => t,
    };
    let _ = tcp.set_nodelay(true);
    // OS-level keep-alive too, so NAT/firewalls see traffic even before SSH keep-alives kick in.
    let ka = socket2::TcpKeepalive::new().with_time(Duration::from_secs(30)).with_interval(Duration::from_secs(10));
    let _ = socket2::SockRef::from(&tcp).set_tcp_keepalive(&ka);
    let mut session = match tokio::time::timeout(TIMEOUT, client::connect_stream(config, tcp, handler)).await {
        Err(_) => return Err(AppError::Connection(format!("SSH: timed out connecting to {label}"))),
        Ok(Err(e)) => {
            let host_key = rejected.lock().ok().and_then(|mut r| r.take());
            return Err(host_key.unwrap_or_else(|| AppError::Connection(format!("SSH: {label}: {e}"))));
        }
        Ok(Ok(s)) => s,
    };
    tokio::time::timeout(TIMEOUT, authenticate(&mut session, cfg, &d.secrets, d.agent_sock.as_deref()))
        .await
        .map_err(|_| AppError::Connection(format!("SSH: authentication timed out on {label}")))??;
    Ok((session, ended_rx, reason))
}

/// Accept loop. Connections are polled inside this task (not spawned) so aborting it closes every
/// forwarded socket along with the listener.
async fn forward(listener: TcpListener, session: tokio::sync::watch::Receiver<Option<Arc<Handle<Client>>>>, host: String, port: u16) {
    let mut conns = FuturesUnordered::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((socket, peer)) => conns.push(pipe(socket, peer.port(), session.clone(), host.clone(), port)),
                Err(e) => {
                    log::warn!("SSH tunnel accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
            Some(()) = conns.next(), if !conns.is_empty() => {}
        }
    }
}

async fn pipe(
    mut socket: TcpStream,
    peer_port: u16,
    mut current: tokio::sync::watch::Receiver<Option<Arc<Handle<Client>>>>,
    host: String,
    port: u16,
) {
    // While reconnecting there is no session yet: wait for it (a little longer than the TCP connect timeout).
    let session = match tokio::time::timeout(Duration::from_secs(20), current.wait_for(Option::is_some)).await {
        Ok(Ok(s)) => s.clone().expect("checked by wait_for"),
        _ => return log::warn!("SSH tunnel to {host}:{port}: no SSH session"),
    };
    let opened = session.channel_open_direct_tcpip(host.as_str(), port.into(), "127.0.0.1", peer_port.into()).await;
    drop(session);
    match opened {
        Ok(channel) => {
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
        }
        // Dropping the socket makes the driver fail; db::connect names the target.
        Err(e) => log::warn!("SSH tunnel to {host}:{port} failed: {e}"),
    }
}

async fn authenticate(
    session: &mut Handle<Client>,
    cfg: &SshConfig,
    secrets: &SshSecrets,
    agent_sock: Option<&Path>,
) -> AppResult<()> {
    let user = cfg.user.as_str();
    let lost = |e: russh::Error| AppError::Connection(format!("SSH: {}:{}: {e}", cfg.host, cfg.port));
    let ok = match cfg.auth {
        SshAuth::Password => {
            let password = secrets
                .password
                .as_deref()
                .filter(|p| !p.is_empty())
                .ok_or_else(|| AppError::Auth("SSH password required".into()))?;
            session.authenticate_password(user, password).await.map_err(lost)?.success()
        }
        SshAuth::Key => {
            let key = load_key(cfg.key_path.as_deref(), secrets.passphrase.as_deref())?;
            let hash = rsa_hash(session, key.algorithm().is_rsa()).await.map_err(lost)?;
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
            session.authenticate_publickey(user, key).await.map_err(lost)?.success()
        }
        SshAuth::Agent => agent_auth(session, user, agent_sock).await?,
    };
    if ok { Ok(()) } else { Err(AppError::Auth(format!("SSH authentication failed for {user}@{}", cfg.host))) }
}

/// Hash for RSA signatures: the best one the server accepts (`None` = legacy SHA-1).
async fn rsa_hash(session: &Handle<Client>, is_rsa: bool) -> Result<Option<HashAlg>, russh::Error> {
    Ok(if is_rsa { session.best_supported_rsa_hash().await?.flatten() } else { None })
}

fn load_key(path: Option<&str>, passphrase: Option<&str>) -> AppResult<PrivateKey> {
    use russh::keys::Error as E;
    let raw = path.filter(|p| !p.trim().is_empty()).ok_or_else(|| AppError::Auth("SSH key file not set".into()))?;
    let path = expand_tilde(raw);
    if !path.is_file() {
        return Err(AppError::Auth(format!("SSH key file not found: {}", path.display())));
    }
    let passphrase = passphrase.filter(|p| !p.is_empty());
    russh::keys::load_secret_key(&path, passphrase).map_err(|e| {
        AppError::Auth(match (e, passphrase) {
            (E::KeyIsEncrypted, _) => "SSH key is encrypted: passphrase required".into(),
            (E::UnsupportedKeyType { key_type_string, .. }, _) => format!("Unsupported SSH key type: {key_type_string}"),
            (E::IO(e), _) => format!("Could not read SSH key file {}: {e}", path.display()),
            (e, Some(_)) => format!("Wrong SSH key passphrase (or invalid key file): {e}"),
            (e, None) => format!("Unsupported or invalid SSH key file: {e}"),
        })
    })
}

#[cfg(unix)]
async fn agent_auth(session: &mut Handle<Client>, user: &str, sock: Option<&Path>) -> AppResult<bool> {
    use russh::keys::agent::client::AgentClient;
    let sock = sock
        .map(Path::to_path_buf)
        .or_else(|| std::env::var_os("SSH_AUTH_SOCK").filter(|s| !s.is_empty()).map(PathBuf::from))
        .ok_or_else(|| AppError::Auth("SSH agent not running (SSH_AUTH_SOCK is not set)".into()))?;
    let unreachable = |e: russh::keys::Error| AppError::Auth(format!("SSH agent unreachable: {e}"));
    let mut agent = AgentClient::connect_uds(&sock).await.map_err(unreachable)?;
    let identities = agent.request_identities().await.map_err(unreachable)?;
    if identities.is_empty() {
        return Err(AppError::Auth("No SSH agent identities available".into()));
    }
    for id in identities {
        let key = id.public_key().into_owned();
        let hash = rsa_hash(session, key.algorithm().is_rsa()).await.map_err(|e| AppError::Connection(format!("SSH: {e}")))?;
        let res = session
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await
            .map_err(|e| AppError::Auth(format!("SSH agent signing failed: {e}")))?;
        if res.success() {
            return Ok(true);
        }
    }
    Ok(false)
}

// shortcut: no Pageant / Windows named-pipe agent; add russh's connect_named_pipe when Windows ships.
#[cfg(not(unix))]
async fn agent_auth(_: &mut Handle<Client>, _: &str, _: Option<&Path>) -> AppResult<bool> {
    Err(AppError::Auth("SSH agent is not supported on this platform".into()))
}

struct Client {
    host: String,
    port: u16,
    known_hosts: Option<PathBuf>,
    trusted: Option<String>,
    /// Host key error recorded by `check_server_key`; connect then fails and this is returned.
    rejected: Arc<Mutex<Option<AppError>>>,
    /// Why the session ended (for `on_lost`).
    reason: Arc<Mutex<Option<String>>>,
    _ended: oneshot::Sender<()>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(c) => PublicKey::new(c.public_key().clone(), ""),
        };
        let err = match check_host_key(&self.host, self.port, &key, self.known_hosts.as_deref(), self.trusted.as_deref()) {
            HostKeyCheck::Accept => return Ok(true),
            HostKeyCheck::Unknown(info) => AppError::HostKeyUnknown(info),
            HostKeyCheck::Mismatch(info) => AppError::HostKeyMismatch(info),
        };
        if let Ok(mut r) = self.rejected.lock() {
            *r = Some(err);
        }
        Ok(false)
    }

    async fn disconnected(&mut self, reason: DisconnectReason<Self::Error>) -> Result<(), Self::Error> {
        let why = match &reason {
            DisconnectReason::ReceivedDisconnect(i) if !i.message.is_empty() => i.message.clone(),
            DisconnectReason::ReceivedDisconnect(_) => "closed by the server".into(),
            DisconnectReason::Error(e) => e.to_string(),
        };
        if let Ok(mut r) = self.reason.lock() {
            *r = Some(why);
        }
        match reason {
            DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            DisconnectReason::Error(e) => Err(e),
        }
    }
}

#[derive(Debug, PartialEq)]
enum HostKeyCheck {
    Accept,
    Unknown(HostKeyInfo),
    Mismatch(HostKeyInfo),
}

/// Decides whether `key` is trusted for `host:port`. A conflicting key in either source wins over
/// a match in the other, so a changed key is never accepted silently.
fn check_host_key(host: &str, port: u16, key: &PublicKey, known_hosts: Option<&Path>, trusted: Option<&str>) -> HostKeyCheck {
    let (mut matched, mut changed) = (false, false);
    if let Some(path) = known_hosts {
        // Only a same-algorithm entry with a different key counts as changed (like russh/OpenSSH);
        // a missing or unparsable file is ignored.
        match russh::keys::check_known_hosts_path(host, port, key, path) {
            Ok(m) => matched = m,
            Err(russh::keys::Error::KeyChanged { .. }) => changed = true,
            Err(e) => log::warn!("Ignoring known_hosts {}: {e}", path.display()),
        }
    }
    if let Some(line) = trusted {
        match PublicKey::from_openssh(line) {
            Ok(t) if t.key_data() == key.key_data() => matched = true,
            _ => changed = true,
        }
    }
    let info = || HostKeyInfo {
        host: host.into(),
        port,
        algorithm: key.algorithm().as_str().into(),
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        key: PublicKey::new(key.key_data().clone(), "").to_openssh().unwrap_or_default(),
    };
    if changed {
        HostKeyCheck::Mismatch(info())
    } else if matched {
        HostKeyCheck::Accept
    } else {
        HostKeyCheck::Unknown(info())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti";
    const KEY_B: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID3wbjk2pB+5q5PJ62gW74102Y83NY/O0g+QrBMSGZJt";

    fn key(line: &str) -> PublicKey {
        PublicKey::from_openssh(line).unwrap()
    }

    fn check(known: Option<&str>, trusted: Option<&str>, port: u16) -> HostKeyCheck {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        if let Some(content) = known {
            std::fs::write(&path, content).unwrap();
        }
        check_host_key("bastion.example", port, &key(KEY_A), Some(&path), trusted)
    }

    #[test]
    fn host_key_decisions() {
        assert_eq!(check(Some(&format!("other {KEY_B}\nbastion.example {KEY_A}\n")), None, 22), HostKeyCheck::Accept);
        assert_eq!(check(None, Some(KEY_A), 22), HostKeyCheck::Accept);
        assert_eq!(check(None, Some(&format!("{KEY_A} comment")), 22), HostKeyCheck::Accept);
        assert!(matches!(check(None, Some(KEY_B), 22), HostKeyCheck::Mismatch(_)));
        assert!(matches!(check(Some(&format!("bastion.example {KEY_B}\n")), None, 22), HostKeyCheck::Mismatch(_)));
        // A known_hosts match never overrides a different trusted key.
        assert!(matches!(check(Some(&format!("bastion.example {KEY_A}\n")), Some(KEY_B), 22), HostKeyCheck::Mismatch(_)));
        // Missing file (known = None writes nothing) and no trusted key → unknown, with display info.
        let HostKeyCheck::Unknown(info) = check(None, None, 22) else { panic!("expected unknown") };
        assert_eq!((info.host.as_str(), info.port, info.algorithm.as_str()), ("bastion.example", 22, "ssh-ed25519"));
        assert!(info.fingerprint.starts_with("SHA256:"), "{}", info.fingerprint);
        assert_eq!(info.key, KEY_A);
        assert_eq!(check_host_key("h", 22, &key(KEY_A), None, None), HostKeyCheck::Unknown(HostKeyInfo { host: "h".into(), ..info }));
        // Entries for other hosts don't count.
        assert!(matches!(check(Some(&format!("other.example {KEY_A}\n")), None, 22), HostKeyCheck::Unknown(_)));
    }

    #[test]
    fn host_key_non_standard_port_and_hashed_entries() {
        let entry = format!("[bastion.example]:2222 {KEY_A}\n");
        assert_eq!(check(Some(&entry), None, 2222), HostKeyCheck::Accept);
        assert!(matches!(check(Some(&entry), None, 22), HostKeyCheck::Unknown(_)));
        assert!(matches!(check(Some(&format!("bastion.example {KEY_A}\n")), None, 2222), HostKeyCheck::Unknown(_)));
        // `ssh-keygen -H` style: |1|base64(salt)|base64(HMAC-SHA1(salt, host)), salt = 20 zero bytes.
        let plain = "|1|AAAAAAAAAAAAAAAAAAAAAAAAAAA=|zCLX2VY/6JA9Q0fjcUMYQYV4vFw=";
        let with_port = "|1|AAAAAAAAAAAAAAAAAAAAAAAAAAA=|GwStkefNPebxY8KTeeEr6jlC4M8=";
        assert_eq!(check(Some(&format!("{plain} {KEY_A}\n")), None, 22), HostKeyCheck::Accept);
        assert_eq!(check(Some(&format!("{with_port} {KEY_A}\n")), None, 2222), HostKeyCheck::Accept);
        assert!(matches!(check(Some(&format!("{plain} {KEY_B}\n")), None, 22), HostKeyCheck::Mismatch(_)));
    }

    #[test]
    fn expands_tilde() {
        let home = std::env::home_dir().unwrap();
        assert_eq!(expand_tilde("~/.ssh/id_ed25519"), home.join(".ssh/id_ed25519"));
        assert_eq!(expand_tilde("/etc/key"), PathBuf::from("/etc/key"));
        assert_eq!(expand_tilde("rel/~/key"), PathBuf::from("rel/~/key"));
        assert_eq!(expand_tilde("~user/key"), PathBuf::from("~user/key"));
    }
}
