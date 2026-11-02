//! The agent loop: system prompt + tools (SQL: get_schema, run_sql, save_to_dictionary, open_in_editor;
//! Redis: scan_keys, get_key, run_command), risk levels decided by the app, approval round-trips with
//! the UI, cancel, per-connection history and audit log.
//!
//! The core (`AgentState`, `run_turn`) has no Tauri dependency so tests drive it with a fake
//! `ChatModel`; `send`/`decide`/`stop`/… are the thin Tauri-facing wrappers.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, Manager as _};
use tokio::sync::{oneshot, watch};

use super::kv_tools::{self, GetKey, RunCommand, ScanKeys};
use super::risk::{self, Assessment, Op};
use super::tools::{self, ConnFacts, GetSchema, OpenInEditor, RunSql, SaveToDictionary};
use super::{ChatItem, ChatModel, ChatRequest, StopKind, ToolCall, ToolResult};
use crate::commands::{conn_id as bare_id, kv_conn, pool as scoped_pool};
use crate::db::{self, Manager, Pool};
use crate::dict;
use crate::error::{AppError, AppResult};
use crate::kv::{self, command::CmdClass};
use crate::model::{
    ActionStatus, AgentDecision, AgentEvent, AgentEventKind, AgentMessage, AgentStep, AiAccess, AiProvider, AuditEntry, Connection,
    Column, DecisionKind, DictNote, DictTerm, Driver, Env, NoteItem, NotePick, NoteStatus, RiskLevel, StatementResult,
};
use crate::secrets::{SecretKind, ai_account};
use crate::store::{DictKey, Store};
use crate::AppState;

/// Model calls per user message.
pub const MAX_CALLS: usize = 12;
const MAX_TOKENS: u32 = 16000;
pub const REJECTED: &str = "The user rejected this action. Do not retry it or work around it; ask the user what they want instead.";
pub const STOPPED: &str = "Stopped by the user";
pub const DATA_OFF: &str = "Data access is off for this connection (AI access: schema only)";

pub type Emit = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// Running turns (one per bare connection id) and pending approvals (lives in `AppState`).
#[derive(Default)]
pub struct AgentState {
    turns: Mutex<HashMap<String, Arc<TurnHandle>>>,
    pending: Mutex<HashMap<String, Pending>>,
}

/// A running turn: its cancel flag, the query it is running (for `db::exec::cancel`) and its emitter.
pub struct TurnHandle {
    conn_id: String,
    cancel: watch::Sender<bool>,
    run_id: Mutex<Option<String>>,
    emit: Emit,
}

struct Pending {
    conn_id: String,
    driver: Driver,
    confirm_name: Option<String>,
    /// A data-dictionary card (approve or reject only).
    note: bool,
    tx: oneshot::Sender<AgentDecision>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A poisoned lock only means a panicking turn; the maps stay usable.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl TurnHandle {
    fn emit(&self, kind: AgentEventKind) {
        (self.emit)(AgentEvent { conn_id: self.conn_id.clone(), kind });
    }

    fn stopped(&self) -> bool {
        *self.cancel.borrow()
    }

    /// Resolves once `stop` was called.
    async fn cancelled(&self) {
        let _ = self.cancel.subscribe().wait_for(|c| *c).await;
    }
}

impl AgentState {
    /// Registers a turn for `conn` (its id may be scoped; turns are per bare connection) and emits
    /// `Status{running: true}`. AI access off or a turn already running → error.
    pub fn start(&self, conn: &Connection, emit: Emit) -> AppResult<Arc<TurnHandle>> {
        if conn.ai_access == AiAccess::Off {
            return Err(AppError::Query("AI access is off for this connection. Turn it on in the connection settings to use the agent.".into()));
        }
        let id = bare_id(&conn.id).to_string();
        let handle = {
            let mut turns = lock(&self.turns);
            if turns.contains_key(&id) {
                return Err(AppError::Query("A turn is already running for this connection".into()));
            }
            let h = Arc::new(TurnHandle { conn_id: id.clone(), cancel: watch::channel(false).0, run_id: Mutex::new(None), emit });
            turns.insert(id, h.clone());
            h
        };
        handle.emit(AgentEventKind::Status { running: true });
        Ok(handle)
    }

    pub fn is_running(&self, conn_id: &str) -> bool {
        lock(&self.turns).contains_key(conn_id)
    }

    /// The user's answer to a pending card. Unknown ids → `NotFound`. A production critical approval
    /// with a wrong typed name, or an edit to invalid SQL → `Query` (the card stays pending).
    pub fn decide(&self, action_id: &str, decision: AgentDecision) -> AppResult<()> {
        let mut pending = lock(&self.pending);
        let p = pending.get(action_id).ok_or_else(|| AppError::NotFound("This action is no longer waiting for a decision".into()))?;
        match decision.kind {
            DecisionKind::Approve => {
                if let Some(name) = &p.confirm_name
                    && decision.typed_name.as_deref().map(str::trim) != Some(name.as_str())
                {
                    return Err(AppError::Query(format!("Type {name} exactly to confirm")));
                }
            }
            DecisionKind::Edit if p.note => return Err(AppError::Query("Edit the entries on the card, then save".into())),
            DecisionKind::Edit => {
                let edited = decision.sql.as_deref().unwrap_or_default();
                match p.driver {
                    Driver::Redis => drop(kv_tools::check(edited).map_err(AppError::Query)?),
                    _ => drop(risk::assess(p.driver, edited).map_err(AppError::Query)?),
                }
            }
            DecisionKind::Reject => {}
        }
        let Some(p) = pending.remove(action_id) else { unreachable!("checked above") };
        p.tx.send(decision).map_err(|_| AppError::NotFound("This action is no longer waiting for a decision".into()))
    }

