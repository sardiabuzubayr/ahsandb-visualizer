//! Agent loop with a scripted fake `ChatModel` (no network) on temp SQLite databases, plus the
//! critical-action facts on PostgreSQL / MariaDB temp schemas (when AHSANDB_TEST_PG / _MYSQL are set).
mod common;

use std::collections::VecDeque;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ahsandb_lib::ai::agent::{self, AgentState, Emit, Target, Turn, run_turn};
use ahsandb_lib::ai::risk;
use ahsandb_lib::ai::{ChatItem, ChatModel, ChatRequest, ChatResponse, RawContent, StopKind, ToolCall, ToolResult};
use ahsandb_lib::db::{self, Manager, Pool};
use ahsandb_lib::error::{AppError, AppResult};
use ahsandb_lib::kv;
use ahsandb_lib::model::*;
use ahsandb_lib::dict::Learner;
use ahsandb_lib::store::{DictKey, Store};
use common::*;
use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

// ---------- fake model ----------

#[derive(Default)]
struct Fake {
    script: Mutex<VecDeque<AppResult<ChatResponse>>>,
    /// Answer once the script is used up (default: a final text).
    repeat: Option<ChatResponse>,
    /// Never answer once the script is used up (to test stop during a provider call).
    hang: bool,
    reqs: Mutex<Vec<ChatRequest>>,
}

impl Fake {
    fn new(script: Vec<ChatResponse>) -> Self {
        Fake { script: Mutex::new(script.into_iter().map(Ok).collect()), ..Default::default() }
    }
    fn reqs(&self) -> Vec<ChatRequest> {
        self.reqs.lock().unwrap().clone()
    }
}

impl ChatModel for Fake {
    fn complete<'a>(&'a self, req: &'a ChatRequest) -> BoxFuture<'a, AppResult<ChatResponse>> {
        Box::pin(async move {
            self.reqs.lock().unwrap().push(req.clone());
            let next = self.script.lock().unwrap().pop_front();
            match next {
                Some(r) => r,
                None if self.hang => futures::future::pending().await,
                None => Ok(self.repeat.clone().unwrap_or_else(|| text("done"))),
            }
        })
    }
}

fn resp(text: &str, calls: Vec<ToolCall>, stop: StopKind) -> ChatResponse {
    ChatResponse { text: text.into(), tool_calls: calls, raw: None, stop, input_tokens: 0, output_tokens: 0 }
}

fn text(t: &str) -> ChatResponse {
    resp(t, vec![], StopKind::EndTurn)
}

fn call(id: &str, name: &str, input: Value) -> ToolCall {
    ToolCall { id: id.into(), name: name.into(), input }
}

fn calls(cs: Vec<ToolCall>) -> ChatResponse {
    resp("", cs, StopKind::ToolUse)
}

fn sql_call(id: &str, sql: &str) -> ChatResponse {
    calls(vec![call(id, "run_sql", json!({"sql": sql, "title": "Do it", "impact": ["Rows are lost"]}))])
}

// ---------- environment ----------

struct Env {
    _dir: tempfile::TempDir,
    store: Store,
    mgr: Manager,
    pool: Arc<Pool>,
    conn: Connection,
    agent: AgentState,
    /// Set for Redis turns (the SQLite pool then goes unused).
    kv: Option<kv::Conn>,
}

const SEED: &str = "
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), status TEXT);
CREATE TABLE items (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id));
INSERT INTO customers VALUES (1, 'a'), (2, 'b');
INSERT INTO orders VALUES (1, 1, 'open'), (2, 1, 'open'), (3, 2, 'paid'), (4, 2, 'paid'), (5, 2, 'open');
CREATE VIEW open_orders AS SELECT * FROM orders WHERE status = 'open';
CREATE TRIGGER trg AFTER INSERT ON orders BEGIN SELECT 1; END;
";

async fn sqlite(access: AiAccess, env: Env_, read_only: bool) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("db.sqlite").to_string_lossy().into_owned();
    db::create_sqlite_file(&file).await.unwrap();
    let base = Connection { file: Some(file), ..conn(Driver::Sqlite) };
    {
        let (mgr, pool) = open(&base).await;
        rows(&mgr, &pool, &base, &format!("{SEED}; SELECT 1")).await;
        let Pool::Lite(p) = &*pool else { unreachable!() };
        p.close().await;
    }
    let conn = Connection { ai_access: access, env: env.0, read_only, ..base };
    let (mgr, pool) = open(&conn).await;
    let store = Store::open(&dir.path().join("app.db")).await.unwrap();
    Env { _dir: dir, store, mgr, pool, conn, agent: AgentState::default(), kv: None }
}

/// Redis environment (AHSANDB_TEST_REDIS); `None` = skipped.
async fn redis_env(access: AiAccess, env: Env_, read_only: bool) -> Option<Env> {
    let c = from_env("AHSANDB_TEST_REDIS", Driver::Redis)?;
    let mut e = sqlite(access, Env_(env.0), read_only).await;
    let (conn, _) = kv::connect(&c, None, None, kv::base_db(&c).unwrap()).await.unwrap();
    e.conn = Connection { id: e.conn.id.clone(), ai_access: access, env: env.0, read_only, ..c };
    e.kv = Some(conn);
    Some(e)
}

/// `Env` newtype so call sites read `sqlite(AiAccess::Data, DEV, false)`.
struct Env_(ahsandb_lib::model::Env);
const DEV: Env_ = Env_(ahsandb_lib::model::Env::Dev);
const PROD: Env_ = Env_(ahsandb_lib::model::Env::Prod);

impl Env {
    /// Runs one user message; `driver` gets the event stream (to answer cards) concurrently.
    async fn turn<D, Fut>(&self, fake: &Fake, msg: &str, driver: D) -> Vec<AgentEvent>
    where
        D: FnOnce(UnboundedReceiver<AgentEvent>) -> Fut,
        Fut: Future<Output = ()>,
    {
        let (tx, rx) = unbounded_channel();
        let all = Arc::new(Mutex::new(vec![]));
        let sink = all.clone();
        let emit: Emit = Arc::new(move |e: AgentEvent| {
            sink.lock().unwrap().push(e.clone());
            let _ = tx.send(e);
        });
        let h = self.agent.start(&self.conn, emit).unwrap();
        let t = Turn {
            chat: fake,
            provider: AiProvider::Anthropic,
            model: "fake",
            mgr: &self.mgr,
            target: match &self.kv {
                Some(c) => Target::Kv(c.clone()),
                None => Target::Sql(&self.pool),
            },
            conn: &self.conn,
            store: &self.store,
            agent: &self.agent,
        };
        tokio::time::timeout(Duration::from_secs(20), async { tokio::join!(run_turn(t, h, msg), driver(rx)) }).await.expect("turn timed out");
        all.lock().unwrap().clone()
    }

