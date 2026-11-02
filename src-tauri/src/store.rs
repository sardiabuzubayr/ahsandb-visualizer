//! App-local storage (SQLite file in the app data dir): saved connections, query history, agent
//! chats, the agent audit log and the data dictionary.
use std::path::Path;

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Row, SqlitePool};

use crate::ai::ChatItem;
use crate::error::{AppError, AppResult};
use crate::model::{AgentMessage, AuditEntry, Connection, DictMark, DictNote, DictTerm, HistoryEntry, HostKeyInfo, NoteStatus};

const HISTORY_CAP: i64 = 500;
/// Chat entries kept per connection (what the panel reloads).
const CHAT_MESSAGES: usize = 200;
/// Provider history kept per connection (what the model sees), cut at a user message.
const CHAT_ITEMS: usize = 100;

pub struct Store {
    pool: SqlitePool,
}

impl Store {
    /// Opens (creating if needed) the store and its tables.
    pub async fn open(path: &Path) -> AppResult<Self> {
        let opts = SqliteConnectOptions::new().filename(path).create_if_missing(true);
        let pool = SqlitePool::connect_with(opts).await?;
        for ddl in [
            "CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, json TEXT NOT NULL, position INTEGER NOT NULL)",
            "CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, conn_id TEXT NOT NULL, \
             sql TEXT NOT NULL, ran_at TEXT NOT NULL, ok INTEGER NOT NULL)",
            "CREATE INDEX IF NOT EXISTS history_conn_id ON history(conn_id)",
            "CREATE TABLE IF NOT EXISTS known_hosts (host TEXT NOT NULL, port INTEGER NOT NULL, key TEXT NOT NULL, \
             PRIMARY KEY(host, port))",
            // Which AI providers have a saved key: lets the UI show "saved" without reading the secret store.
            // Empty = not filled yet.
            "CREATE TABLE IF NOT EXISTS ai_keys (provider TEXT PRIMARY KEY, saved INTEGER NOT NULL)",
            "CREATE TABLE IF NOT EXISTS agent_chats (conn_id TEXT PRIMARY KEY, items TEXT NOT NULL, messages TEXT NOT NULL, \
             updated_at TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS agent_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, conn_id TEXT NOT NULL, at TEXT NOT NULL, \
             provider TEXT NOT NULL, model TEXT NOT NULL, level TEXT NOT NULL, sql TEXT NOT NULL, decision TEXT NOT NULL, \
             outcome TEXT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS agent_audit_conn_id ON agent_audit(conn_id)",
            // Data dictionary: kind 'note' (target = table, col = column or '' for the table itself,
            // text = note) or 'term' (target = term, text = meaning, maps_to).
            "CREATE TABLE IF NOT EXISTS dictionary (conn_id TEXT NOT NULL, db TEXT NOT NULL, schema TEXT NOT NULL, \
             kind TEXT NOT NULL, target TEXT NOT NULL, col TEXT NOT NULL, text TEXT NOT NULL, maps_to TEXT NOT NULL, \
             status TEXT NOT NULL, evidence TEXT NOT NULL, unsure INTEGER NOT NULL, updated_at TEXT NOT NULL, \
             PRIMARY KEY (conn_id, db, schema, kind, target, col))",
        ] {
            sqlx::query(ddl).execute(&pool).await?;
        }
        Ok(Self { pool })
    }

    pub async fn list(&self) -> AppResult<Vec<Connection>> {
        let rows = sqlx::query("SELECT json FROM connections ORDER BY position")
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(|r| Ok(serde_json::from_str(r.try_get("json")?)?)).collect()
    }