    /// Stops a connection's turn: sets the cancel flag (aborts the provider request), resolves its
    /// pending cards as stopped, cancels its running query and emits `Status{running: false}`.
    pub async fn stop(&self, mgr: &Manager, conn_id: &str) {
        let Some(h) = lock(&self.turns).get(conn_id).cloned() else { return };
        h.cancel.send_replace(true);
        // Dropping the senders wakes the waiting turn, which marks the cards rejected ("Stopped").
        lock(&self.pending).retain(|_, p| p.conn_id != conn_id);
        let run = lock(&h.run_id).clone();
        if let Some(run) = run {
            // SQLite can't cancel (NotSupported); the turn stops after the query.
            let _ = db::exec::cancel(mgr, &run).await;
        }
        h.emit(AgentEventKind::Status { running: false });
    }
}

/// Everything a turn needs; no Tauri types.
/// What a turn works on: a SQL pool, or a Redis connection.
pub enum Target<'a> {
    Sql(&'a Pool),
    Kv(kv::Conn),
}

pub struct Turn<'a> {
    pub chat: &'a dyn ChatModel,
    pub provider: AiProvider,
    pub model: &'a str,
    pub mgr: &'a Manager,
    pub target: Target<'a>,
    /// `id` = the IPC id (bare or scoped `<connId>@<db>`); queries register their run under it.
    pub conn: &'a Connection,
    pub store: &'a Store,
    pub agent: &'a AgentState,
}

/// Runs one user message to completion (or stop/error), then saves the chat. `handle` comes from
/// `AgentState::start`; the turn unregisters itself and emits `Status{running: false}` at the end.
pub async fn run_turn(t: Turn<'_>, handle: Arc<TurnHandle>, text: &str) {
    struct Finish<'a>(&'a AgentState, Arc<TurnHandle>);
    impl Drop for Finish<'_> {
        fn drop(&mut self) {
            let mut turns = lock(&self.0.turns);
            if turns.get(&self.1.conn_id).is_some_and(|h| Arc::ptr_eq(h, &self.1)) {
                turns.remove(&self.1.conn_id);
            }
            drop(turns);
            self.1.emit(AgentEventKind::Status { running: false });
        }
    }
    let _finish = Finish(t.agent, handle.clone());
    let (items, messages) = match t.store.load_chat(&handle.conn_id).await {
        Ok(v) => v,
        Err(e) => return handle.emit(AgentEventKind::Error { message: e.to_string() }),
    };
    let mut run = Run { t, h: handle, items, messages, cur: Cur::default(), schema: String::new(), glossary: String::new() };
    run.go(text).await;
    seal(&mut run.items);
    if let Err(e) = run.t.store.save_chat(&run.h.conn_id, &run.items, &run.messages).await {
        run.h.emit(AgentEventKind::Error { message: format!("The chat could not be saved: {e}") });
    }
}

/// Every tool call in the history needs a result (providers reject the next request otherwise).
fn seal(items: &mut Vec<ChatItem>) {
    if let Some(ChatItem::Assistant { tool_calls, .. }) = items.last()
        && !tool_calls.is_empty()
    {
        let results = tool_calls.iter().map(|c| ToolResult { call_id: c.id.clone(), content: STOPPED.into(), is_error: true }).collect();
        items.push(ChatItem::ToolResults { results });
    }
}

/// The current agent message (text + steps of one model response).
#[derive(Default)]
struct Cur {
    id: String,
    text: String,
    steps: Vec<AgentStep>,
}

struct Run<'a> {
    t: Turn<'a>,
    h: Arc<TurnHandle>,
    items: Vec<ChatItem>,
    messages: Vec<AgentMessage>,
    cur: Cur,
    /// Schema/database in use (default for get_schema).
    schema: String,
    /// Glossary of that schema's data dictionary (system prompt).
    glossary: String,
}

struct ToolOut {
    content: String,
    is_error: bool,
    rejected: bool,
}

fn ok(content: impl Into<String>) -> ToolOut {
    ToolOut { content: content.into(), is_error: false, rejected: false }
}