    async fn count(&self, sql: &str) -> Value {
        rows(&self.mgr, &self.pool, &self.conn, sql).await[0][0].clone()
    }

    async fn items(&self) -> Vec<ChatItem> {
        self.store.load_chat(&self.conn.id).await.unwrap().0
    }
}

async fn no_driver(_: UnboundedReceiver<AgentEvent>) {}

/// Next pending action card.
async fn pending(rx: &mut UnboundedReceiver<AgentEvent>) -> AgentMessage {
    loop {
        let e = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("no card").expect("channel closed");
        if let AgentEventKind::Message { message: m @ AgentMessage::Action { status: ActionStatus::Pending, .. } } = e.kind {
            return m;
        }
    }
}

fn action_id(m: &AgentMessage) -> String {
    let AgentMessage::Action { id, .. } = m else { panic!("not an action: {m:?}") };
    id.clone()
}

/// Final state of every message, in first-seen order.
fn messages(events: &[AgentEvent]) -> Vec<AgentMessage> {
    let mut out: Vec<AgentMessage> = vec![];
    for e in events {
        if let AgentEventKind::Message { message } = &e.kind {
            let id = |m: &AgentMessage| serde_json::to_value(m).unwrap()["id"].as_str().unwrap().to_string();
            match out.iter_mut().find(|m| id(m) == id(message)) {
                Some(slot) => *slot = message.clone(),
                None => out.push(message.clone()),
            }
        }
    }
    out
}

fn actions(events: &[AgentEvent]) -> Vec<AgentMessage> {
    messages(events).into_iter().filter(|m| matches!(m, AgentMessage::Action { .. })).collect()
}

fn agent_texts(events: &[AgentEvent]) -> Vec<String> {
    messages(events).into_iter().filter_map(|m| if let AgentMessage::Agent { text, .. } = m { Some(text) } else { None }).collect()
}

/// Tool results of the last ToolResults item in a request.
fn results(req: &ChatRequest) -> Vec<ToolResult> {
    req.items.iter().rev().find_map(|i| if let ChatItem::ToolResults { results } = i { Some(results.clone()) } else { None }).expect("tool results")
}

fn approve(typed: Option<&str>) -> AgentDecision {
    AgentDecision { kind: DecisionKind::Approve, sql: None, typed_name: typed.map(Into::into), picks: None }
}

fn decision(kind: DecisionKind) -> AgentDecision {
    AgentDecision { kind, sql: None, typed_name: None, picks: None }
}

// ---------- loop tests ----------

#[tokio::test]
async fn approve_runs_the_exact_sql_with_facts_and_audit() {
    let e = &sqlite(AiAccess::Data, DEV, false).await;
    let sql = "DELETE FROM orders WHERE id = 5";
    let fake = Fake::new(vec![sql_call("c1", sql), text("Deleted order 5.")]);
    let events = e
        .turn(&fake, "delete order 5", |mut rx| async move {
            let card = pending(&mut rx).await;
            let AgentMessage::Action { level, sql: shown, facts, impact, confirm_name, .. } = &card else { unreachable!() };
            assert_eq!(*level, RiskLevel::Critical);
            assert_eq!(shown, sql);
            assert_eq!(facts, &["1 row will be deleted", risk::IRREVERSIBLE]);
            assert_eq!(impact, &["Rows are lost"]);
            assert_eq!(*confirm_name, None);
            e.agent.decide(&action_id(&card), approve(None)).unwrap();
        })
        .await;
    assert_eq!(e.count("SELECT count(*) FROM orders").await, json!(4));
    let AgentMessage::Action { status, outcome, elapsed_ms, .. } = &actions(&events)[0] else { unreachable!() };
    assert_eq!((*status, outcome.as_deref()), (ActionStatus::Done, Some("1 row affected")));
    assert!(elapsed_ms.is_some());
    // The model hears the outcome; the step trail shows the count.
    let reqs = fake.reqs();
    assert_eq!(reqs.len(), 2);
    assert!(reqs.iter().all(|r| r.allow_tools && r.tools.len() == 4 && r.system.contains("SQLite")));
    let r = results(&reqs[1]);
    assert!(!r[0].is_error && r[0].content.contains("1 row affected"), "{r:?}");
    let steps = serde_json::to_string(&messages(&events)).unwrap();
    assert!(steps.contains("Counting rows"));
    assert_eq!(agent_texts(&events).last().unwrap(), "Deleted order 5.");
    assert!(matches!(events.last().unwrap().kind, AgentEventKind::Status { running: false }));
    // Persisted history and audit.
    let items = e.items().await;
    assert_eq!(items.len(), 4);
    assert!(matches!(&items[3], ChatItem::Assistant { text, .. } if text == "Deleted order 5."));
    let history = e.store.load_chat(&e.conn.id).await.unwrap().1;
    assert_eq!(history.len(), messages(&events).len());
    let audit = e.store.audit(&e.conn.id, 10).await.unwrap();
    assert_eq!((audit[0].decision.as_str(), audit[0].sql.as_str(), audit[0].level), ("approved", sql, RiskLevel::Critical));
    assert_eq!(audit[0].outcome, "ok · 1 row affected");
    assert!(!e.agent.is_running(&e.conn.id));
}

#[tokio::test]
async fn reject_forces_a_text_answer() {
    let e = &sqlite(AiAccess::Data, DEV, false).await;
    let fake = Fake::new(vec![sql_call("c1", "UPDATE orders SET status = 'x'"), text("What would you like instead?")]);
    let events = e
        .turn(&fake, "mark all", |mut rx| async move {
            let card = pending(&mut rx).await;
            assert!(matches!(card, AgentMessage::Action { level: RiskLevel::Critical, .. }), "UPDATE without WHERE");
            e.agent.decide(&action_id(&card), decision(DecisionKind::Reject)).unwrap();
            // A decided card is gone.
            assert!(matches!(e.agent.decide(&action_id(&card), approve(None)), Err(AppError::NotFound(_))));
        })
        .await;
    let reqs = fake.reqs();
    assert!(reqs[0].allow_tools);
    assert!(!reqs[1].allow_tools, "the call after a rejection must not allow tools");
    assert_eq!(results(&reqs[1])[0].content, agent::REJECTED);
    assert!(matches!(&actions(&events)[0], AgentMessage::Action { status: ActionStatus::Rejected, .. }));
    assert_eq!(e.count("SELECT count(*) FROM orders WHERE status = 'x'").await, json!(0));
    assert_eq!(e.store.audit(&e.conn.id, 1).await.unwrap()[0].decision, "rejected");
}

