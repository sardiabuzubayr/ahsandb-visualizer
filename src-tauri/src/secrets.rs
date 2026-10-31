//! Secrets (database/SSH passwords, AI keys). Account = `<connId>:<kind>`.
//!
//! Stored in an encrypted file in the app data folder (`FileSecrets`), like DBeaver's
//! credentials file, so reading them never triggers OS keychain prompts (an unsigned app gets a
//! new identity on every build).
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};

use crate::error::{AppError, AppResult};
use crate::model::Secrets;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    Password,
    SshPassword,
    SshPassphrase,
    /// AI provider API key; stored under the account `ai-<provider>:ai-key`.
    AiKey,
}

impl SecretKind {
    const ALL: [SecretKind; 4] = [SecretKind::Password, SecretKind::SshPassword, SecretKind::SshPassphrase, SecretKind::AiKey];

    fn as_str(self) -> &'static str {
        match self {
            SecretKind::Password => "password",
            SecretKind::SshPassword => "ssh-password",
            SecretKind::SshPassphrase => "ssh-passphrase",
            SecretKind::AiKey => "ai-key",
        }
    }
}

pub trait SecretStore: Send + Sync {
    fn get(&self, conn_id: &str, kind: SecretKind) -> AppResult<Option<String>>;
    fn set(&self, conn_id: &str, kind: SecretKind, value: &str) -> AppResult<()>;
    /// Deleting a missing secret is not an error.
    fn delete(&self, conn_id: &str, kind: SecretKind) -> AppResult<()>;
}

/// In-memory store for tests.
#[derive(Default)]
pub struct MemorySecrets {
    map: Mutex<HashMap<(String, String), String>>,
}

/// Secret-store "connection id" for an AI provider's key.
pub fn ai_account(provider: crate::model::AiProvider) -> String {
    format!("ai-{}", provider.as_str())
}

/// Applies `Secrets` semantics: `None` keeps, `Some("")` deletes, `Some(v)` sets.
pub fn apply(store: &dyn SecretStore, conn_id: &str, secrets: &Secrets) -> AppResult<()> {
    let fields = [
        (SecretKind::Password, &secrets.password),
        (SecretKind::SshPassword, &secrets.ssh_password),
        (SecretKind::SshPassphrase, &secrets.ssh_passphrase),
    ];
    for (kind, value) in fields {
        match value.as_deref() {
            None => {}
            Some("") => store.delete(conn_id, kind)?,
            Some(v) => store.set(conn_id, kind, v)?,
        }
    }
    Ok(())
}

pub fn delete_all(store: &dyn SecretStore, conn_id: &str) -> AppResult<()> {
    SecretKind::ALL.into_iter().try_for_each(|kind| store.delete(conn_id, kind))
}

/// AES-256-GCM encrypted JSON map in `<dir>/secrets.bin`, keyed by a random 32-byte key in
/// `<dir>/secrets.key`; both files are owner-only (0600). This keeps secrets out of plain files,
/// backups and screen shares; like any key kept on disk it does not stop malware running as you.
pub struct FileSecrets {
    dir: PathBuf,
    key: LessSafeKey,
    map: Mutex<HashMap<String, String>>,
}

const KEY_FILE: &str = "secrets.key";
const DATA_FILE: &str = "secrets.bin";