fn err(content: impl Into<String>) -> ToolOut {
    ToolOut { content: content.into(), is_error: true, rejected: false }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn msg_id(m: &AgentMessage) -> &str {
    match m {
        AgentMessage::User { id, .. }
        | AgentMessage::Agent { id, .. }
        | AgentMessage::Action { id, .. }
        | AgentMessage::Result { id, .. }
        | AgentMessage::Note { id, .. } => id,
    }
}

fn plural(n: u64, what: &str) -> String {
    if n == 1 { format!("1 row {what}") } else { format!("{n} rows {what}") }
}

impl Run<'_> {
    /// Inserts or replaces a chat entry (by id) and emits it.
    fn put(&mut self, m: AgentMessage) {
        match self.messages.iter_mut().find(|x| msg_id(x) == msg_id(&m)) {
            Some(slot) => *slot = m.clone(),
            None => self.messages.push(m.clone()),
        }
        self.h.emit(AgentEventKind::Message { message: m });
    }

    fn put_cur(&mut self) {
        let c = &self.cur;
        let m = AgentMessage::Agent { id: c.id.clone(), text: c.text.clone(), steps: c.steps.clone() };
        self.put(m);
    }

    fn say(&mut self, text: &str) {
        self.cur = Cur { id: new_id(), text: text.into(), steps: vec![] };
        self.put_cur();
    }

    fn step(&mut self, label: &str, detail: &str) {
        self.cur.steps.push(AgentStep { label: label.into(), detail: detail.into() });
        self.put_cur();
    }

    async fn audit(&self, level: RiskLevel, sql: &str, decision: &str, outcome: &str) {
        let e = AuditEntry {
            at: chrono::Utc::now().to_rfc3339(),
            provider: self.t.provider.as_str().into(),
            model: self.t.model.into(),
            level,
            sql: sql.into(),
            decision: decision.into(),
            outcome: outcome.into(),
        };
        if let Err(e) = self.t.store.add_audit(&self.h.conn_id, &e).await {
            log::warn!("agent audit not saved: {e}");
        }
    }

    async fn system_prompt(&mut self) -> String {
        let pool = match &self.t.target {
            Target::Sql(p) => *p,
            Target::Kv(c) => {
                let info: String = redis::cmd("INFO").arg("server").query_async(&mut c.clone()).await.unwrap_or_default();
                let version = kv::parse_info(&info).iter().flat_map(|s| s.fields.iter()).find(|(k, _)| k == "redis_version").map(|(_, v)| format!("Redis {v}"));
                let db = self.t.conn.id.split_once('@').and_then(|(_, d)| d.parse().ok()).or_else(|| kv::base_db(self.t.conn).ok()).unwrap_or(0);
                return kv_tools::system_prompt(self.t.conn, &version.unwrap_or_default(), db);
            }
        };
        let q = match pool {
            Pool::Pg(_) => "SELECT current_setting('server_version'), current_database()::text, current_schema()::text",
            Pool::My(_) => "SELECT VERSION(), COALESCE(DATABASE(), ''), COALESCE(DATABASE(), '')",
            Pool::Lite(_) => "SELECT 'SQLite ' || sqlite_version(), 'main', 'main'",
        };
        let row = risk::text_rows(pool, q, &[]).await.ok().and_then(|r| r.into_iter().next()).unwrap_or_default();
        let get = |i: usize| row.get(i).cloned().unwrap_or_default();
        self.schema = get(2);
        if !self.schema.is_empty() {
            let schema = self.schema.clone();
            if let Ok(d) = self.dictionary(&schema).await.map(|(_, d)| d) {
                self.glossary = dict::glossary_text(&d.terms);
            }
        }
        let facts = ConnFacts { conn: self.t.conn, server_version: &get(0), database: &get(1), schema: &self.schema, glossary: &self.glossary };
        tools::system_prompt(&facts)
    }

    /// The data dictionary of a schema on this connection (saved notes + database comments).
    async fn dictionary(&self, schema: &str) -> AppResult<(DictKey, crate::model::Dictionary)> {
        let Target::Sql(pool) = self.t.target else { return Err(AppError::NotSupported("Not a SQL connection".into())) };
        let key = DictKey { conn: self.h.conn_id.clone(), db: dict::database_name(pool, schema).await, schema: schema.into() };
        let d = dict::load(self.t.store, pool, &key).await?;
        Ok((key, d))
    }

    async fn go(&mut self, text: &str) {
        let id = new_id();
        self.items.push(ChatItem::User { text: text.into(), id: Some(id.clone()) });
        self.put(AgentMessage::User { id, text: text.into() });
        let system = self.system_prompt().await;
        let tools = match self.t.target {
            Target::Sql(_) => tools::specs(),
            Target::Kv(_) => kv_tools::specs(),
        };
        let mut allow_tools = true;
        for call in 0..MAX_CALLS {
            if self.h.stopped() {
                return;
            }
            let mut stripped = false;
            let resp = loop {
                let req = ChatRequest {
                    model: self.t.model.into(),
                    system: system.clone(),
                    items: self.items.clone(),
                    tools: tools.clone(),
                    allow_tools,
                    max_tokens: MAX_TOKENS,
                };
                let r = tokio::select! {
                    r = self.t.chat.complete(&req) => r,
                    _ = self.h.cancelled() => return,
                };
                // Saved thinking blocks are bound to the system prompt and tools they were made with;
                // after either changed (app update, glossary edit), drop them once and resend.
                match r {
                    Err(e) if !stripped && super::thinking_mismatch(&e) && super::strip_thinking(&mut self.items) => stripped = true,
                    r => break r,
                }
            };
            let resp = match resp {
                Ok(r) => r,
                Err(e) => return self.h.emit(AgentEventKind::Error { message: e.to_string() }),
            };
            if resp.stop == StopKind::Refusal {
                // A refused turn isn't replayed: the next message starts clean.
                if matches!(self.items.last(), Some(ChatItem::User { .. })) {
                    self.items.pop();
                }
                let extra = if resp.text.trim().is_empty() { String::new() } else { format!("\n\n{}", resp.text.trim()) };
                return self.say(&format!("The model declined this request.{extra}"));
            }
            let mut shown = resp.text.trim().to_string();
            if resp.stop == StopKind::MaxTokens {
                shown = format!("{shown}\n\n(response cut off)").trim_start().to_string();
            }
            let calls = resp.tool_calls.clone();
            self.items.push(ChatItem::Assistant { text: resp.text, tool_calls: resp.tool_calls, raw: resp.raw });
            self.cur = Cur { id: new_id(), text: shown, steps: vec![] };
            if !self.cur.text.is_empty() || !calls.is_empty() {
                self.put_cur();
            }
            if calls.is_empty() {
                return;
            }
            if call + 1 == MAX_CALLS {
                let results = calls
                    .iter()
                    .map(|c| ToolResult { call_id: c.id.clone(), content: "Not run: the step limit for this message was reached".into(), is_error: true })
                    .collect();
                self.items.push(ChatItem::ToolResults { results });
                return self.say(&format!("Stopped after {MAX_CALLS} steps. Send a message to let the agent continue."));
            }
            // After a rejection the model must answer in text and ask the user.
            allow_tools = !self.run_tools(&calls).await;
        }
    }

    /// Runs the calls in order and appends one ToolResults item covering every call. Returns true
    /// when the user rejected an action (later calls of the same response are skipped).
    async fn run_tools(&mut self, calls: &[ToolCall]) -> bool {
        let mut results = vec![];
        let mut rejected = false;
        for c in calls {
            let out = if self.h.stopped() {
                err(STOPPED)
            } else if rejected {
                err("Not run: the user rejected an earlier action. Ask the user what they want instead.")
            } else {
                self.tool(c).await
            };
            rejected |= out.rejected;
            results.push(ToolResult { call_id: c.id.clone(), content: out.content, is_error: out.is_error });
        }
        self.items.push(ChatItem::ToolResults { results });
        rejected
    }

    async fn tool(&mut self, c: &ToolCall) -> ToolOut {
        if let Target::Kv(conn) = &self.t.target {
            let conn = conn.clone();
            return self.kv_tool(conn, c).await;
        }
        match c.name.as_str() {
            "get_schema" => match tools::parse::<GetSchema>(&c.name, &c.input) {
                Ok(a) => self.get_schema(a).await,
                Err(e) => err(e),
            },
            "run_sql" => match tools::parse::<RunSql>(&c.name, &c.input) {
                Ok(a) if a.sql.trim().is_empty() => err("Invalid arguments for run_sql: sql is empty"),
                Ok(a) => self.run_sql(a).await,
                Err(e) => err(e),
            },
            "save_to_dictionary" => match tools::parse::<SaveToDictionary>(&c.name, &c.input) {
                Ok(a) => self.save_notes(a).await,
                Err(e) => err(e),
            },
            "open_in_editor" => match tools::parse::<OpenInEditor>(&c.name, &c.input) {
                Ok(a) => {
                    self.step("Opening in SQL editor", &a.sql);
                    self.h.emit(AgentEventKind::OpenSql { sql: a.sql });
                    ok("Opened the SQL in a new editor tab for the user.")
                }
                Err(e) => err(e),
            },
            other => err(format!("Unknown tool: {other}")),
        }
    }

    async fn get_schema(&mut self, a: GetSchema) -> ToolOut {
        let schema = a.schema.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| self.schema.clone());
        self.step("Reading schema", &schema);
        if schema.is_empty() {
            return err("No database is selected on this connection; pass `schema`");
        }
        let Target::Sql(pool) = self.t.target else { return err("Not a SQL connection") };
        let m = match db::meta::er_model(pool, &schema).await {
            Ok(m) => m,
            Err(e) => return err(format!("Could not read the schema: {e}")),
        };
        // A dictionary that can't be read leaves the plain schema.
        let d = self.dictionary(&schema).await.map(|(_, d)| d).unwrap_or_default();
        let (notes, terms) = (d.note_count(), d.terms.len());
        if notes + terms > 0
            && let Some(s) = self.cur.steps.last_mut()
        {
            s.detail = format!("{schema} · {notes} dictionary notes, {terms} terms");
            self.put_cur();
        }
        ok(tools::schema_text(&schema, &m, &d))
    }

    /// Shows the proposed dictionary entries on a card and saves the ones the user approves (as verified).
    async fn save_notes(&mut self, a: SaveToDictionary) -> ToolOut {
        if a.notes.is_empty() && a.terms.is_empty() {
            return err("Invalid arguments for save_to_dictionary: give notes or terms");
        }
        let schema = self.schema.clone();
        if schema.is_empty() {
            return err("No database is selected on this connection");
        }
        let (key, d) = match self.dictionary(&schema).await {
            Ok(v) => v,
            Err(e) => return err(format!("Could not read the data dictionary: {e}")),
        };
        let Target::Sql(pool) = self.t.target else { return err("Not a SQL connection") };
        let model = db::meta::er_model(pool, &schema).await.ok();
        let mut items = vec![];
        for n in &a.notes {
            let (table, column) = (n.table.trim().to_string(), n.column.as_deref().unwrap_or_default().trim().to_string());
            if n.note.trim().is_empty() || table.is_empty() {
                return err("Invalid arguments for save_to_dictionary: every note needs a table and text");
            }
            if let Some(m) = &model {
                let Some(t) = m.tables.iter().find(|t| t.name == table) else { return err(format!("There is no table {table} in schema {schema}")) };
                if !column.is_empty() && !t.columns.iter().any(|c| c.name == column) {
                    return err(format!("Table {table} has no column {column}"));
                }
            }
            let before = d.note(&table, &column).map(|(t, _)| t.to_string()).unwrap_or_default();
            items.push(NoteItem { table, column, before, after: n.note.trim().into(), ..Default::default() });
        }
        for t in &a.terms {
            if t.term.trim().is_empty() || t.meaning.trim().is_empty() {
                return err("Invalid arguments for save_to_dictionary: every term needs a name and a meaning");
            }
            let before = d.terms.iter().find(|x| x.term.eq_ignore_ascii_case(t.term.trim())).map(|x| x.meaning.clone()).unwrap_or_default();
            let maps_to = t.maps_to.as_deref().unwrap_or_default().trim().to_string();
            items.push(NoteItem { term: t.term.trim().into(), maps_to, before, after: t.meaning.trim().into(), ..Default::default() });
        }
        let mut card = AgentMessage::Note { id: new_id(), title: a.title, status: ActionStatus::Pending, items: items.clone(), outcome: None };
        self.put(card.clone());
        let Some(dec) = self.decision(&card).await else {
            self.set(&mut card, ActionStatus::Rejected, Some("Stopped".into()), None);
            return err(STOPPED);
        };
        if dec.kind == DecisionKind::Reject {
            self.set(&mut card, ActionStatus::Rejected, None, None);
            return ToolOut { content: REJECTED.into(), is_error: false, rejected: true };
        }
        self.set(&mut card, ActionStatus::Approved, None, None);
        let picks = dec.picks.unwrap_or_else(|| items.iter().enumerate().map(|(index, it)| NotePick { index, text: it.after.clone() }).collect());
        let mut saved = vec![];
        for p in picks {
            let (Some(it), text) = (items.get(p.index), p.text.trim()) else { continue };
            if text.is_empty() {
                continue;
            }
            let r = if it.term.is_empty() {
                let note = DictNote { table: it.table.clone(), column: it.column.clone(), note: text.into(), status: NoteStatus::Verified, evidence: String::new(), unsure: false };
                self.t.store.put_note(&key, &note, false).await
            } else {
                let previous = d.terms.iter().find(|x| x.term.eq_ignore_ascii_case(&it.term)).map(|x| x.term.clone());
                let term = DictTerm { term: it.term.clone(), meaning: text.into(), maps_to: it.maps_to.clone(), status: NoteStatus::Verified, evidence: String::new(), unsure: false };
                self.t.store.put_term(&key, &term, previous.as_deref(), false).await
            };
            if let Err(e) = r {
                self.set(&mut card, ActionStatus::Failed, Some(e.to_string()), None);
                return err(format!("Approved, but saving failed: {e}"));
            }
            let label = if !it.term.is_empty() { it.term.clone() } else if it.column.is_empty() { it.table.clone() } else { format!("{}.{}", it.table, it.column) };
            saved.push(format!("- {label}: {text}{}", if text != it.after { " (edited by the user)" } else { "" }));
        }
        let outcome = if saved.len() == 1 { "Saved 1 entry".to_string() } else { format!("Saved {} entries", saved.len()) };
        self.set(&mut card, ActionStatus::Done, Some(outcome), None);
        if saved.is_empty() {
            return ok("The user approved the card but kept none of the entries.");
        }
        ok(format!("The user approved. Saved to the data dictionary:\n{}", saved.join("\n")))
    }

    /// Runs one statement on the scoped pool and registers it for `stop`. A statement error is `Err`.
    async fn exec(&self, sql: &str, confirmed: bool) -> Result<StatementResult, String> {
        let Target::Sql(pool) = self.t.target else { return Err("Not a SQL connection".into()) };
        let run_id = new_id();
        *lock(&self.h.run_id) = Some(run_id.clone());
        let r = db::exec::execute(self.t.mgr, pool, self.t.conn, sql, confirmed, tools::UI_ROWS, &run_id).await;
        *lock(&self.h.run_id) = None;
        match r.map(|mut v| v.pop()) {
            Ok(Some(s)) => match &s.error {
                None => Ok(s),
                Some(e) => Err(e.message.clone()),
            },
            Ok(None) => Err("Nothing ran".into()),
            Err(e) => Err(e.to_string()),
        }
    }

    async fn run_sql(&mut self, args: RunSql) -> ToolOut {
        let a = match risk::assess(self.t.conn.driver, &args.sql) {
            Ok(a) => a,
            Err(e) => {
                self.step("Running query", &args.sql);
                return err(e);
            }
        };
        if a.level == RiskLevel::Read {
            return self.read(&args.sql).await;
        }
        if self.t.conn.read_only {
            self.audit(a.level, &args.sql, "blocked", "connection is read-only").await;
            return err("This connection is read-only: changes are not allowed. Tell the user instead of trying again.");
        }
        let impact = args.impact.unwrap_or_default();
        let (mut sql, mut a, mut edited) = (args.sql, a, false);
        loop {
            let mut card = self.card(&args.title, &sql, &a, &impact).await;
            let Some(d) = self.decision(&card).await else {
                self.set(&mut card, ActionStatus::Rejected, Some("Stopped".into()), None);
                self.audit(a.level, &sql, "rejected", "stopped").await;
                return err(STOPPED);
            };
            match d.kind {
                DecisionKind::Reject => {
                    self.set(&mut card, ActionStatus::Rejected, None, None);
                    self.audit(a.level, &sql, "rejected", "").await;
                    return ToolOut { content: REJECTED.into(), is_error: false, rejected: true };
                }
                DecisionKind::Edit => {
                    self.set(&mut card, ActionStatus::Superseded, None, None);
                    sql = d.sql.unwrap_or_default();
                    // `decide` validated it already.
                    a = match risk::assess(self.t.conn.driver, &sql) {
                        Ok(a) => a,
                        Err(e) => return err(e),
                    };
                    edited = true;
                }
                DecisionKind::Approve => return self.approved(&mut card, &sql, &a, edited).await,
            }
        }
    }

    /// Read query: runs at once with data access, blocked with schema-only access.
    async fn read(&mut self, sql: &str) -> ToolOut {
        self.step("Running query", sql);
        if self.t.conn.ai_access != AiAccess::Data {
            self.audit(RiskLevel::Read, sql, "blocked", "data access is off").await;
            return err(DATA_OFF);
        }
        match self.exec(sql, false).await {
            Ok(r) => {
                let text = tools::rows_text(&r);
                let n = r.rows.len() as u64;
                self.put(AgentMessage::Result {
                    id: new_id(),
                    sql: sql.into(),
                    columns: r.columns,
                    rows: r.rows,
                    truncated: r.truncated,
                    elapsed_ms: r.elapsed_ms,
                });
                self.audit(RiskLevel::Read, sql, "auto", &format!("ok · {}", plural(n, "returned"))).await;
                ok(text)
            }
            Err(e) => {
                self.audit(RiskLevel::Read, sql, "auto", &e).await;
                err(format!("The query failed: {e}"))
            }
        }
    }

    /// Emits a pending card (facts computed for critical actions) and returns it.
    async fn card(&mut self, title: &str, sql: &str, a: &Assessment, impact: &[String]) -> AgentMessage {
        let critical = a.level == RiskLevel::Critical;
        let facts = if critical {
            let target = a.target().unwrap_or_default();
            match a.op {
                Op::Delete | Op::Update | Op::Truncate => self.step("Counting rows", &target),
                Op::DropTable => self.step("Counting rows and dependent objects", &target),
                Op::DropDatabase => self.step("Measuring database size", &target),
                _ => {}
            }
            match self.t.target {
                Target::Sql(pool) => risk::facts(pool, self.t.conn.driver, a).await,
                Target::Kv(_) => vec![],
            }
        } else {
            vec![]
        };
        let conn = self.t.conn;
        let confirm_name = (critical && conn.env == Env::Prod).then(|| a.target().unwrap_or_else(|| conn.name.clone()));
        self.emit_card(title, sql, a.level, impact, facts, confirm_name)
    }

    /// Emits a pending approval card (impact kept only for critical actions) and returns it.
    fn emit_card(&mut self, title: &str, sql: &str, level: RiskLevel, impact: &[String], facts: Vec<String>, confirm_name: Option<String>) -> AgentMessage {
        let card = AgentMessage::Action {
            id: new_id(),
            level,
            title: title.into(),
            sql: sql.into(),
            status: ActionStatus::Pending,
            impact: if level == RiskLevel::Critical { impact.to_vec() } else { vec![] },
            facts,
            confirm_name,
            elapsed_ms: None,
            outcome: None,
        };
        self.put(card.clone());
        card
    }

    /// Registers the card as pending and waits for the user's decision; `None` = the turn was stopped.
    async fn decision(&mut self, card: &AgentMessage) -> Option<AgentDecision> {
        let (id, confirm_name, note) = match card {
            AgentMessage::Action { id, confirm_name, .. } => (id, confirm_name.clone(), false),
            AgentMessage::Note { id, .. } => (id, None, true),
            _ => return None,
        };
        let (tx, rx) = oneshot::channel();
        let pending = Pending { conn_id: self.h.conn_id.clone(), driver: self.t.conn.driver, confirm_name, note, tx };
        lock(&self.t.agent.pending).insert(id.clone(), pending);
        let decision = tokio::select! {
            d = rx => d.ok(),
            _ = self.h.cancelled() => None,
        };
        lock(&self.t.agent.pending).remove(id);
        decision
    }

    fn set(&mut self, card: &mut AgentMessage, to: ActionStatus, out: Option<String>, ms: Option<u64>) {
        match card {
            AgentMessage::Action { status, outcome, elapsed_ms, .. } => {
                *status = to;
                *outcome = out;
                *elapsed_ms = ms;
            }
            AgentMessage::Note { status, outcome, .. } => {
                *status = to;
                *outcome = out;
            }
            _ => {}
        }
        self.put(card.clone());
    }

    /// Runs exactly the card's SQL (confirmed) and reports the outcome to the card, audit and model.
    async fn approved(&mut self, card: &mut AgentMessage, sql: &str, a: &Assessment, edited: bool) -> ToolOut {
        self.set(card, ActionStatus::Approved, None, None);
        let started = std::time::Instant::now();
        let r = self.exec(sql, true).await;
        let ms = Some(started.elapsed().as_millis() as u64);
        let prefix = if edited { format!("The user edited the SQL and approved it. It ran: {sql}\n") } else { String::new() };
        match r {
            Ok(r) => {
                let outcome = match r.affected {
                    Some(n) if a.is_dml() => plural(n, "affected"),
                    Some(_) => "OK".into(),
                    None => plural(r.rows.len() as u64, "returned"),
                };
                self.set(card, ActionStatus::Done, Some(outcome.clone()), ms);
                self.audit(a.level, sql, "approved", &format!("ok · {outcome}")).await;
                ok(format!("{prefix}Approved and executed: {outcome}"))
            }
            Err(e) => {
                self.set(card, ActionStatus::Failed, Some(e.clone()), ms);
                self.audit(a.level, sql, "approved", &e).await;
                err(format!("{prefix}Approved, but it failed: {e}"))
            }
        }
    }

    // ---------- Redis ----------

    async fn kv_tool(&mut self, mut conn: kv::Conn, c: &ToolCall) -> ToolOut {
        match c.name.as_str() {
            "scan_keys" => match tools::parse::<ScanKeys>(&c.name, &c.input) {
                Ok(a) => {
                    let pattern = a.pattern.filter(|p| !p.trim().is_empty()).unwrap_or_else(|| "*".into());
                    self.step("Scanning keys", &pattern);
                    let limit = a.limit.unwrap_or(50).clamp(1, kv_tools::MAX_KEYS);
                    match kv::scan(&mut conn, "0", &pattern, a.type_filter.as_deref(), None, limit).await {
                        Ok(page) if page.keys.is_empty() => ok(format!("No keys match {pattern}")),
                        Ok(page) => {
                            let mut lines: Vec<String> = page
                                .keys
                                .iter()
                                .take(limit as usize)
                                .map(|k| format!("{} · {} · {}", k.key, k.type_name, if k.ttl_ms < 0 { "no expiry".into() } else { format!("ttl {}s", k.ttl_ms / 1000) }))
                                .collect();
                            if page.cursor != "0" || page.keys.len() > limit as usize {
                                lines.push("(more keys match; narrow the pattern)".into());
                            }
                            ok(lines.join("\n"))
                        }
                        Err(e) => err(format!("Could not scan keys: {e}")),
                    }
                }
                Err(e) => err(e),
            },
            "get_key" => match tools::parse::<GetKey>(&c.name, &c.input) {
                Ok(a) => {
                    self.step("Reading key", &a.key);
                    if self.t.conn.ai_access != AiAccess::Data {
                        self.audit(RiskLevel::Read, &format!("GET {}", a.key), "blocked", "data access is off").await;
                        return err(DATA_OFF);
                    }
                    match kv::entry(&mut conn, &a.key).await {
                        Ok(e) => ok(kv_tools::entry_text(&e)),
                        Err(e) => err(format!("Could not read the key: {e}")),
                    }
                }
                Err(e) => err(e),
            },
            "run_command" => match tools::parse::<RunCommand>(&c.name, &c.input) {
                Ok(a) if a.command.trim().is_empty() => err("Invalid arguments for run_command: command is empty"),
                Ok(a) => self.kv_run(conn, a).await,
                Err(e) => err(e),
            },
            other => err(format!("Unknown tool: {other}")),
        }
    }

    async fn kv_run(&mut self, mut conn: kv::Conn, args: RunCommand) -> ToolOut {
        let (mut line, (mut cmd, class)) = match kv_tools::check(&args.command) {
            Ok(v) => (args.command.trim().to_string(), v),
            Err(e) => {
                self.step("Running command", &args.command);
                return err(e);
            }
        };
        if matches!(class, CmdClass::Meta | CmdClass::Read) {
            return self.kv_read(conn, &line, &cmd, class == CmdClass::Meta).await;
        }
        let mut level = if class == CmdClass::Critical { RiskLevel::Critical } else { RiskLevel::Change };
        if self.t.conn.read_only {
            self.audit(level, &line, "blocked", "connection is read-only").await;
            return err("This connection is read-only: changes are not allowed. Tell the user instead of trying again.");
        }
        let impact = args.impact.unwrap_or_default();
        let mut edited = false;
        loop {
            let critical = level == RiskLevel::Critical;
            let facts = if critical {
                self.step("Counting keys", &line);
                kv_tools::facts(&mut conn, &cmd).await
            } else {
                vec![]
            };
            let conn_name = self.t.conn.name.clone();
            let confirm_name = (critical && self.t.conn.env == Env::Prod).then(|| {
                let keys = kv::command::target_keys(&cmd);
                if keys.is_empty() { conn_name } else { keys.join(", ") }
            });
            let mut card = self.emit_card(&args.title, &line, level, &impact, facts, confirm_name);
            let Some(d) = self.decision(&card).await else {
                self.set(&mut card, ActionStatus::Rejected, Some("Stopped".into()), None);
                self.audit(level, &line, "rejected", "stopped").await;
                return err(STOPPED);
            };
            match d.kind {
                DecisionKind::Reject => {
                    self.set(&mut card, ActionStatus::Rejected, None, None);
                    self.audit(level, &line, "rejected", "").await;
                    return ToolOut { content: REJECTED.into(), is_error: false, rejected: true };
                }
                DecisionKind::Edit => {
                    self.set(&mut card, ActionStatus::Superseded, None, None);
                    line = d.sql.unwrap_or_default().trim().to_string();
                    // `decide` validated it already.
                    let (next, next_class) = match kv_tools::check(&line) {
                        Ok(v) => v,
                        Err(e) => return err(e),
                    };
                    cmd = next;
                    level = if next_class == CmdClass::Critical { RiskLevel::Critical } else { RiskLevel::Change };
                    edited = true;
                }
                DecisionKind::Approve => {
                    self.set(&mut card, ActionStatus::Approved, None, None);
                    let prefix = if edited { format!("The user edited the command and approved it. It ran: {line}\n") } else { String::new() };
                    return match kv::run_command(&mut conn, &cmd).await {
                        Ok(r) if r.error => {
                            self.set(&mut card, ActionStatus::Failed, Some(r.text.clone()), Some(r.elapsed_ms));
                            self.audit(level, &line, "approved", &r.text).await;
                            err(format!("{prefix}Approved, but it failed: {}", r.text))
                        }
                        Ok(r) => {
                            let outcome = r.text.lines().next().unwrap_or("OK").chars().take(120).collect::<String>();
                            self.set(&mut card, ActionStatus::Done, Some(outcome.clone()), Some(r.elapsed_ms));
                            self.audit(level, &line, "approved", &format!("ok · {outcome}")).await;
                            ok(format!("{prefix}Approved and executed:\n{}", kv_tools::reply_text(&r.text)))
                        }
                        Err(e) => {
                            self.set(&mut card, ActionStatus::Failed, Some(e.to_string()), None);
                            self.audit(level, &line, "approved", &e.to_string()).await;
                            err(format!("{prefix}Approved, but it failed: {e}"))
                        }
                    };
                }
            }
        }
    }

    /// Read command: metadata (`meta`) runs with any access; values need data access.
    async fn kv_read(&mut self, mut conn: kv::Conn, line: &str, cmd: &[String], meta: bool) -> ToolOut {
        self.step("Running command", line);
        if !meta && self.t.conn.ai_access != AiAccess::Data {
            self.audit(RiskLevel::Read, line, "blocked", "data access is off").await;
            return err(DATA_OFF);
        }
        match kv::run_command(&mut conn, cmd).await {
            Ok(r) => {
                let rows: Vec<Vec<crate::model::Cell>> = r.text.lines().take(tools::UI_ROWS as usize).map(|l| vec![l.into()]).collect();
                let truncated = r.text.lines().count() > rows.len();
                let reply = Column { name: "reply".into(), type_name: "text".into(), numeric: false, pk: false, fk: false, enum_values: vec![] };
                self.put(AgentMessage::Result { id: new_id(), sql: line.into(), columns: vec![reply], rows, truncated, elapsed_ms: r.elapsed_ms });
                self.audit(RiskLevel::Read, line, "auto", if r.error { &r.text } else { "ok" }).await;
                if r.error { err(format!("The command failed: {}", r.text)) } else { ok(kv_tools::reply_text(&r.text)) }
            }
            Err(e) => {
                self.audit(RiskLevel::Read, line, "auto", &e.to_string()).await;
                err(format!("The command failed: {e}"))
            }
        }
    }
}