#[tokio::test]
async fn edit_supersedes_the_card_and_asks_again() {
    let e = &sqlite(AiAccess::Data, DEV, false).await;
    let edited = "UPDATE orders SET status = 'cancelled' WHERE id = 1";
    let fake = Fake::new(vec![sql_call("c1", "DELETE FROM orders WHERE id = 1"), text("Done.")]);
    let events = e
        .turn(&fake, "remove order 1", |mut rx| async move {
            let first = pending(&mut rx).await;
            let id = action_id(&first);
            // Invalid edits are refused and the card stays pending.
            let bad = AgentDecision { kind: DecisionKind::Edit, sql: Some("SELECT 1; SELECT 2".into()), typed_name: None, picks: None };
            assert!(matches!(e.agent.decide(&id, bad), Err(AppError::Query(m)) if m.contains("one statement")));
            let edit = AgentDecision { kind: DecisionKind::Edit, sql: Some(edited.into()), typed_name: None, picks: None };
            e.agent.decide(&id, edit).unwrap();
            let second = pending(&mut rx).await;
            let AgentMessage::Action { level, title, sql, .. } = &second else { unreachable!() };
            assert_ne!(action_id(&second), id);
            assert_eq!((*level, title.as_str(), sql.as_str()), (RiskLevel::Change, "Do it", edited));
            e.agent.decide(&action_id(&second), approve(None)).unwrap();
        })
        .await;
    let cards = actions(&events);
    assert!(matches!(&cards[0], AgentMessage::Action { status: ActionStatus::Superseded, .. }));
    assert!(matches!(&cards[1], AgentMessage::Action { status: ActionStatus::Done, .. }));
    assert_eq!(e.count("SELECT status FROM orders WHERE id = 1").await, json!("cancelled"));
    let r = results(&fake.reqs()[1]);
    assert!(r[0].content.contains("edited") && r[0].content.contains(edited), "{r:?}");
}

#[tokio::test]
async fn reads_run_with_data_access() {
    let e = &sqlite(AiAccess::Data, DEV, false).await;
    let fake = Fake::new(vec![sql_call("c1", "SELECT id, status FROM orders ORDER BY id"), text("5 orders.")]);
    let events = e.turn(&fake, "how many orders?", no_driver).await;
    let result = messages(&events).into_iter().find(|m| matches!(m, AgentMessage::Result { .. })).expect("result message");
    let AgentMessage::Result { rows, columns, truncated, .. } = result else { unreachable!() };
    assert_eq!((rows.len(), columns.len(), truncated), (5, 2, false));
    let r = results(&fake.reqs()[1]);
    assert!(!r[0].is_error && r[0].content.starts_with("id | status\n1 | open") && r[0].content.ends_with("(5 rows)"), "{r:?}");
    assert_eq!(e.store.audit(&e.conn.id, 1).await.unwrap()[0].decision, "auto");
    assert!(actions(&events).is_empty());
}

#[tokio::test]
async fn schema_only_blocks_data_reads() {
    let e = &sqlite(AiAccess::Schema, DEV, false).await;
    let fake = Fake::new(vec![
        calls(vec![call("c1", "get_schema", json!({})), call("c2", "run_sql", json!({"sql": "SELECT * FROM orders", "title": "Read"}))]),
        text("I can't read data."),
    ]);
    let events = e.turn(&fake, "show orders", no_driver).await;
    let r = results(&fake.reqs()[1]);
    assert_eq!(r.len(), 2, "all results in one item");
    assert!(!r[0].is_error && r[0].content.contains("orders") && r[0].content.contains("items.order_id -> orders.id"), "{r:?}");
    assert!(r[1].is_error && r[1].content == agent::DATA_OFF);
    assert!(!messages(&events).iter().any(|m| matches!(m, AgentMessage::Result { .. })));
    assert_eq!(e.store.audit(&e.conn.id, 1).await.unwrap()[0].decision, "blocked");
    assert!(fake.reqs()[0].system.contains("schema only"));
}

#[tokio::test]
async fn read_only_blocks_writes_without_a_card() {
    let e = &sqlite(AiAccess::Data, DEV, true).await;
    let fake = Fake::new(vec![sql_call("c1", "INSERT INTO orders (id, status) VALUES (9, 'x')"), text("Read-only.")]);
    let events = e.turn(&fake, "add an order", no_driver).await;
    assert!(actions(&events).is_empty());
    let r = results(&fake.reqs()[1]);
    assert!(r[0].is_error && r[0].content.contains("read-only"), "{r:?}");
    let audit = e.store.audit(&e.conn.id, 1).await.unwrap();
    assert_eq!((audit[0].decision.as_str(), audit[0].level), ("blocked", RiskLevel::Change));
}

#[tokio::test]
async fn production_critical_needs_the_exact_name() {
    let e = &sqlite(AiAccess::Data, PROD, false).await;
    let fake = Fake::new(vec![sql_call("c1", "DROP TABLE orders"), text("Dropped.")]);
    let events = e
        .turn(&fake, "drop orders", |mut rx| async move {
            let card = pending(&mut rx).await;
            let AgentMessage::Action { confirm_name, facts, .. } = &card else { unreachable!() };
            assert_eq!(confirm_name.as_deref(), Some("orders"));
            assert_eq!(
                facts,
                &[
                    "orders has 5 rows",
                    "Tables with foreign keys to orders: items",
                    "Views that depend on it: open_orders",
                    "Triggers dropped with it: trg",
                    risk::IRREVERSIBLE,
                ]
            );
            let id = action_id(&card);
            for typed in [None, Some("wrong"), Some("Orders")] {
                assert!(matches!(e.agent.decide(&id, approve(typed)), Err(AppError::Query(_))), "{typed:?}");
            }
            e.agent.decide(&id, approve(Some("orders"))).unwrap();
        })
        .await;
    assert!(matches!(&actions(&events)[0], AgentMessage::Action { status: ActionStatus::Done, outcome: Some(o), .. } if o == "OK"));
    let left = e.count("SELECT count(*) FROM sqlite_master WHERE name = 'orders'").await;
    assert_eq!(left, json!(0));
}

