//! Throwaway user-level OpenSSH server for tunnel tests (no root, no change to ~/.ssh).
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use ahsandb_lib::model::{SshAuth, SshConfig};

pub struct Sshd {
    pub dir: tempfile::TempDir,
    pub port: u16,
    child: Option<Child>,
}

pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

pub fn run(cmd: &mut Command) -> String {
    let out = cmd.output().expect("spawn");
    assert!(out.status.success(), "{cmd:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

pub fn wait_for_port(port: u16) {
    let start = Instant::now();
    while TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(start.elapsed() < Duration::from_secs(10), "port {port} never opened");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Starts sshd when `AHSANDB_TEST_SSHD=1`, else prints a skip note and returns `None`.
/// Keys in the temp dir: `host_key`, `client` (authorized), `client_enc` (authorized, passphrase
/// `secret`), `client_rsa` (authorized), `stranger` (not authorized).
pub fn start() -> Option<Sshd> {
    if std::env::var("AHSANDB_TEST_SSHD").as_deref() != Ok("1") {
        eprintln!("skipped: AHSANDB_TEST_SSHD not set");
        return None;
    }
    let dir = tempfile::tempdir().unwrap();
    let p = |n: &str| dir.path().join(n);
    for (name, args) in [
        ("host_key", &["-t", "ed25519", "-N", ""][..]),
        ("client", &["-t", "ed25519", "-N", ""]),
        ("client_enc", &["-t", "ed25519", "-N", "secret"]),
        ("client_rsa", &["-t", "rsa", "-b", "2048", "-N", ""]),
        ("stranger", &["-t", "ed25519", "-N", ""]),
    ] {
        run(Command::new("ssh-keygen").arg("-q").args(args).arg("-f").arg(p(name)));
    }
    let authorized: String = ["client", "client_enc", "client_rsa"]
        .iter()
        .map(|n| std::fs::read_to_string(p(&format!("{n}.pub"))).unwrap())
        .collect();
    std::fs::write(p("authorized_keys"), authorized).unwrap();
    let port = free_port();
    let d = dir.path().display();
    std::fs::write(
        p("sshd_config"),
        format!(
            "Port {port}\nListenAddress 127.0.0.1\nHostKey {d}/host_key\nAuthorizedKeysFile {d}/authorized_keys\n\
             PasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\n\
             PidFile {d}/sshd.pid\nAllowTcpForwarding yes\n"
        ),
    )
    .unwrap();
    let child = Command::new("/usr/sbin/sshd")
        .args(["-D", "-e", "-f"])
        .arg(p("sshd_config"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn sshd");
    wait_for_port(port);
    Some(Sshd { dir, port, child: Some(child) })
}

impl Sshd {
    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// `ssh-ed25519 AAAA…` of the server (comment dropped).
    pub fn host_key_line(&self) -> String {
        let pubkey = std::fs::read_to_string(self.path("host_key.pub")).unwrap();
        pubkey.split_whitespace().take(2).collect::<Vec<_>>().join(" ")
    }

    pub fn fingerprint(&self) -> String {
        let out = run(Command::new("ssh-keygen").arg("-lf").arg(self.path("host_key.pub")).args(["-E", "sha256"]));
        out.split_whitespace().nth(1).unwrap().to_string()
    }

    pub fn cfg(&self, auth: SshAuth, key: Option<&str>) -> SshConfig {
        SshConfig {
            host: "127.0.0.1".into(),
            port: self.port,
            user: std::env::var("USER").unwrap(),
            auth,
            key_path: key.map(|k| self.path(k).display().to_string()),
            keepalive_secs: None,
        }
    }

    /// Starts sshd again on the same port with the same keys (after `kill`).
    pub fn restart(&mut self) {
        let child = Command::new("/usr/sbin/sshd")
            .args(["-D", "-e", "-f"])
            .arg(self.path("sshd_config"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sshd");
        self.child = Some(child);
        wait_for_port(self.port);
    }

    /// Kills sshd and its per-connection children (they run in their own sessions, so a plain kill
    /// of the listener would leave open connections alive).
    pub fn kill(&mut self) {
        let Some(mut child) = self.child.take() else { return };
        let mut pids = vec![child.id().to_string()];
        let mut i = 0;
        while i < pids.len() {
            let out = Command::new("pgrep").args(["-P", &pids[i]]).output().unwrap();
            pids.extend(String::from_utf8_lossy(&out.stdout).split_whitespace().map(String::from));
            i += 1;
        }
        let _ = Command::new("kill").arg("-9").args(&pids).status();
        let _ = child.wait();
    }
}

impl Drop for Sshd {
    fn drop(&mut self) {
        self.kill();
    }
}