    pub async fn get(&self, id: &str) -> AppResult<Connection> {
        let row = sqlx::query("SELECT json FROM connections WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| AppError::NotFound("Connection not found".into()))?;
        Ok(serde_json::from_str(row.try_get("json")?)?)
    }

    /// Inserts or updates. Assigns a UUID when `id` is empty. Never persists `connected`/`server_version`.
    pub async fn save(&self, mut c: Connection) -> AppResult<Connection> {
        if c.id.is_empty() {
            c.id = uuid::Uuid::new_v4().to_string();
        }
        c.connected = false;
        c.server_version = None;
        // Upsert keeps the original position on update.
        sqlx::query(
            "INSERT INTO connections (id, json, position) \
             VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM connections)) \
             ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        )
        .bind(&c.id)
        .bind(serde_json::to_string(&c)?)
        .execute(&self.pool)
        .await?;
        Ok(c)
    }

    pub async fn delete(&self, id: &str) -> AppResult<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM connections WHERE id = ?").bind(id).execute(&mut *tx).await?;
        for table in ["history", "agent_chats", "agent_audit", "dictionary"] {
            sqlx::query(&format!("DELETE FROM {table} WHERE conn_id = ?")).bind(id).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Appends a history entry; keeps the newest 500 per connection.
    pub async fn add_history(&self, conn_id: &str, sql: &str, ok: bool) -> AppResult<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO history (conn_id, sql, ran_at, ok) VALUES (?, ?, ?, ?)")
            .bind(conn_id)
            .bind(sql)
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(ok)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "DELETE FROM history WHERE conn_id = ?1 AND id NOT IN \
             (SELECT id FROM history WHERE conn_id = ?1 ORDER BY id DESC LIMIT ?2)",
        )
        .bind(conn_id)
        .bind(HISTORY_CAP)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Newest first.
    pub async fn history(&self, conn_id: &str, limit: u32) -> AppResult<Vec<HistoryEntry>> {
        let rows = sqlx::query("SELECT sql, ran_at, ok FROM history WHERE conn_id = ? ORDER BY id DESC LIMIT ?")
            .bind(conn_id)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?;
        rows.iter()
            .map(|r| Ok(HistoryEntry { sql: r.try_get("sql")?, ran_at: r.try_get("ran_at")?, ok: r.try_get("ok")? }))
            .collect()
    }

    /// Saved-key flags per provider; `None` until they were recorded once.
    pub async fn ai_key_flags(&self) -> AppResult<Option<Vec<(String, bool)>>> {
        let rows: Vec<(String, bool)> = sqlx::query_as("SELECT provider, saved FROM ai_keys").fetch_all(&self.pool).await?;
        Ok((!rows.is_empty()).then_some(rows))
    }

    pub async fn set_ai_key_flag(&self, provider: &str, saved: bool) -> AppResult<()> {
        sqlx::query("INSERT INTO ai_keys (provider, saved) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET saved = excluded.saved")
            .bind(provider)
            .bind(saved)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// OpenSSH key line the user trusted for `host:port`, if any.
    pub async fn trusted_host_key(&self, host: &str, port: u16) -> AppResult<Option<String>> {
        Ok(sqlx::query_scalar("SELECT key FROM known_hosts WHERE host = ? AND port = ?")
            .bind(host)
            .bind(port)
            .fetch_optional(&self.pool)
            .await?)
    }

    /// Stores (or replaces) the trusted key for `host:port`.
    pub async fn trust_host_key(&self, key: &HostKeyInfo) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO known_hosts (host, port, key) VALUES (?, ?, ?) \
             ON CONFLICT(host, port) DO UPDATE SET key = excluded.key",
        )
        .bind(&key.host)
        .bind(key.port)
        .bind(&key.key)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Saved agent chat of a connection: provider history and panel messages (empty when none).
    pub async fn load_chat(&self, conn_id: &str) -> AppResult<(Vec<ChatItem>, Vec<AgentMessage>)> {
        let row = sqlx::query("SELECT items, messages FROM agent_chats WHERE conn_id = ?").bind(conn_id).fetch_optional(&self.pool).await?;
        let Some(row) = row else { return Ok((vec![], vec![])) };
        Ok((serde_json::from_str(row.try_get("items")?)?, serde_json::from_str(row.try_get("messages")?)?))
    }

    /// Replaces the saved chat, keeping the last 200 messages and about the last 100 items, cut at a
    /// user item so every tool call keeps its tool result.
    pub async fn save_chat(&self, conn_id: &str, items: &[ChatItem], messages: &[AgentMessage]) -> AppResult<()> {
        let items = &items[trim_items(items)..];
        let messages = &messages[messages.len().saturating_sub(CHAT_MESSAGES)..];
        sqlx::query(
            "INSERT INTO agent_chats (conn_id, items, messages, updated_at) VALUES (?, ?, ?, ?) \
             ON CONFLICT(conn_id) DO UPDATE SET items = excluded.items, messages = excluded.messages, updated_at = excluded.updated_at",
        )
        .bind(conn_id)
        .bind(serde_json::to_string(items)?)
        .bind(serde_json::to_string(messages)?)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Clears the chat (the audit log stays).
    pub async fn clear_chat(&self, conn_id: &str) -> AppResult<()> {
        sqlx::query("DELETE FROM agent_chats WHERE conn_id = ?").bind(conn_id).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn add_audit(&self, conn_id: &str, e: &AuditEntry) -> AppResult<()> {
        sqlx::query("INSERT INTO agent_audit (conn_id, at, provider, model, level, sql, decision, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(conn_id)
            .bind(&e.at)
            .bind(&e.provider)
            .bind(&e.model)
            .bind(serde_json::to_value(e.level)?.as_str().unwrap_or_default())
            .bind(&e.sql)
            .bind(&e.decision)
            .bind(&e.outcome)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Newest first.
    pub async fn audit(&self, conn_id: &str, limit: u32) -> AppResult<Vec<AuditEntry>> {
        let rows = sqlx::query(
            "SELECT at, provider, model, level, sql, decision, outcome FROM agent_audit WHERE conn_id = ? ORDER BY id DESC LIMIT ?",
        )
        .bind(conn_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|r| {
                Ok(AuditEntry {
                    at: r.try_get("at")?,
                    provider: r.try_get("provider")?,
                    model: r.try_get("model")?,
                    level: serde_json::from_value(serde_json::Value::String(r.try_get("level")?))?,
                    sql: r.try_get("sql")?,
                    decision: r.try_get("decision")?,
                    outcome: r.try_get("outcome")?,
                })
            })
            .collect()
    }

    pub async fn forget_host_key(&self, host: &str, port: u16) -> AppResult<()> {
        sqlx::query("DELETE FROM known_hosts WHERE host = ? AND port = ?").bind(host).bind(port).execute(&self.pool).await?;
        Ok(())
    }
}

/// The schema a dictionary belongs to: bare connection id, database name (`main` for SQLite) and schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DictKey {
    pub conn: String,
    pub db: String,
    pub schema: String,
}

struct DictRow<'a> {
    kind: &'a str,
    target: &'a str,
    col: &'a str,
    text: &'a str,
    maps_to: &'a str,
    status: NoteStatus,
    evidence: &'a str,
    unsure: bool,
}

fn status_str(s: NoteStatus) -> &'static str {
    match s {
        NoteStatus::Verified => "verified",
        NoteStatus::Draft => "draft",
    }
}

impl Store {
    /// Saved notes (by table, then column; the table's own note first) and terms of a schema.
    pub async fn dictionary(&self, k: &DictKey) -> AppResult<(Vec<DictNote>, Vec<DictTerm>)> {
        let rows = sqlx::query(
            "SELECT kind, target, col, text, maps_to, status, evidence, unsure FROM dictionary \
             WHERE conn_id = ? AND db = ? AND schema = ? ORDER BY kind, target, col",
        )
        .bind(&k.conn)
        .bind(&k.db)
        .bind(&k.schema)
        .fetch_all(&self.pool)
        .await?;
        let (mut notes, mut terms) = (vec![], vec![]);
        for r in &rows {
            let status = if r.try_get::<String, _>("status")? == "draft" { NoteStatus::Draft } else { NoteStatus::Verified };
            let (evidence, unsure): (String, bool) = (r.try_get("evidence")?, r.try_get("unsure")?);
            if r.try_get::<String, _>("kind")? == "term" {
                terms.push(DictTerm { term: r.try_get("target")?, meaning: r.try_get("text")?, maps_to: r.try_get("maps_to")?, status, evidence, unsure });
            } else {
                notes.push(DictNote { table: r.try_get("target")?, column: r.try_get("col")?, note: r.try_get("text")?, status, evidence, unsure });
            }
        }
        Ok((notes, terms))
    }

    /// Upsert. `draft_only` (Learn schema) never replaces a verified entry; returns whether it wrote.
    async fn put_dict(&self, k: &DictKey, r: DictRow<'_>, draft_only: bool) -> AppResult<bool> {
        let guard = if draft_only { " WHERE dictionary.status = 'draft'" } else { "" };
        let done = sqlx::query(&format!(
            "INSERT INTO dictionary (conn_id, db, schema, kind, target, col, text, maps_to, status, evidence, unsure, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(conn_id, db, schema, kind, target, col) DO UPDATE SET text = excluded.text, maps_to = excluded.maps_to, \
             status = excluded.status, evidence = excluded.evidence, unsure = excluded.unsure, updated_at = excluded.updated_at{guard}"
        ))
        .bind(&k.conn)
        .bind(&k.db)
        .bind(&k.schema)
        .bind(r.kind)
        .bind(r.target)
        .bind(r.col)
        .bind(r.text)
        .bind(r.maps_to)
        .bind(status_str(r.status))
        .bind(r.evidence)
        .bind(r.unsure)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    pub async fn put_note(&self, k: &DictKey, n: &DictNote, draft_only: bool) -> AppResult<bool> {
        let r = DictRow { kind: "note", target: &n.table, col: &n.column, text: &n.note, maps_to: "", status: n.status, evidence: &n.evidence, unsure: n.unsure };
        self.put_dict(k, r, draft_only).await
    }

    /// `previous` = the term's old name when it was renamed.
    pub async fn put_term(&self, k: &DictKey, t: &DictTerm, previous: Option<&str>, draft_only: bool) -> AppResult<bool> {
        if let Some(old) = previous.filter(|p| *p != t.term) {
            self.delete_dict(k, "term", old, "").await?;
        }
        let r = DictRow { kind: "term", target: &t.term, col: "", text: &t.meaning, maps_to: &t.maps_to, status: t.status, evidence: &t.evidence, unsure: t.unsure };
        self.put_dict(k, r, draft_only).await
    }

    pub async fn delete_note(&self, k: &DictKey, table: &str, column: &str) -> AppResult<()> {
        self.delete_dict(k, "note", table, column).await
    }

    pub async fn delete_term(&self, k: &DictKey, term: &str) -> AppResult<()> {
        self.delete_dict(k, "term", term, "").await
    }

    async fn delete_dict(&self, k: &DictKey, kind: &str, target: &str, col: &str) -> AppResult<()> {
        sqlx::query("DELETE FROM dictionary WHERE conn_id = ? AND db = ? AND schema = ? AND kind = ? AND target = ? AND col = ?")
            .bind(&k.conn)
            .bind(&k.db)
            .bind(&k.schema)
            .bind(kind)
            .bind(target)
            .bind(col)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Approves (`approve`) or deletes the schema's drafts; `include_unsure` = also the unsure ones.
    pub async fn resolve_drafts(&self, k: &DictKey, approve: bool, include_unsure: bool) -> AppResult<u64> {
        let which = if include_unsure { "" } else { " AND unsure = 0" };
        let filter = format!("WHERE conn_id = ? AND db = ? AND schema = ? AND status = 'draft'{which}");
        let sql = if approve { format!("UPDATE dictionary SET status = 'verified' {filter}") } else { format!("DELETE FROM dictionary {filter}") };
        let done = sqlx::query(&sql)
            .bind(&k.conn)
            .bind(&k.db)
            .bind(&k.schema)
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected())
    }

    /// Tables of a connection that have notes, for the navigator.
    pub async fn dict_marks(&self, conn_id: &str) -> AppResult<Vec<DictMark>> {
        let rows: Vec<(String, String, String, bool)> = sqlx::query_as(
            "SELECT db, schema, target, MAX(status = 'draft') FROM dictionary WHERE conn_id = ? AND kind = 'note' \
             GROUP BY db, schema, target ORDER BY db, schema, target",
        )
        .bind(conn_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(database, schema, table, draft)| DictMark { database, schema, table, draft }).collect())
    }
}

/// Index of the first item to keep: the first user item among the last `CHAT_ITEMS`, else the last
/// user item before them (a user item never splits a tool call from its result).
fn trim_items(items: &[ChatItem]) -> usize {
    let start = items.len().saturating_sub(CHAT_ITEMS);
    let user = |i: &usize| matches!(items[*i], ChatItem::User { .. });
    (start..items.len()).find(user).or_else(|| (0..start).rev().find(user)).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AiAccess, Driver, Env, SslMode};

    fn conn(name: &str) -> Connection {
        Connection {
            id: String::new(),
            name: name.into(),
            folder: "Local".into(),
            driver: Driver::Postgres,
            env: Env::Dev,
            host: Some("localhost".into()),
            port: Some(5432),
            database: Some("db".into()),
            user: Some("me".into()),
            file: None,
            read_only: false,
            connected: true,
            ssh: None,
            ssl_mode: SslMode::Prefer,
            ai_access: AiAccess::Off,
            server_version: Some("PostgreSQL 14".into()),
            timeout_secs: None,
            ssl_ca_path: None,
            ssl_cert_path: None,
            ssl_key_path: None,
        }
    }

    #[tokio::test]
    async fn crud_uuid_order_and_runtime_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.db");
        let store = Store::open(&path).await.unwrap();

        let a = store.save(conn("a")).await.unwrap();
        assert!(uuid::Uuid::parse_str(&a.id).is_ok());
        assert!(!a.connected && a.server_version.is_none());
        let b = store.save(conn("b")).await.unwrap();
        assert_ne!(a.id, b.id);

        // Update keeps position and id.
        let mut a2 = store.get(&a.id).await.unwrap();
        assert!(!a2.connected && a2.server_version.is_none());
        a2.name = "a renamed".into();
        a2.connected = true;
        a2.server_version = Some("x".into());
        store.save(a2).await.unwrap();
        let list = store.list().await.unwrap();
        assert_eq!(list.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["a renamed", "b"]);
        assert!(list.iter().all(|c| !c.connected && c.server_version.is_none()));

        // Reopening (migration is idempotent) keeps data.
        drop(store);
        let store = Store::open(&path).await.unwrap();
        assert_eq!(store.list().await.unwrap().len(), 2);

        store.delete(&a.id).await.unwrap();
        assert!(matches!(store.get(&a.id).await, Err(AppError::NotFound(_))));
        assert_eq!(store.list().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn history_newest_first_capped_and_deleted_with_connection() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("app.db")).await.unwrap();
        let c = store.save(conn("c")).await.unwrap();
        let other = store.save(conn("o")).await.unwrap();
        store.add_history(&other.id, "SELECT 0", true).await.unwrap();
        for i in 0..505 {
            store.add_history(&c.id, &format!("SELECT {i}"), i % 2 == 0).await.unwrap();
        }
        let h = store.history(&c.id, 1000).await.unwrap();
        assert_eq!(h.len(), 500);
        assert_eq!(h[0].sql, "SELECT 504");
        assert!(h[0].ok && !h[1].ok);
        assert_eq!(h[499].sql, "SELECT 5");
        assert!(chrono::DateTime::parse_from_rfc3339(&h[0].ran_at).is_ok());
        assert_eq!(store.history(&c.id, 20).await.unwrap().len(), 20);

        store.delete(&c.id).await.unwrap();
        assert!(store.history(&c.id, 10).await.unwrap().is_empty());
        assert_eq!(store.history(&other.id, 10).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn ai_key_flags_start_unset_then_upsert() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("app.db")).await.unwrap();
        assert_eq!(store.ai_key_flags().await.unwrap(), None);
        store.set_ai_key_flag("anthropic", true).await.unwrap();
        store.set_ai_key_flag("openai", false).await.unwrap();
        store.set_ai_key_flag("anthropic", false).await.unwrap();
        let mut flags = store.ai_key_flags().await.unwrap().unwrap();
        flags.sort();
        assert_eq!(flags, vec![("anthropic".into(), false), ("openai".into(), false)]);
    }

    #[tokio::test]
    async fn host_keys_trust_replace_forget() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("app.db")).await.unwrap();
        let info = |key: &str| HostKeyInfo {
            host: "bastion".into(),
            port: 22,
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:x".into(),
            key: key.into(),
        };
        assert_eq!(store.trusted_host_key("bastion", 22).await.unwrap(), None);
        store.trust_host_key(&info("ssh-ed25519 AAAA1")).await.unwrap();
        assert_eq!(store.trusted_host_key("bastion", 22).await.unwrap().as_deref(), Some("ssh-ed25519 AAAA1"));
        assert_eq!(store.trusted_host_key("bastion", 2222).await.unwrap(), None);
        store.trust_host_key(&info("ssh-ed25519 AAAA2")).await.unwrap();
        assert_eq!(store.trusted_host_key("bastion", 22).await.unwrap().as_deref(), Some("ssh-ed25519 AAAA2"));
        store.forget_host_key("bastion", 22).await.unwrap();
        assert_eq!(store.trusted_host_key("bastion", 22).await.unwrap(), None);
    }

    #[tokio::test]
    async fn agent_chat_trim_clear_and_audit() {
        use crate::ai::{ToolCall, ToolResult};
        use crate::model::RiskLevel;
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("app.db")).await.unwrap();
        let c = store.save(conn("c")).await.unwrap();
        assert!(store.load_chat(&c.id).await.unwrap().0.is_empty());

        // 40 turns of user, assistant(tool call), tool results, assistant = 160 items.
        let mut items = vec![];
        for i in 0..40 {
            let call = ToolCall { id: format!("call{i}"), name: "get_schema".into(), input: serde_json::json!({}) };
            items.push(ChatItem::User { text: format!("q{i}"), id: None });
            items.push(ChatItem::Assistant { text: String::new(), tool_calls: vec![call], raw: None });
            items.push(ChatItem::ToolResults { results: vec![ToolResult { call_id: format!("call{i}"), content: "x".into(), is_error: false }] });
            items.push(ChatItem::Assistant { text: format!("a{i}"), tool_calls: vec![], raw: None });
        }
        let messages: Vec<AgentMessage> = (0..250).map(|i| AgentMessage::User { id: format!("m{i}"), text: "t".into() }).collect();
        store.save_chat(&c.id, &items, &messages).await.unwrap();
        let (got, msgs) = store.load_chat(&c.id).await.unwrap();
        assert_eq!(got.len(), 100);
        assert_eq!(got[0], ChatItem::User { text: "q15".into(), id: None });
        assert_eq!(msgs.len(), 200);
        assert!(matches!(&msgs[0], AgentMessage::User { id, .. } if id == "m50"));
        // Cut point not on a user item → moves forward to the next one.
        store.save_chat(&c.id, &items[..158], &[]).await.unwrap();
        assert_eq!(store.load_chat(&c.id).await.unwrap().0[0], ChatItem::User { text: "q15".into(), id: None });
        assert_eq!(trim_items(&items[..3]), 0);

        let entry = |decision: &str| AuditEntry {
            at: chrono::Utc::now().to_rfc3339(),
            provider: "anthropic".into(),
            model: "m".into(),
            level: RiskLevel::Critical,
            sql: "DELETE FROM t".into(),
            decision: decision.into(),
            outcome: "ok".into(),
        };
        store.add_audit(&c.id, &entry("approved")).await.unwrap();
        store.add_audit(&c.id, &entry("rejected")).await.unwrap();
        let log = store.audit(&c.id, 10).await.unwrap();
        assert_eq!(log.iter().map(|e| e.decision.as_str()).collect::<Vec<_>>(), ["rejected", "approved"]);
        assert_eq!(log[0].level, RiskLevel::Critical);
        assert_eq!(store.audit(&c.id, 1).await.unwrap().len(), 1);

        store.clear_chat(&c.id).await.unwrap();
        assert!(store.load_chat(&c.id).await.unwrap().1.is_empty());
        assert_eq!(store.audit(&c.id, 10).await.unwrap().len(), 2);

        store.save_chat(&c.id, &items, &messages).await.unwrap();
        store.delete(&c.id).await.unwrap();
        assert!(store.load_chat(&c.id).await.unwrap().0.is_empty());
        assert!(store.audit(&c.id, 10).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn dictionary_drafts_never_replace_verified_notes() {
        use crate::model::{DictNote, DictTerm, NoteStatus};
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("app.db")).await.unwrap();
        let c = store.save(conn("a")).await.unwrap();
        let key = DictKey { conn: c.id.clone(), db: "shop".into(), schema: "public".into() };
        let other = DictKey { schema: "audit".into(), ..key.clone() };
        let note = |col: &str, text: &str, status, unsure| DictNote {
            table: "bills".into(),
            column: col.into(),
            note: text.into(),
            status,
            evidence: "e".into(),
            unsure,
        };
        assert!(store.put_note(&key, &note("", "One bill per month", NoteStatus::Verified, false), false).await.unwrap());
        // Learn schema can't overwrite a verified note, but can replace its own draft.
        assert!(!store.put_note(&key, &note("", "guess", NoteStatus::Draft, false), true).await.unwrap());
        assert!(store.put_note(&key, &note("status", "1 = active", NoteStatus::Draft, true), true).await.unwrap());
        assert!(store.put_note(&key, &note("status", "1 = active, 2 = waived", NoteStatus::Draft, true), true).await.unwrap());
        assert!(store.put_note(&key, &note("amount", "Before discount", NoteStatus::Draft, false), true).await.unwrap());
        let term = DictTerm { term: "Paid".into(), meaning: "No balance left".into(), maps_to: "bills.outstanding = 0".into(), status: NoteStatus::Verified, evidence: String::new(), unsure: false };
        store.put_term(&key, &term, None, false).await.unwrap();
        store.put_term(&key, &DictTerm { term: "Settled".into(), ..term.clone() }, Some("Paid"), false).await.unwrap();
        store.put_note(&other, &note("", "elsewhere", NoteStatus::Verified, false), false).await.unwrap();

        let (notes, terms) = store.dictionary(&key).await.unwrap();
        let texts: Vec<(&str, &str, NoteStatus)> = notes.iter().map(|n| (n.column.as_str(), n.note.as_str(), n.status)).collect();
        assert_eq!(
            texts,
            [("", "One bill per month", NoteStatus::Verified), ("amount", "Before discount", NoteStatus::Draft), ("status", "1 = active, 2 = waived", NoteStatus::Draft)]
        );
        assert_eq!(terms.iter().map(|t| t.term.as_str()).collect::<Vec<_>>(), ["Settled"]);

        let marks = store.dict_marks(&c.id).await.unwrap();
        assert_eq!(marks.len(), 2);
        assert!(marks.iter().any(|m| m.schema == "public" && m.table == "bills" && m.draft));
        assert!(marks.iter().any(|m| m.schema == "audit" && !m.draft));

        // Confident drafts first, then the unsure ones are rejected.
        assert_eq!(store.resolve_drafts(&key, true, false).await.unwrap(), 1);
        assert_eq!(store.resolve_drafts(&key, false, true).await.unwrap(), 1);
        let (notes, _) = store.dictionary(&key).await.unwrap();
        assert!(notes.iter().all(|n| n.status == NoteStatus::Verified) && notes.len() == 2);

        store.delete_term(&key, "Settled").await.unwrap();
        store.delete_note(&key, "bills", "amount").await.unwrap();
        assert_eq!(store.dictionary(&key).await.unwrap().0.len(), 1);
        store.delete(&c.id).await.unwrap();
        assert!(store.dict_marks(&c.id).await.unwrap().is_empty());
    }
}