// ---------- Tauri-facing wrappers ----------

/// Starts a turn for `id` (a connection id, optionally scoped `<connId>@<db>`) in the background.
/// Progress arrives as `agent-event`s. Errors before the turn starts (no key, AI access off,
/// a turn already running) are returned here.
pub async fn send(app: AppHandle, state: &AppState, id: &str, provider: AiProvider, model: &str, text: &str) -> AppResult<()> {
    if text.trim().is_empty() {
        return Err(AppError::Query("The message is empty".into()));
    }
    let conn = Connection { id: id.to_string(), ..state.store.get(bare_id(id)).await? };
    let key = state
        .secrets
        .get(&ai_account(provider), SecretKind::AiKey)?
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| AppError::Auth(format!("No API key saved for {}. Add one in Settings → AI.", provider.as_str())))?;
    // Resolve the connection before the turn starts so "Not connected" is an error here.
    enum Owned {
        Sql(Arc<Pool>),
        Kv(kv::Conn),
    }
    let owned = if conn.driver == Driver::Redis { Owned::Kv(kv_conn(state, id).await?) } else { Owned::Sql(scoped_pool(state, id).await?) };
    let emitter = app.clone();
    let emit: Emit = Arc::new(move |e| {
        let _ = emitter.emit("agent-event", e);
    });
    let handle = state.agent.start(&conn, emit)?;
    let (model, text) = (model.to_string(), text.to_string());
    // shortcut: one OS thread per running turn, because rustc can't prove the turn future `Send`
    // (higher-ranked lifetime bug through sqlx executors) for `spawn`; switch to spawn once it can.
    std::thread::spawn(move || tauri::async_runtime::block_on(async move {
        let state = app.state::<AppState>();
        let chat = super::client(provider, key);
        let t = Turn {
            chat: chat.as_ref(),
            provider,
            model: &model,
            mgr: &state.db,
            target: match &owned {
                Owned::Sql(p) => Target::Sql(p),
                Owned::Kv(c) => Target::Kv(c.clone()),
            },
            conn: &conn,
            store: &state.store,
            agent: &state.agent,
        };
        run_turn(t, handle, &text).await;
    }));
    Ok(())
}