impl FileSecrets {
    pub fn open(dir: &Path) -> AppResult<Self> {
        let io = |e: std::io::Error| AppError::Io(format!("secrets: {e}"));
        let key_path = dir.join(KEY_FILE);
        let raw = match std::fs::read(&key_path) {
            Ok(k) if k.len() == 32 => k,
            Ok(_) => return Err(AppError::Io(format!("{} is damaged", key_path.display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut k = vec![0u8; 32];
                SystemRandom::new().fill(&mut k).map_err(|_| AppError::Internal("no system randomness".into()))?;
                write_private(&key_path, &k).map_err(io)?;
                k
            }
            Err(e) => return Err(io(e)),
        };
        let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &raw).map_err(|_| AppError::Internal("bad secrets key".into()))?);
        let data_path = dir.join(DATA_FILE);
        let map = match std::fs::read(&data_path) {
            Ok(bytes) => match decrypt(&key, bytes) {
                Some(map) => map,
                None => {
                    // Unreadable (e.g. the key file was replaced): keep the file aside, start empty.
                    let _ = std::fs::rename(&data_path, dir.join("secrets.bin.unreadable"));
                    HashMap::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(e) => return Err(io(e)),
        };
        Ok(Self { dir: dir.to_path_buf(), key, map: Mutex::new(map) })
    }

    fn save(&self, map: &HashMap<String, String>) -> AppResult<()> {
        let mut data = serde_json::to_vec(map).map_err(|e| AppError::Internal(e.to_string()))?;
        let mut nonce = [0u8; NONCE_LEN];
        SystemRandom::new().fill(&mut nonce).map_err(|_| AppError::Internal("no system randomness".into()))?;
        self.key
            .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut data)
            .map_err(|_| AppError::Internal("encrypting secrets failed".into()))?;
        let mut out = nonce.to_vec();
        out.extend(data);
        // Write a temp file and rename it, so a crash never leaves a half-written secrets file.
        let tmp = self.dir.join("secrets.bin.tmp");
        write_private(&tmp, &out).and_then(|_| std::fs::rename(&tmp, self.dir.join(DATA_FILE))).map_err(|e| AppError::Secrets(format!("secrets: {e}")))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn decrypt(key: &LessSafeKey, mut bytes: Vec<u8>) -> Option<HashMap<String, String>> {
    if bytes.len() < NONCE_LEN {
        return None;
    }
    let mut data = bytes.split_off(NONCE_LEN);
    let nonce = Nonce::try_assume_unique_for_key(&bytes).ok()?;
    let plain = key.open_in_place(nonce, Aad::empty(), &mut data).ok()?;
    serde_json::from_slice(plain).ok()
}

/// Creates/overwrites `path` readable and writable by the owner only.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

impl SecretStore for FileSecrets {
    fn get(&self, conn_id: &str, kind: SecretKind) -> AppResult<Option<String>> {
        Ok(self.lock().get(&format!("{conn_id}:{}", kind.as_str())).cloned())
    }
    fn set(&self, conn_id: &str, kind: SecretKind, value: &str) -> AppResult<()> {
        let mut map = self.lock();
        map.insert(format!("{conn_id}:{}", kind.as_str()), value.to_string());
        self.save(&map)
    }
    fn delete(&self, conn_id: &str, kind: SecretKind) -> AppResult<()> {
        let mut map = self.lock();
        if map.remove(&format!("{conn_id}:{}", kind.as_str())).is_some() {
            self.save(&map)?;
        }
        Ok(())
    }
}

impl MemorySecrets {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(String, String), String>> {
        // A poisoned lock only means another test panicked; the map itself is still usable.
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl SecretStore for MemorySecrets {
    fn get(&self, conn_id: &str, kind: SecretKind) -> AppResult<Option<String>> {
        Ok(self.lock().get(&(conn_id.to_string(), kind.as_str().to_string())).cloned())
    }
    fn set(&self, conn_id: &str, kind: SecretKind, value: &str) -> AppResult<()> {
        self.lock().insert((conn_id.to_string(), kind.as_str().to_string()), value.to_string());
        Ok(())
    }
    fn delete(&self, conn_id: &str, kind: SecretKind) -> AppResult<()> {
        self.lock().remove(&(conn_id.to_string(), kind.as_str().to_string()));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_secrets_encrypt_and_persist() {
        let dir = tempfile::tempdir().unwrap();
        let f = FileSecrets::open(dir.path()).unwrap();
        f.set("c1", SecretKind::Password, "s3cret-pw").unwrap();
        f.set("ai-anthropic", SecretKind::AiKey, "sk-ant-xyz").unwrap();
        f.delete("ai-anthropic", SecretKind::AiKey).unwrap();
        f.delete("missing", SecretKind::Password).unwrap();
        drop(f);

        let raw = std::fs::read(dir.path().join(DATA_FILE)).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("s3cret-pw"), "stored encrypted");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for f in [KEY_FILE, DATA_FILE] {
                assert_eq!(std::fs::metadata(dir.path().join(f)).unwrap().permissions().mode() & 0o777, 0o600, "{f}");
            }
        }
        let f = FileSecrets::open(dir.path()).unwrap();
        assert_eq!(f.get("c1", SecretKind::Password).unwrap().as_deref(), Some("s3cret-pw"));
        assert_eq!(f.get("ai-anthropic", SecretKind::AiKey).unwrap(), None);

        // A replaced key can't read the old file: it is set aside and the store starts empty.
        std::fs::write(dir.path().join(KEY_FILE), [7u8; 32]).unwrap();
        let f = FileSecrets::open(dir.path()).unwrap();
        assert_eq!(f.get("c1", SecretKind::Password).unwrap(), None);
        assert!(dir.path().join("secrets.bin.unreadable").exists());
    }

    fn s(p: Option<&str>, sp: Option<&str>, spp: Option<&str>) -> Secrets {
        Secrets {
            password: p.map(Into::into),
            ssh_password: sp.map(Into::into),
            ssh_passphrase: spp.map(Into::into),
        }
    }

    #[test]
    fn apply_none_keeps_empty_deletes_value_sets() {
        let m = MemorySecrets::default();
        apply(&m, "c1", &s(Some("pw"), Some("sshpw"), Some("phrase"))).unwrap();
        assert_eq!(m.get("c1", SecretKind::Password).unwrap().as_deref(), Some("pw"));
        assert_eq!(m.get("c1", SecretKind::SshPassword).unwrap().as_deref(), Some("sshpw"));
        assert_eq!(m.get("c1", SecretKind::SshPassphrase).unwrap().as_deref(), Some("phrase"));

        apply(&m, "c1", &s(None, Some(""), Some("new"))).unwrap();
        assert_eq!(m.get("c1", SecretKind::Password).unwrap().as_deref(), Some("pw"));
        assert_eq!(m.get("c1", SecretKind::SshPassword).unwrap(), None);
        assert_eq!(m.get("c1", SecretKind::SshPassphrase).unwrap().as_deref(), Some("new"));
        // Other connections are untouched.
        assert_eq!(m.get("c2", SecretKind::Password).unwrap(), None);
    }

    #[test]
    fn deleting_missing_is_ok_and_delete_all_clears() {
        let m = MemorySecrets::default();
        m.delete("nope", SecretKind::Password).unwrap();
        apply(&m, "nope", &s(Some(""), Some(""), Some(""))).unwrap();
        apply(&m, "c1", &s(Some("a"), Some("b"), Some("c"))).unwrap();
        apply(&m, "c2", &s(Some("x"), None, None)).unwrap();
        delete_all(&m, "c1").unwrap();
        for k in SecretKind::ALL {
            assert_eq!(m.get("c1", k).unwrap(), None);
        }
        assert_eq!(m.get("c2", SecretKind::Password).unwrap().as_deref(), Some("x"));
    }
}