#[tokio::test]
async fn stop_resolves_pending_cards_and_seals_history() {
    let e = &sqlite(AiAccess::Data, DEV, false).await;
    let fake = Fake::new(vec![calls(vec![
        call("c1", "run_sql", json!({"sql": "DELETE FROM orders", "title": "Wipe"})),
        call("c2", "get_schema", json!({})),
    ])]);
    let events = e
        .turn(&fake, "wipe", |mut rx| async move {
            pending(&mut rx).await;
            assert!(e.agent.is_running(&e.conn.id));
            e.agent.stop(&e.mgr, &e.conn.id).await;
        })
        .await;
    let AgentMessage::Action { status, outcome, .. } = &actions(&events)[0] else { unreachable!() };
    assert_eq!((*status, outcome.as_deref()), (ActionStatus::Rejected, Some("Stopped")));
    assert_eq!(fake.reqs().len(), 1);
    assert_eq!(e.count("SELECT count(*) FROM orders").await, json!(5));
    assert!(matches!(events.last().unwrap().kind, AgentEventKind::Status { running: false }));
    assert!(!e.agent.is_running(&e.conn.id));
    // Every tool call in the saved history has a result.
    let items = e.items().await;
    let ChatItem::ToolResults { results } = items.last().unwrap() else { panic!("{items:?}") };
    assert_eq!(results.iter().map(|r| (r.call_id.as_str(), r.is_error)).collect::<Vec<_>>(), [("c1", true), ("c2", true)]);
    assert!(results.iter().all(|r| r.content == agent::STOPPED));
}

#[tokio::test]
async fn stop_aborts_a_provider_call() {
    let e = &sqlite(AiAccess::Data, DEV, false).await;
    let fake = Fake { hang: true, ..Default::default() };
    let events = e
        .turn(&fake, "hello", |_rx| async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            e.agent.stop(&e.mgr, &e.conn.id).await;
        })
        .await;
    assert_eq!(fake.reqs().len(), 1);
    assert!(matches!(events.last().unwrap().kind, AgentEventKind::Status { running: false }));
    assert!(matches!(e.items().await.as_slice(), [ChatItem::User { .. }]));
}

#[tokio::test]
async fn invalid_calls_are_tool_errors() {
    let e = &sqlite(AiAccess::Data, DEV, false).await;
    let fake = Fake::new(vec![
        calls(vec![
            call("c1", "run_sql", json!({"sql": "DELETE FROM orders; DELETE FROM customers", "title": "Both"})),
            call("c2", "run_sql", json!({"sql": "SET search_path TO x", "title": "Set"})),
            call("c3", "run_sql", json!({"_raw": "{\"sql\": \"SEL"})),
            call("c4", "run_sql", json!({"title": "no sql"})),
            call("c5", "nope", json!({})),
            call("c6", "open_in_editor", json!({"sql": "SELECT 42"})),
        ]),
        text("ok"),
    ]);
    let events = e.turn(&fake, "go", no_driver).await;
    let r = results(&fake.reqs()[1]);
    let errs: Vec<(bool, &str)> = r.iter().map(|r| (r.is_error, r.content.as_str())).collect();
    assert!(errs[0].0 && errs[0].1.contains("one statement per call"), "{errs:?}");
    assert!(errs[1].0 && errs[1].1.contains("not allowed"));
    assert!(errs[2].0 && errs[2].1.contains("Invalid arguments"));
    assert!(errs[3].0 && errs[3].1.contains("Invalid arguments"));
    assert!(errs[4].0 && errs[4].1.contains("Unknown tool"));
    assert!(!errs[5].0);
    assert!(actions(&events).is_empty());
    assert!(events.iter().any(|e| matches!(&e.kind, AgentEventKind::OpenSql { sql } if sql == "SELECT 42")));
}

#[tokio::test]
async fn loop_stops_after_twelve_calls() {
    let e = &sqlite(AiAccess::Data, DEV, false).await;
    let fake = Fake { repeat: Some(calls(vec![call("c", "get_schema", json!({}))])), ..Default::default() };
    let events = e.turn(&fake, "loop", no_driver).await;
    assert_eq!(fake.reqs().len(), agent::MAX_CALLS);
    assert!(agent_texts(&events).last().unwrap().contains("12 steps"));
    let items = e.items().await;
    assert!(matches!(items.last(), Some(ChatItem::ToolResults { results }) if results[0].is_error));
}

#[tokio::test]
async fn refusal_max_tokens_and_provider_errors() {
    let e = &sqlite(AiAccess::Data, DEV, false).await;
    let fake = Fake::new(vec![resp("", vec![], StopKind::Refusal)]);
    let events = e.turn(&fake, "bad", no_driver).await;
    assert_eq!(agent_texts(&events), ["The model declined this request."]);
    assert!(e.items().await.is_empty(), "a refused message isn't replayed");

    let fake = Fake::new(vec![resp("partial", vec![], StopKind::MaxTokens)]);
    let events = e.turn(&fake, "long", no_driver).await;
    assert_eq!(agent_texts(&events), ["partial\n\n(response cut off)"]);

    let fake = Fake { script: Mutex::new(VecDeque::from([Err(AppError::Connection("provider busy".into()))])), ..Default::default() };
    let events = e.turn(&fake, "again", no_driver).await;
    assert!(events.iter().any(|e| matches!(&e.kind, AgentEventKind::Error { message } if message == "provider busy")));
    let items = e.items().await;
    assert!(matches!(items.last(), Some(ChatItem::User { text, .. }) if text == "again"));
    // Earlier turns are replayed to the next request.
    assert_eq!(fake.reqs()[0].items.len(), items.len());
}

#[tokio::test]
async fn start_refuses_ai_off_and_a_second_turn() {
    let e = &sqlite(AiAccess::Data, DEV, false).await;
    let emit: Emit = Arc::new(|_| {});
    let off = Connection { ai_access: AiAccess::Off, ..e.conn.clone() };
    assert!(matches!(e.agent.start(&off, emit.clone()), Err(AppError::Query(m)) if m.contains("AI access is off")));
    let _h = e.agent.start(&e.conn, emit.clone()).unwrap();
    let scoped = Connection { id: format!("{}@main", e.conn.id), ..e.conn.clone() };
    assert!(matches!(e.agent.start(&scoped, emit), Err(AppError::Query(m)) if m.contains("already running")));
}

// ---------- facts on PostgreSQL / MariaDB ----------

async fn facts(pool: &Pool, driver: Driver, sql: &str) -> Vec<String> {
    risk::facts(pool, driver, &risk::assess(driver, sql).unwrap()).await
}