/// The user's answer to a pending action card. Unknown/expired ids → `NotFound`.
pub async fn decide(state: &AppState, action_id: &str, decision: AgentDecision) -> AppResult<()> {
    state.agent.decide(action_id, decision)
}

/// Stops the running turn of a connection (aborts the provider request and cancels a running query).
pub async fn stop(state: &AppState, conn_id: &str) -> AppResult<()> {
    state.agent.stop(&state.db, conn_id).await;
    Ok(())
}

pub async fn history(state: &AppState, conn_id: &str) -> AppResult<Vec<AgentMessage>> {
    Ok(state.store.load_chat(conn_id).await?.1)
}

/// Removes one exchange: the user message `id` and every entry after it up to the next user message,
/// from the panel history and the model history (matched by id, or for chats saved before ids by
/// the same occurrence of its text). The rest of the conversation then differs from what earlier
/// thinking blocks were signed for, so those are stripped. False when `id` is no user message.
pub fn delete_exchange(items: &mut Vec<ChatItem>, messages: &mut Vec<AgentMessage>, id: &str) -> bool {
    let is_user = |m: &AgentMessage| matches!(m, AgentMessage::User { .. });
    let Some(start) = messages.iter().position(|m| matches!(m, AgentMessage::User { id: x, .. } if x == id)) else { return false };
    let AgentMessage::User { text, .. } = &messages[start] else { unreachable!() };
    let text = text.clone();
    let end = messages[start + 1..].iter().position(is_user).map_or(messages.len(), |i| start + 1 + i);
    // Older chats: the n-th last user item with this text belongs to the n-th last such message.
    let nth = messages[start + 1..].iter().filter(|m| matches!(m, AgentMessage::User { text: t, .. } if *t == text)).count();
    messages.drain(start..end);

    let user_at = |i: &usize| matches!(&items[*i], ChatItem::User { .. });
    let by_id = (0..items.len()).find(|i| matches!(&items[*i], ChatItem::User { id: Some(x), .. } if x == id));
    let by_text = || {
        (0..items.len())
            .rev()
            .filter(|i| matches!(&items[*i], ChatItem::User { id: None, text: t } if *t == text))
            .nth(nth)
    };
    if let Some(from) = by_id.or_else(by_text) {
        let to = (from + 1..items.len()).find(user_at).unwrap_or(items.len());
        items.drain(from..to);
        super::strip_thinking(items);
    }
    true
}

/// Deletes one exchange (see `delete_exchange`) from a connection's saved chat.
pub async fn delete_message(state: &AppState, conn_id: &str, id: &str) -> AppResult<()> {
    if state.agent.is_running(conn_id) {
        return Err(AppError::Query("Stop the agent before deleting messages".into()));
    }
    let (mut items, mut messages) = state.store.load_chat(conn_id).await?;
    if !delete_exchange(&mut items, &mut messages, id) {
        return Err(AppError::NotFound("This message is no longer in the chat".into()));
    }
    state.store.save_chat(conn_id, &items, &messages).await
}

pub async fn clear(state: &AppState, conn_id: &str) -> AppResult<()> {
    if state.agent.is_running(conn_id) {
        return Err(AppError::Query("Stop the agent before clearing the chat".into()));
    }
    state.store.clear_chat(conn_id).await
}

pub async fn audit(state: &AppState, conn_id: &str, limit: u32) -> AppResult<Vec<AuditEntry>> {
    state.store.audit(conn_id, limit).await
}