async fn pg_exec(pool: &Pool, sql: &str) {
    let Pool::Pg(p) = pool else { panic!("not PostgreSQL") };
    sqlx::raw_sql(sql).execute(p).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
}

#[tokio::test]
async fn postgres_facts() {
    let Some(c) = from_env("AHSANDB_TEST_PG", Driver::Postgres) else { return };
    let s = format!("ahsandb_t_{}", rand_suffix());
    let (_mgr, pool) = open(&c).await;
    // catch_unwind instead of spawn: the facts future isn't provably `Send` (rustc HRTB limitation).
    let outcome = AssertUnwindSafe(pg_body(c.clone(), s.clone())).catch_unwind().await;
    pg_exec(&pool, &format!("DROP SCHEMA IF EXISTS {s} CASCADE")).await;
    if let Err(e) = outcome {
        std::panic::resume_unwind(e);
    }
}

async fn pg_body(c: Connection, s: String) {
    let (_mgr, pool) = open(&c).await;
    pg_exec(&pool, &format!(
        "CREATE SCHEMA {s};
         CREATE TABLE {s}.parent (id int PRIMARY KEY);
         CREATE TABLE {s}.child (id int PRIMARY KEY, parent_id int REFERENCES {s}.parent(id));
         CREATE TABLE {s}.log (n int);
         INSERT INTO {s}.parent VALUES (1), (2), (3);
         CREATE VIEW {s}.v AS SELECT id FROM {s}.parent;
         CREATE FUNCTION {s}.tf() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
         CREATE TRIGGER trg BEFORE INSERT ON {s}.parent FOR EACH ROW EXECUTE FUNCTION {s}.tf();
         CREATE FUNCTION {s}.bump() RETURNS int LANGUAGE plpgsql AS $$BEGIN INSERT INTO {s}.log VALUES (1); RETURN 1; END$$;")).await;
    let pg = Driver::Postgres;
    assert_eq!(facts(&pool, pg, &format!("DELETE FROM {s}.parent WHERE id > 1")).await, ["2 rows will be deleted", risk::IRREVERSIBLE]);
    assert_eq!(facts(&pool, pg, &format!("UPDATE {s}.parent SET id = id")).await[0], "3 rows will be updated");
    assert_eq!(facts(&pool, pg, &format!("TRUNCATE {s}.parent")).await[0], "parent has 3 rows");
    assert_eq!(
        facts(&pool, pg, &format!("DROP TABLE {s}.parent")).await,
        [
            "parent has 3 rows".to_string(),
            format!("Tables with foreign keys to parent: {s}.child"),
            format!("Views that depend on it: {s}.v"),
            "Triggers dropped with it: trg".to_string(),
            risk::IRREVERSIBLE.to_string(),
        ]
    );
    assert_eq!(facts(&pool, pg, &format!("DROP TABLE {s}.log")).await[1], "No foreign keys, views or triggers depend on log");
    // The count runs read-only: a writing function in WHERE fails instead of writing.
    assert_eq!(facts(&pool, pg, &format!("DELETE FROM {s}.parent WHERE {s}.bump() > 0")).await[0], "Affected rows could not be counted");
    let Pool::Pg(p) = &*pool else { unreachable!() };
    let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {s}.log")).fetch_one(p).await.unwrap();
    assert_eq!(n, 0);
    let size = facts(&pool, pg, "DROP DATABASE ahsandb_test").await;
    assert!(size[0].starts_with("Database ahsandb_test uses ") && size[0].ends_with("B"), "{size:?}");
}

#[tokio::test]
async fn mariadb_facts() {
    let Some(c) = from_env("AHSANDB_TEST_MYSQL", Driver::Mariadb) else { return };
    let tmp = format!("ahsandb_t_{}", rand_suffix());
    let (_mgr, admin) = open(&c).await;
    let Pool::My(a) = &*admin else { unreachable!() };
    sqlx::raw_sql(&format!("CREATE DATABASE {tmp}")).execute(a).await.unwrap();
    let outcome = AssertUnwindSafe(my_body(c.clone(), tmp.clone())).catch_unwind().await;
    sqlx::raw_sql(&format!("DROP DATABASE IF EXISTS {tmp}")).execute(a).await.unwrap();
    if let Err(e) = outcome {
        std::panic::resume_unwind(e);
    }
}

async fn my_body(c: Connection, tmp: String) {
    let scoped = Connection { database: Some(tmp.clone()), ..c };
    let (_mgr, pool) = open(&scoped).await;
    let Pool::My(p) = &*pool else { unreachable!() };
    for sql in [
        "CREATE TABLE parent (id int PRIMARY KEY) ENGINE=InnoDB",
        "CREATE TABLE child (id int PRIMARY KEY, parent_id int, FOREIGN KEY (parent_id) REFERENCES parent(id)) ENGINE=InnoDB",
        "CREATE TABLE parent_archive (id int)",
        "INSERT INTO parent VALUES (1), (2), (3)",
        "CREATE VIEW v AS SELECT id FROM parent",
        "CREATE VIEW v2 AS SELECT id FROM parent_archive",
        "CREATE TRIGGER trg BEFORE INSERT ON parent FOR EACH ROW SET NEW.id = NEW.id",
    ] {
        sqlx::raw_sql(sql).execute(p).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    let my = Driver::Mariadb;
    assert_eq!(facts(&pool, my, "DELETE FROM parent WHERE id = 1").await, ["1 row will be deleted", risk::IRREVERSIBLE]);
    assert_eq!(
        facts(&pool, my, "DROP TABLE `parent`").await,
        ["parent has 3 rows", "Tables with foreign keys to parent: child", "Views that depend on it: v", "Triggers dropped with it: trg", risk::IRREVERSIBLE]
    );
    assert_eq!(facts(&pool, my, &format!("DROP TABLE {tmp}.parent_archive")).await[1], "Views that depend on it: v2");
    let size = facts(&pool, my, &format!("DROP DATABASE {tmp}")).await;
    assert!(size[0].starts_with(&format!("Database {tmp} has 3 tables using ")), "{size:?}");
}

// ---------- Redis ----------

fn cmd_call(id: &str, command: &str) -> ChatResponse {
    calls(vec![call(id, "run_command", json!({"command": command, "title": "Do it", "impact": ["Keys are lost"]}))])
}

async fn redis_run(e: &Env, line: &str) -> String {
    let args = kv::command::split_args(line).unwrap();
    kv::run_command(&mut e.kv.clone().unwrap(), &args).await.unwrap().text
}

#[tokio::test]
async fn redis_reads_run_and_writes_wait_for_approval() {
    let Some(e) = &redis_env(AiAccess::Data, DEV, false).await else { return };
    let k = format!("ahsandb_t_{}:k", rand_suffix());
    let fake = Fake::new(vec![
        cmd_call("c1", &format!("SET {k} hello")),
        calls(vec![call("c2", "get_key", json!({"key": k}))]),
        calls(vec![call("c3", "scan_keys", json!({"pattern": format!("{k}*")}))]),
        cmd_call("c4", &format!("GET {k}")),
        cmd_call("c5", "SELECT 2"),
        text("Done."),
    ]);
    let expected = format!("SET {k} hello");
    let events = e
        .turn(&fake, "set it", |mut rx| async move {
            let card = pending(&mut rx).await;
            let AgentMessage::Action { level, sql, facts, .. } = &card else { unreachable!() };
            assert_eq!((*level, sql.as_str()), (RiskLevel::Change, expected.as_str()));
            assert!(facts.is_empty());
            e.agent.decide(&action_id(&card), approve(None)).unwrap();
        })
        .await;
    let reqs = fake.reqs();
    let names: Vec<_> = reqs[0].tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["scan_keys", "get_key", "run_command"]);
    assert!(reqs[0].system.contains("Redis") && reqs[0].system.contains("db"));
    assert!(results(&reqs[1])[0].content.contains("Approved and executed:\nOK"));
    assert!(results(&reqs[2])[0].content.contains("string · no expiry · size 5\nhello"), "{:?}", results(&reqs[2]));
    assert!(results(&reqs[3])[0].content.contains(&format!("{k} · string")));
    assert_eq!(results(&reqs[4])[0].content, "\"hello\"");
    let refused = &results(&reqs[5])[0];
    assert!(refused.is_error && refused.content.contains("not allowed"), "{refused:?}");
    // The read shows as a result block; the write was audited.
    assert!(messages(&events).iter().any(|m| matches!(m, AgentMessage::Result { sql, rows, .. } if sql == &format!("GET {k}") && rows[0][0] == json!("\"hello\""))));
    let audit = e.store.audit(&e.conn.id, 10).await.unwrap();
    assert!(audit.iter().any(|a| a.decision == "approved" && a.sql == format!("SET {k} hello")));
    redis_run(e, &format!("DEL {k}")).await;
}

#[tokio::test]
async fn redis_production_delete_needs_the_key_name() {
    let Some(e) = &redis_env(AiAccess::Data, PROD, false).await else { return };
    let k = format!("ahsandb_t_{}:k", rand_suffix());
    redis_run(e, &format!("RPUSH {k} a b c")).await;
    let fake = Fake::new(vec![cmd_call("c1", &format!("DEL {k}")), text("Deleted.")]);
    let key = k.clone();
    e.turn(&fake, "delete it", |mut rx| async move {
        let card = pending(&mut rx).await;
        let AgentMessage::Action { level, facts, confirm_name, impact, .. } = &card else { unreachable!() };
        assert_eq!(*level, RiskLevel::Critical);
        assert_eq!(facts, &[format!("{key}: list, size 3"), risk::IRREVERSIBLE.to_string()]);
        assert_eq!(impact, &["Keys are lost"]);
        assert_eq!(confirm_name.as_deref(), Some(key.as_str()));
        assert!(matches!(e.agent.decide(&action_id(&card), approve(Some("wrong"))), Err(AppError::Query(_))));
        // An edit to a blocked command is refused; the card stays pending.
        let bad = AgentDecision { kind: DecisionKind::Edit, sql: Some("SELECT 1".into()), typed_name: None, picks: None };
        assert!(matches!(e.agent.decide(&action_id(&card), bad), Err(AppError::Query(_))));
        e.agent.decide(&action_id(&card), approve(Some(&key))).unwrap();
    })
    .await;
    assert_eq!(redis_run(e, &format!("EXISTS {k}")).await, "(integer) 0");
}

#[tokio::test]
async fn redis_schema_only_and_read_only() {
    let Some(e) = &redis_env(AiAccess::Schema, DEV, true).await else { return };
    let k = format!("ahsandb_t_{}:k", rand_suffix());
    redis_run(e, &format!("SET {k} secret")).await;
    let fake = Fake::new(vec![
        calls(vec![call("c1", "get_key", json!({"key": k}))]),
        cmd_call("c2", &format!("GET {k}")),
        cmd_call("c3", &format!("TYPE {k}")),
        cmd_call("c4", &format!("SET {k} changed")),
        text("ok"),
    ]);
    let events = e.turn(&fake, "look", no_driver).await;
    let reqs = fake.reqs();
    assert_eq!(results(&reqs[1])[0].content, agent::DATA_OFF);
    assert_eq!(results(&reqs[2])[0].content, agent::DATA_OFF);
    assert_eq!(results(&reqs[3])[0].content, "string");
    assert!(results(&reqs[4])[0].content.contains("read-only"));
    assert!(actions(&events).is_empty(), "no card on a read-only connection");
    assert_eq!(redis_run(e, &format!("GET {k}")).await, "\"secret\"");
    redis_run(e, &format!("DEL {k}")).await;
}

// ---------- data dictionary ----------

/// Next pending dictionary card.
async fn pending_note(rx: &mut UnboundedReceiver<AgentEvent>) -> (String, Vec<NoteItem>) {
    loop {
        let e = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("no card").expect("channel closed");
        if let AgentEventKind::Message { message: AgentMessage::Note { id, items, status: ActionStatus::Pending, .. } } = e.kind {
            return (id, items);
        }
    }
}

fn main_key(e: &Env) -> DictKey {
    DictKey { conn: e.conn.id.clone(), db: "main".into(), schema: "main".into() }
}

fn dnote(table: &str, column: &str, note: &str, status: NoteStatus) -> DictNote {
    DictNote { table: table.into(), column: column.into(), note: note.into(), status, evidence: String::new(), unsure: false }
}

fn save_call(id: &str, input: Value) -> ChatResponse {
    calls(vec![call(id, "save_to_dictionary", input)])
}

#[tokio::test]
async fn dictionary_reaches_the_agent_and_cards_save_what_the_user_kept() {
    let e = &sqlite(AiAccess::Schema, DEV, true).await;
    let key = main_key(e);
    e.store.put_note(&key, &dnote("orders", "status", "open = not paid yet", NoteStatus::Draft), false).await.unwrap();
    let paid = DictTerm { term: "Paid".into(), meaning: "Order settled".into(), maps_to: "orders.status = 'paid'".into(), status: NoteStatus::Verified, evidence: String::new(), unsure: false };
    e.store.put_term(&key, &paid, None, false).await.unwrap();
    let fake = Fake::new(vec![
        calls(vec![call("c1", "get_schema", json!({}))]),
        save_call(
            "c2",
            json!({"title": "Fix status", "notes": [
                {"table": "orders", "column": "status", "note": "open = awaiting payment"},
                {"table": "orders", "note": "One order per checkout"}
            ], "terms": [{"term": "open order", "meaning": "Not paid yet", "maps_to": "orders.status = 'open'"}]}),
        ),
        text("Saved."),
    ]);
    let events = e
        .turn(&fake, "status open means awaiting payment", |mut rx| async move {
            let (id, items) = pending_note(&mut rx).await;
            assert_eq!(items.len(), 3);
            assert_eq!((items[0].before.as_str(), items[0].after.as_str()), ("open = not paid yet", "open = awaiting payment"));
            assert_eq!((items[1].column.as_str(), items[1].before.as_str()), ("", ""));
            assert_eq!((items[2].term.as_str(), items[2].maps_to.as_str()), ("open order", "orders.status = 'open'"));
            // Dictionary cards have no SQL to edit.
            let edit = AgentDecision { kind: DecisionKind::Edit, sql: Some("x".into()), typed_name: None, picks: None };
            assert!(matches!(e.agent.decide(&id, edit), Err(AppError::Query(_))));
            let picks = vec![NotePick { index: 0, text: "open = awaiting payment (unpaid)".into() }, NotePick { index: 2, text: "Not paid yet".into() }];
            e.agent.decide(&id, AgentDecision { kind: DecisionKind::Approve, sql: None, typed_name: None, picks: Some(picks) }).unwrap();
        })
        .await;
    let reqs = fake.reqs();
    assert!(reqs[0].system.contains("Business glossary"));
    assert!(reqs[0].system.ends_with("- Paid: Order settled → orders.status = 'paid'"), "{}", reqs[0].system);
    let schema = &results(&reqs[1])[0].content;
    assert!(schema.contains("orders (~") || schema.contains("orders: "), "{schema}");
    assert!(schema.contains("  status: open = not paid yet (draft)\n"), "{schema}");
    let saved = &results(&reqs[2])[0];
    assert!(!saved.is_error && saved.content.contains("orders.status: open = awaiting payment (unpaid) (edited by the user)"), "{saved:?}");
    assert!(saved.content.contains("open order: Not paid yet") && !saved.content.contains("One order per checkout"));
    let (notes, terms) = e.store.dictionary(&key).await.unwrap();
    assert_eq!(notes, vec![dnote("orders", "status", "open = awaiting payment (unpaid)", NoteStatus::Verified)]);
    assert_eq!(terms.iter().map(|t| (t.term.as_str(), t.status)).collect::<Vec<_>>(), [("Paid", NoteStatus::Verified), ("open order", NoteStatus::Verified)]);
    let steps = serde_json::to_string(&messages(&events)).unwrap();
    assert!(steps.contains("main · 1 dictionary notes, 1 terms"), "{steps}");
    let note = messages(&events).into_iter().find(|m| matches!(m, AgentMessage::Note { .. })).unwrap();
    assert!(matches!(note, AgentMessage::Note { status: ActionStatus::Done, outcome: Some(ref o), .. } if o == "Saved 2 entries"));
}

#[tokio::test]
async fn dictionary_cards_can_be_rejected_and_bad_targets_are_tool_errors() {
    let e = &sqlite(AiAccess::Schema, DEV, false).await;
    let fake = Fake::new(vec![
        save_call("c1", json!({"title": "x", "notes": [{"table": "ghosts", "note": "?"}]})),
        save_call("c2", json!({"title": "x", "notes": [{"table": "orders", "column": "nope", "note": "?"}]})),
        save_call("c3", json!({"title": "x"})),
        save_call("c4", json!({"title": "Customers", "notes": [{"table": "customers", "note": "People who order"}]})),
        text("Okay."),
    ]);
    e.turn(&fake, "remember this", |mut rx| async move {
        let (id, _) = pending_note(&mut rx).await;
        e.agent.decide(&id, decision(DecisionKind::Reject)).unwrap();
    })
    .await;
    let reqs = fake.reqs();
    assert!(results(&reqs[1])[0].content.contains("There is no table ghosts"));
    assert!(results(&reqs[2])[0].content.contains("Table orders has no column nope"));
    assert!(results(&reqs[3])[0].is_error);
    assert_eq!(results(&reqs[4])[0].content, agent::REJECTED);
    assert!(!reqs[4].allow_tools);
    assert!(e.store.dictionary(&main_key(e)).await.unwrap().0.is_empty());
}

#[tokio::test]
async fn learn_schema_writes_drafts_and_keeps_verified_notes() {
    let e = &sqlite(AiAccess::Data, DEV, false).await;
    let key = main_key(e);
    e.store.put_note(&key, &dnote("orders", "status", "verified meaning", NoteStatus::Verified), false).await.unwrap();
    let reply = |v: Value| text(&format!("```json\n{v}\n```"));
    // Tables come in name order: customers, items, orders.
    let fake = Fake::new(vec![
        reply(json!({"table": {"note": "People who order"}, "columns": [
            {"column": "name", "note": "Display name", "evidence": "sample", "unsure": false},
            {"column": "ghost", "note": "not a column"}
        ]})),
        text("Sorry, I can't."),
        reply(json!({"table": null, "columns": [
            {"column": "status", "note": "should not replace"},
            {"column": "customer_id", "note": "Who placed it", "unsure": true}
        ], "terms": [{"term": "Open order", "meaning": "Not paid yet", "mapsTo": "orders.status = 'open'"}]})),
    ]);
    let stop = std::sync::atomic::AtomicBool::new(false);
    let learner = Learner {
        chat: &fake,
        model: "fake",
        mgr: &e.mgr,
        pool: &e.pool,
        conn: &e.conn,
        store: &e.store,
        key: key.clone(),
        samples: true,
        language: "id",
        stop: &stop,
    };
    let mut seen = vec![];
    let r = learner.run(&[], |p| seen.push((p.done, p.current.to_string()))).await.unwrap();
    assert_eq!(seen, [(0, "customers".into()), (1, "items".into()), (2, "orders".into()), (3, String::new())]);
    assert_eq!(r.drafts, 4);
    assert_eq!(r.failed.len(), 1);
    assert!(r.failed[0].starts_with("items:"), "{:?}", r.failed);
    let reqs = fake.reqs();
    assert!(reqs[0].system.contains("in Indonesian") && reqs[0].tools.is_empty());
    let user = |i: usize| match &reqs[i].items[0] {
        ChatItem::User { text, .. } => text.clone(),
        other => panic!("{other:?}"),
    };
    assert!(user(0).contains("Sample rows:") && user(0).contains("- name: a (1), b (1)"), "{}", user(0));
    let orders = user(2);
    assert!(orders.contains("customer_id integer FK -> customers.id"), "{orders}");
    assert!(orders.contains("Existing notes") && orders.contains("  status: verified meaning"), "{orders}");
    assert!(!orders.contains("- status:"), "a column with a note gets no distinct values: {orders}");
    let (notes, terms) = e.store.dictionary(&key).await.unwrap();
    let got: Vec<(&str, &str, &str, NoteStatus, bool)> =
        notes.iter().map(|n| (n.table.as_str(), n.column.as_str(), n.note.as_str(), n.status, n.unsure)).collect();
    assert_eq!(
        got,
        [
            ("customers", "", "People who order", NoteStatus::Draft, false),
            ("customers", "name", "Display name", NoteStatus::Draft, false),
            ("orders", "customer_id", "Who placed it", NoteStatus::Draft, true),
            ("orders", "status", "verified meaning", NoteStatus::Verified, false),
        ]
    );
    assert_eq!((terms[0].term.as_str(), terms[0].maps_to.as_str(), terms[0].status), ("Open order", "orders.status = 'open'", NoteStatus::Draft));

    // Without samples no rows are read; a set stop flag ends the run before the first table.
    let fake = Fake::new(vec![reply(json!({}))]);
    let learner = Learner { chat: &fake, samples: false, ..learner };
    learner.run(&["customers".into()], |_| {}).await.unwrap();
    assert!(match &fake.reqs()[0].items[0] { ChatItem::User { text, .. } => !text.contains("Sample rows"), _ => false });
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let r = learner.run(&[], |_| {}).await.unwrap();
    assert!(r.stopped && r.drafts == 0);
}

// ---------- chat history edits ----------

const MISMATCH: &str = "anthropic returned HTTP 400: messages.1.content.0: Invalid `signature` in `thinking` block. \
The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to \"drop_block\".";

fn thought(text: &str) -> ChatItem {
    let content = json!([{"type": "thinking", "thinking": "", "signature": "sig"}, {"type": "text", "text": text}]);
    ChatItem::Assistant { text: text.into(), tool_calls: vec![], raw: Some(RawContent { provider: AiProvider::Anthropic, content }) }
}

fn has_thinking(items: &[ChatItem]) -> bool {
    serde_json::to_string(items).unwrap().contains("\"thinking\"")
}

fn user(id: Option<&str>, text: &str) -> ChatItem {
    ChatItem::User { text: text.into(), id: id.map(Into::into) }
}

#[tokio::test]
async fn stale_thinking_blocks_are_dropped_once_and_the_request_resent() {
    let e = &sqlite(AiAccess::Schema, DEV, false).await;
    let msgs = vec![AgentMessage::User { id: "m1".into(), text: "hi".into() }, AgentMessage::Agent { id: "a1".into(), text: "hello".into(), steps: vec![] }];
    e.store.save_chat(&e.conn.id, &[user(Some("m1"), "hi"), thought("hello")], &msgs).await.unwrap();
    let fake = Fake { script: Mutex::new(VecDeque::from(vec![Err(AppError::Query(MISMATCH.into())), Ok(text("fine"))])), ..Default::default() };
    let events = e.turn(&fake, "again", no_driver).await;
    let reqs = fake.reqs();
    assert_eq!(reqs.len(), 2);
    assert!(has_thinking(&reqs[0].items) && !has_thinking(&reqs[1].items));
    assert_eq!(agent_texts(&events).last().unwrap(), "fine");
    assert!(!events.iter().any(|ev| matches!(ev.kind, AgentEventKind::Error { .. })));
    assert!(!has_thinking(&e.items().await));

    // A second mismatch is not retried again.
    e.store.save_chat(&e.conn.id, &[user(None, "hi"), thought("hello")], &msgs).await.unwrap();
    let fake = Fake { script: Mutex::new(VecDeque::from(vec![Err(AppError::Query(MISMATCH.into())), Err(AppError::Query(MISMATCH.into()))])), ..Default::default() };
    let events = e.turn(&fake, "once more", no_driver).await;
    assert_eq!(fake.reqs().len(), 2);
    assert!(events.iter().any(|ev| matches!(&ev.kind, AgentEventKind::Error { message } if message.contains("different conversation"))));
}

#[test]
fn deleting_an_exchange_removes_its_answer_from_both_histories() {
    let u = |id: &str, text: &str| AgentMessage::User { id: id.into(), text: text.into() };
    let a = |id: &str| AgentMessage::Agent { id: id.into(), text: "x".into(), steps: vec![] };
    let mut messages = vec![u("m1", "q1"), a("a1"), u("m2", "q2"), a("a2"), u("m3", "q3")];
    let results = ChatItem::ToolResults { results: vec![ToolResult { call_id: "c".into(), content: "r".into(), is_error: false }] };
    let mut items = vec![user(Some("m1"), "q1"), thought("t1"), user(Some("m2"), "q2"), thought("t2"), results, user(Some("m3"), "q3"), thought("t3")];
    assert!(agent::delete_exchange(&mut items, &mut messages, "m2"));
    let ids: Vec<String> = messages.iter().map(|m| serde_json::to_value(m).unwrap()["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids, ["m1", "a1", "m3"]);
    assert_eq!(items.len(), 4);
    assert!(matches!(&items[2], ChatItem::User { text, .. } if text == "q3"));
    assert!(!has_thinking(&items), "an edit in the middle invalidates every thinking block");
    assert!(!agent::delete_exchange(&mut items, &mut messages, "a1"), "only user messages start an exchange");

    // Chats saved before user items had ids: the same occurrence of the text, counted from the end.
    let mut messages = vec![u("m1", "same"), a("a1"), u("m2", "same"), a("a2")];
    let mut items = vec![user(None, "same"), thought("first"), user(None, "same"), thought("second")];
    assert!(agent::delete_exchange(&mut items, &mut messages, "m1"));
    assert_eq!(items.len(), 2);
    assert!(matches!(&items[1], ChatItem::Assistant { text, .. } if text == "second"));
}
