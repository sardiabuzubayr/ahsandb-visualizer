//! Tauri commands: thin wrappers that resolve state and delegate to modules.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager as _, State};

use crate::db::{self, preview};
use crate::ddl;
use crate::kv;
use crate::objects::{databases, roles, routines, triggers, views};
use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::secrets::{self, SecretKind};
use crate::ssh::{self, SshSecrets};
use crate::AppState;

#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<Connection>> {
    state.store.list().await
}

#[tauri::command]
pub async fn save_connection(state: State<'_, AppState>, connection: Connection, secrets: Secrets) -> AppResult<Connection> {
    let saved = state.store.save(connection).await?;
    secrets::apply(state.secrets.as_ref(), &saved.id, &secrets)?;
    Ok(saved)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    drop_connection(&state, &id).await;
    state.store.delete(&id).await?;
    secrets::delete_all(state.secrets.as_ref(), &id)
}

/// Tests unsaved settings. Uses the given secrets when present, otherwise the stored ones.
#[tauri::command]
pub async fn test_connection(state: State<'_, AppState>, connection: Connection, secrets: Secrets) -> AppResult<TestResult> {
    let stored = |kind| -> AppResult<Option<String>> {
        if connection.id.is_empty() { Ok(None) } else { state.secrets.get(&connection.id, kind) }
    };
    let password = match secrets.password { Some(p) => Some(p), None => stored(SecretKind::Password)? };
    let ssh = SshSecrets {
        password: match secrets.ssh_password { Some(p) => Some(p), None => stored(SecretKind::SshPassword)? },
        passphrase: match secrets.ssh_passphrase { Some(p) => Some(p), None => stored(SecretKind::SshPassphrase)? },
    };
    let started = Instant::now();
    let (opened, server_version, tunnel) = open(&state, &connection, password.as_deref(), &ssh, None).await?;
    if let Opened::Sql(pool) = &opened {
        close(pool).await;
    }
    if let Some(t) = tunnel {
        t.close().await;
    }
    Ok(TestResult { server_version, elapsed_ms: started.elapsed().as_millis() as u64 })
}

/// "Test SSH" in the connection dialog: only the tunnel part (like DBeaver's "Test tunnel"),
/// with the dialog's unsaved settings and secrets (falling back to the stored ones).
#[tauri::command]
pub async fn test_ssh(state: State<'_, AppState>, connection: Connection, secrets: Secrets) -> AppResult<SshTestResult> {
    let cfg = connection.ssh.clone().ok_or_else(|| AppError::Query("SSH tunnel is not enabled".into()))?;
    let stored = |kind| -> AppResult<Option<String>> {
        if connection.id.is_empty() { Ok(None) } else { state.secrets.get(&connection.id, kind) }
    };
    let ssh_secrets = SshSecrets {
        password: match secrets.ssh_password { Some(p) => Some(p), None => stored(SecretKind::SshPassword)? },
        passphrase: match secrets.ssh_passphrase { Some(p) => Some(p), None => stored(SecretKind::SshPassphrase)? },
    };
    let trusted = state.store.trusted_host_key(&cfg.host, cfg.port).await?;
    let dial = ssh::Dial {
        cfg,
        secrets: ssh_secrets,
        known_hosts: Some(ssh::expand_tilde("~/.ssh/known_hosts")),
        trusted,
        agent_sock: None,
    };
    let target_host = connection.host.clone().filter(|h| !h.is_empty()).unwrap_or_else(|| "127.0.0.1".into());
    let target_port = connection.port.unwrap_or(connection.driver.default_port());
    ssh::test_ssh(&dial, &target_host, target_port).await
}

#[tauri::command]
pub async fn connect(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<ConnectInfo> {
    let conn = state.store.get(conn_id(&id)).await?;
    let password = state.secrets.get(&id, SecretKind::Password)?;
    let ssh = SshSecrets {
        password: state.secrets.get(&id, SecretKind::SshPassword)?,
        passphrase: state.secrets.get(&id, SecretKind::SshPassphrase)?,
    };
    let (opened, server_version, tunnel) = open(&state, &conn, password.as_deref(), &ssh, Some(&app)).await?;
    drop_connection(&state, &id).await;
    match opened {
        Opened::Sql(pool) => drop(state.db.pools.lock().await.insert(id.clone(), Arc::new(pool))),
        Opened::Kv(c) => drop(state.db.kv.lock().await.insert(id.clone(), c)),
    }
    if let Some(t) = tunnel {
        state.db.tunnels.lock().await.insert(id, t);
    }
    Ok(ConnectInfo { server_version })
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    drop_connection(&state, &id).await;
    Ok(())
}

/// Trusts an SSH host key the user confirmed (after a `hostKeyUnknown` error).
#[tauri::command]
pub async fn trust_host_key(state: State<'_, AppState>, host_key: HostKeyInfo) -> AppResult<()> {
    state.store.trust_host_key(&host_key).await
}

/// Forgets the trusted key for `host:port` so the next connect asks again (used after a key change).
#[tauri::command]
pub async fn forget_host_key(state: State<'_, AppState>, host: String, port: u16) -> AppResult<()> {
    state.store.forget_host_key(&host, port).await
}

#[tauri::command]
pub async fn schema_tree(state: State<'_, AppState>, id: String) -> AppResult<Vec<SchemaNode>> {
    let conn = state.store.get(conn_id(&id)).await?;
    if conn.driver == Driver::Redis {
        return kv::keyspaces(&mut kv_conn(&state, &id).await?, conn_id(&id), kv::base_db(&conn)?).await;
    }
    let pool = pool(&state, &id).await?;
    if id.contains('@') {
        // Expanding one database of a multi-database connection.
        return Ok(vec![db::meta::database_tree(&pool, &conn).await?]);
    }
    db::meta::schema_tree(&pool, &conn).await
}

#[tauri::command]
pub async fn table_columns(state: State<'_, AppState>, id: String, schema: String, table: String) -> AppResult<Vec<Column>> {
    db::meta::table_columns(&*pool(&state, &id).await?, &schema, &table).await
}

#[tauri::command]
pub async fn er_model(state: State<'_, AppState>, id: String, schema: String) -> AppResult<ErModel> {
    db::meta::er_model(&*pool(&state, &id).await?, &schema).await
}

#[tauri::command]
pub async fn completion_schema(state: State<'_, AppState>, id: String) -> AppResult<HashMap<String, Vec<String>>> {
    let conn = state.store.get(conn_id(&id)).await?;
    db::meta::completion_schema(&*pool(&state, &id).await?, &conn).await
}

#[tauri::command]
pub async fn execute(
    state: State<'_, AppState>,
    id: String,
    sql: String,
    run_id: String,
    confirmed: bool,
    max_rows: u32,
) -> AppResult<Vec<StatementResult>> {
    // Scoped id so cancel finds the pool the query runs on.
    let conn = Connection { id: id.clone(), ..state.store.get(conn_id(&id)).await? };
    let pool = pool(&state, &id).await?;
    let result = db::exec::execute(&state.db, &pool, &conn, &sql, confirmed, max_rows, &run_id).await;
    // History records what actually ran; blocked scripts (confirmation, read-only) never ran.
    if !matches!(result, Err(AppError::NeedsConfirmation(_)) | Err(AppError::ReadOnly(_))) {
        let ok = matches!(&result, Ok(r) if r.iter().all(|s| s.error.is_none()));
        state.store.add_history(conn_id(&id), sql.trim(), ok).await?;
    }
    result
}

/// "Load more" on a result: runs the same statement again with a larger row limit. Only a single
/// read statement is allowed, so re-running can never repeat a write. Not added to history.
#[tauri::command]
pub async fn fetch_more(state: State<'_, AppState>, id: String, sql: String, run_id: String, max_rows: u32) -> AppResult<StatementResult> {
    let conn = Connection { id: id.clone(), ..state.store.get(conn_id(&id)).await? };
    let stmts = crate::sql::split::split(&sql, conn.driver);
    let [stmt] = stmts.as_slice() else {
        return Err(AppError::Query("Only a single read query can load more rows".into()));
    };
    if crate::sql::classify::classify(stmt) != crate::sql::classify::StatementClass::Read {
        return Err(AppError::Query("Only read queries can load more rows".into()));
    }
    let pool = pool(&state, &id).await?;
    let mut results = db::exec::execute(&state.db, &pool, &conn, stmt, false, max_rows, &run_id).await?;
    results.pop().ok_or_else(|| AppError::Query("The query returned no result".into()))
}

#[tauri::command]
pub async fn cancel(state: State<'_, AppState>, run_id: String) -> AppResult<()> {
    db::exec::cancel(&state.db, &run_id).await
}

#[allow(clippy::too_many_arguments)] // Tauri command args map 1:1 to the IPC payload
#[tauri::command]
pub async fn table_page(
    state: State<'_, AppState>,
    id: String,
    schema: String,
    table: String,
    order_by: Option<OrderBy>,
    filter: Option<String>,
    offset: u64,
    limit: u32,
) -> AppResult<TablePage> {
    db::page::table_page(&*pool(&state, &id).await?, &schema, &table, order_by, filter.as_deref(), offset, limit).await
}

#[tauri::command]
pub async fn history(state: State<'_, AppState>, id: String, limit: u32) -> AppResult<Vec<HistoryEntry>> {
    state.store.history(&id, limit).await
}

/// Creates an empty SQLite database file (the dialog's "New…" button). Errors if it already exists.
#[tauri::command]
pub async fn create_sqlite_file(path: String) -> AppResult<()> {
    db::create_sqlite_file(&path).await
}

// ---------- structure, data edits, routines, roles ----------

/// Previews are only generated for connections that may change: open, and not read-only.
async fn writable(state: &AppState, id: &str) -> AppResult<(Connection, Arc<db::Pool>)> {
    let conn = state.store.get(conn_id(id)).await?;
    if conn.read_only {
        return Err(AppError::ReadOnly(vec![]));
    }
    Ok((conn, pool(state, id).await?))
}

#[tauri::command]
pub async fn load_table(state: State<'_, AppState>, id: String, schema: String, table: String) -> AppResult<TableDef> {
    ddl::load_table(&*pool(&state, &id).await?, &schema, &table).await
}

#[tauri::command]
pub async fn preview_schema_changes(state: State<'_, AppState>, id: String, changes: Vec<TableChange>) -> AppResult<Preview> {
    let (conn, _) = writable(&state, &id).await?;
    preview::store(&state.db, &id, ddl::plan_schema_changes(conn.driver, &changes)?).await
}

#[tauri::command]
pub async fn preview_row_changes(
    state: State<'_, AppState>,
    id: String,
    schema: String,
    table: String,
    changes: Vec<RowChange>,
) -> AppResult<Preview> {
    let (conn, _) = writable(&state, &id).await?;
    preview::store(&state.db, &id, ddl::plan_row_changes(conn.driver, &schema, &table, &changes)?).await
}

#[tauri::command]
pub async fn preview_drop(state: State<'_, AppState>, id: String, kind: ObjectKind, schema: String, name: String) -> AppResult<Preview> {
    let (conn, pool) = writable(&state, &id).await?;
    let plan = if kind == ObjectKind::Trigger {
        // PG needs the trigger's table (DROP TRIGGER … ON table).
        let trigger = triggers::load_trigger(&pool, &schema, &name).await?;
        triggers::plan_trigger(conn.driver, Some(&trigger), None)?
    } else {
        ddl::plan_drop(conn.driver, kind, &schema, &name)?
    };
    preview::store(&state.db, &id, plan).await
}

#[tauri::command]
pub async fn load_routine(state: State<'_, AppState>, id: String, schema: String, name: String, kind: String) -> AppResult<Routine> {
    let conn = state.store.get(conn_id(&id)).await?;
    routines::load_routine(&*pool(&state, &id).await?, &conn, &schema, &name, &kind).await
}

#[tauri::command]
pub async fn preview_routine(state: State<'_, AppState>, id: String, original: Option<Routine>, routine: Routine) -> AppResult<Preview> {
    let (conn, _) = writable(&state, &id).await?;
    preview::store(&state.db, &id, routines::plan_routine(conn.driver, original.as_ref(), &routine)?).await
}

/// Runs a routine through the normal execute path (so production confirmation and history apply).
#[tauri::command]
pub async fn run_routine(
    state: State<'_, AppState>,
    id: String,
    routine: Routine,
    args: Vec<Cell>,
    run_id: String,
    confirmed: bool,
) -> AppResult<Vec<StatementResult>> {
    let conn = state.store.get(conn_id(&id)).await?;
    let sql = routines::call_sql(conn.driver, &routine, &args)?;
    execute(state, id, sql, run_id, confirmed, 1000).await
}

#[tauri::command]
pub async fn load_roles(state: State<'_, AppState>, id: String) -> AppResult<Vec<Role>> {
    let conn = state.store.get(conn_id(&id)).await?;
    roles::load_roles(&*pool(&state, &id).await?, &conn).await
}

#[tauri::command]
pub async fn load_privileges(state: State<'_, AppState>, id: String, role: String, schema: String) -> AppResult<Vec<PrivilegeRow>> {
    let conn = state.store.get(conn_id(&id)).await?;
    roles::load_privileges(&*pool(&state, &id).await?, &conn, &role, &schema).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn preview_role(
    state: State<'_, AppState>,
    id: String,
    original: Option<Role>,
    target: Option<Role>,
    password: Option<String>,
    schema: String,
    privileges_original: Vec<PrivilegeRow>,
    privileges_target: Vec<PrivilegeRow>,
) -> AppResult<Preview> {
    let (conn, _) = writable(&state, &id).await?;
    let plan = roles::plan_role(
        conn.driver,
        original.as_ref(),
        target.as_ref(),
        password.as_deref(),
        &schema,
        &privileges_original,
        &privileges_target,
    )?;
    preview::store(&state.db, &id, plan).await
}

// ---------- triggers, views, sequence/event DDL ----------

#[tauri::command]
pub async fn load_trigger(state: State<'_, AppState>, id: String, schema: String, name: String) -> AppResult<Trigger> {
    triggers::load_trigger(&*pool(&state, &id).await?, &schema, &name).await
}

#[tauri::command]
pub async fn preview_trigger(
    state: State<'_, AppState>,
    id: String,
    original: Option<Trigger>,
    target: Option<Trigger>,
) -> AppResult<Preview> {
    let (conn, _) = writable(&state, &id).await?;
    preview::store(&state.db, &id, triggers::plan_trigger(conn.driver, original.as_ref(), target.as_ref())?).await
}

#[tauri::command]
pub async fn load_view(state: State<'_, AppState>, id: String, schema: String, name: String) -> AppResult<ViewDef> {
    views::load_view(&*pool(&state, &id).await?, &schema, &name).await
}

#[tauri::command]
pub async fn preview_view(state: State<'_, AppState>, id: String, original: Option<ViewDef>, view: ViewDef) -> AppResult<Preview> {
    let (conn, _) = writable(&state, &id).await?;
    preview::store(&state.db, &id, views::plan_view(conn.driver, original.as_ref(), &view)?).await
}

/// DDL text of a sequence (PG) or event (MySQL/MariaDB), opened in a SQL editor for viewing/editing.
#[tauri::command]
pub async fn object_ddl(state: State<'_, AppState>, id: String, kind: ObjectKind, schema: String, name: String) -> AppResult<String> {
    views::object_ddl(&*pool(&state, &id).await?, kind, &schema, &name).await
}

// ---------- Databases: create / rename / drop (run on the main pool: call with the bare id) ----------

#[tauri::command]
pub async fn preview_create_database(state: State<'_, AppState>, id: String, database: DatabaseDef) -> AppResult<Preview> {
    let (conn, _) = writable(&state, &id).await?;
    preview::store(&state.db, &id, databases::plan_create_database(conn.driver, &database)?).await
}

#[tauri::command]
pub async fn preview_rename_database(state: State<'_, AppState>, id: String, from: String, to: String) -> AppResult<Preview> {
    let (conn, _) = writable(&state, &id).await?;
    let plan = databases::plan_rename_database(conn.driver, conn.base_database().as_deref(), &from, &to)?;
    // Our own idle sessions on that database would block the rename.
    close_scoped(&state, &id, &from).await;
    preview::store(&state.db, &id, plan).await
}

#[tauri::command]
pub async fn preview_drop_database(state: State<'_, AppState>, id: String, name: String) -> AppResult<Preview> {
    let (conn, _) = writable(&state, &id).await?;
    let plan = databases::plan_drop_database(conn.driver, conn.base_database().as_deref(), &name)?;
    close_scoped(&state, &id, &name).await;
    preview::store(&state.db, &id, plan).await
}

/// Closes this app's pool on `<id>@<database>`, if one is open.
async fn close_scoped(state: &AppState, id: &str, database: &str) {
    let pool = state.db.pools.lock().await.remove(&format!("{}@{database}", conn_id(id)));
    if let Some(p) = pool {
        close(&p).await;
    }
}

// ---------- import / export (background jobs) ----------

/// Starts `work` in the background and returns its job id at once. Progress goes out as
/// `job-progress` events and the result as one `job-done` event.
async fn spawn_job<F, Fut>(app: AppHandle, state: &AppState, work: F) -> String
where
    F: FnOnce(crate::transfer::JobCtx) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = JobDone> + Send + 'static,
{
    let id = uuid::Uuid::new_v4().to_string();
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state.db.jobs.lock().await.insert(id.clone(), cancel.clone());
    let emitter = app.clone();
    let ctx = crate::transfer::JobCtx::new(id.clone(), cancel, Box::new(move |p| {
        let _ = emitter.emit("job-progress", p);
    }));
    let job_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let done = work(ctx).await;
        let state = app.state::<AppState>();
        state.db.jobs.lock().await.remove(&job_id);
        let _ = app.emit("job-done", done);
    });
    id
}

#[tauri::command]
pub async fn export_database(app: AppHandle, state: State<'_, AppState>, id: String, mut options: ExportDatabaseOptions) -> AppResult<String> {
    options.path = home_path(&options.path);
    let conn = state.store.get(conn_id(&id)).await?;
    let pool = pool(&state, &id).await?;
    Ok(spawn_job(app, &state, move |ctx| async move { crate::transfer::export::export_database(&pool, &conn, &options, &ctx).await }).await)
}

#[tauri::command]
pub async fn export_data(app: AppHandle, state: State<'_, AppState>, id: String, mut options: ExportDataOptions) -> AppResult<String> {
    options.path = home_path(&options.path);
    let conn = state.store.get(conn_id(&id)).await?;
    let pool = pool(&state, &id).await?;
    Ok(spawn_job(app, &state, move |ctx| async move { crate::transfer::export::export_data(&pool, &conn, &options, &ctx).await }).await)
}

/// Typed paths may start with `~/` (dialog defaults); file pickers give absolute paths.
fn home_path(path: &str) -> String {
    ssh::expand_tilde(path.trim()).to_string_lossy().into_owned()
}

/// Read-only connections are refused; production needs `confirmed` (the user confirmed in the dialog).
async fn importable(state: &AppState, id: &str, confirmed: bool) -> AppResult<(Connection, Arc<db::Pool>)> {
    let (conn, pool) = writable(state, id).await?;
    if conn.env == Env::Prod && !confirmed {
        return Err(AppError::NeedsConfirmation(vec![]));
    }
    Ok((conn, pool))
}

#[tauri::command]
pub async fn import_sql(app: AppHandle, state: State<'_, AppState>, id: String, mut options: ImportSqlOptions, confirmed: bool) -> AppResult<String> {
    options.path = home_path(&options.path);
    let (conn, pool) = importable(&state, &id, confirmed).await?;
    Ok(spawn_job(app, &state, move |ctx| async move { crate::transfer::import::import_sql(&pool, &conn, &options, &ctx).await }).await)
}

#[tauri::command]
pub async fn inspect_import_file(state: State<'_, AppState>, id: String, mut file: FileOptions) -> AppResult<FilePreview> {
    file.path = home_path(&file.path);
    let conn = state.store.get(conn_id(&id)).await?;
    crate::transfer::import::inspect_file(&conn, &file).await
}

#[tauri::command]
pub async fn import_data(app: AppHandle, state: State<'_, AppState>, id: String, mut options: ImportDataOptions, confirmed: bool) -> AppResult<String> {
    options.file.path = home_path(&options.file.path);
    let (conn, pool) = importable(&state, &id, confirmed).await?;
    Ok(spawn_job(app, &state, move |ctx| async move { crate::transfer::import::import_data(&pool, &conn, &options, &ctx).await }).await)
}

/// Asks a running job to stop; it finishes with `cancelled: true`. Unknown ids are ignored.
#[tauri::command]
pub async fn cancel_job(state: State<'_, AppState>, job_id: String) -> AppResult<()> {
    if let Some(flag) = state.db.jobs.lock().await.get(&job_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

// ---------- AI agent ----------

/// Providers that have a saved API key.
#[tauri::command]
pub async fn ai_key_status(state: State<'_, AppState>) -> AppResult<Vec<AiProvider>> {
    let flags = match state.store.ai_key_flags().await? {
        Some(flags) => flags,
        None => {
            // One-time: keys saved before the flags existed are looked up in the secret store once.
            let mut flags = vec![];
            for p in AiProvider::ALL {
                let saved = state.secrets.get(&secrets::ai_account(p), SecretKind::AiKey).ok().flatten().is_some();
                state.store.set_ai_key_flag(p.as_str(), saved).await?;
                flags.push((p.as_str().to_string(), saved));
            }
            flags
        }
    };
    Ok(AiProvider::ALL.into_iter().filter(|p| flags.iter().any(|(id, saved)| *saved && id == p.as_str())).collect())
}

/// Saves (or, with "", deletes) a provider's API key in the secret store.
#[tauri::command]
pub async fn ai_set_key(state: State<'_, AppState>, provider: AiProvider, key: String) -> AppResult<()> {
    let account = secrets::ai_account(provider);
    match key.trim() {
        "" => state.secrets.delete(&account, SecretKind::AiKey)?,
        k => state.secrets.set(&account, SecretKind::AiKey, k)?,
    }
    state.store.set_ai_key_flag(provider.as_str(), !key.trim().is_empty()).await
}

/// Lists tool-capable models; `key` = test an unsaved key, `None` = the stored one.
#[tauri::command]
pub async fn ai_list_models(state: State<'_, AppState>, provider: AiProvider, key: Option<String>) -> AppResult<Vec<AiModel>> {
    let key = match key.filter(|k| !k.trim().is_empty()) {
        Some(k) => k.trim().to_string(),
        None => state
            .secrets
            .get(&secrets::ai_account(provider), SecretKind::AiKey)?
            .ok_or_else(|| AppError::Auth(format!("No API key saved for {}", provider.as_str())))?,
    };
    crate::ai::list_models(provider, &key).await
}

#[tauri::command]
pub async fn agent_send(app: AppHandle, state: State<'_, AppState>, id: String, provider: AiProvider, model: String, text: String) -> AppResult<()> {
    crate::ai::agent::send(app, &state, &id, provider, &model, &text).await
}

#[tauri::command]
pub async fn agent_decide(state: State<'_, AppState>, action_id: String, decision: AgentDecision) -> AppResult<()> {
    crate::ai::agent::decide(&state, &action_id, decision).await
}

#[tauri::command]
pub async fn agent_stop(state: State<'_, AppState>, id: String) -> AppResult<()> {
    crate::ai::agent::stop(&state, conn_id(&id)).await
}

#[tauri::command]
pub async fn agent_history(state: State<'_, AppState>, id: String) -> AppResult<Vec<AgentMessage>> {
    crate::ai::agent::history(&state, conn_id(&id)).await
}

/// Deletes a user message and the agent's answer to it.
#[tauri::command]
pub async fn agent_delete_message(state: State<'_, AppState>, id: String, message_id: String) -> AppResult<()> {
    crate::ai::agent::delete_message(&state, conn_id(&id), &message_id).await
}

#[tauri::command]
pub async fn agent_clear(state: State<'_, AppState>, id: String) -> AppResult<()> {
    crate::ai::agent::clear(&state, conn_id(&id)).await
}

#[tauri::command]
pub async fn agent_audit(state: State<'_, AppState>, id: String, limit: u32) -> AppResult<Vec<AuditEntry>> {
    crate::ai::agent::audit(&state, conn_id(&id), limit).await
}

// ---------- SQL files (Open / Save in the SQL editor; paths come from the OS file dialogs) ----------

/// Largest SQL file the editor opens (bigger dumps go through Import SQL).
const MAX_SQL_FILE: u64 = 20 * 1024 * 1024;

#[tauri::command]
pub async fn read_text_file(path: String) -> AppResult<String> {
    let path = home_path(&path);
    let meta = tokio::fs::metadata(&path).await.map_err(|e| AppError::Io(format!("{path}: {e}")))?;
    if meta.len() > MAX_SQL_FILE {
        return Err(AppError::Io(format!("{path} is larger than 20 MB; use Import SQL to run big scripts")));
    }
    let bytes = tokio::fs::read(&path).await.map_err(|e| AppError::Io(format!("{path}: {e}")))?;
    String::from_utf8(bytes).map_err(|_| AppError::Io(format!("{path} is not UTF-8 text")))
}

/// Writes through a temp file + rename so a failed save never leaves a half-written file.
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> AppResult<()> {
    let path = home_path(&path);
    let tmp = format!("{path}.ahsandb-tmp");
    let io = |e: std::io::Error| AppError::Io(format!("{path}: {e}"));
    tokio::fs::write(&tmp, contents).await.map_err(io)?;
    tokio::fs::rename(&tmp, &path).await.map_err(io)
}

/// Writes a binary file (e.g. an ER diagram PNG) sent as base64, through a temp file + rename.
#[tauri::command]
pub async fn write_base64_file(path: String, data: String) -> AppResult<()> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| AppError::Query(format!("Invalid file data: {e}")))?;
    let path = home_path(&path);
    let tmp = format!("{path}.ahsandb-tmp");
    let io = |e: std::io::Error| AppError::Io(format!("{path}: {e}"));
    tokio::fs::write(&tmp, bytes).await.map_err(io)?;
    tokio::fs::rename(&tmp, &path).await.map_err(io)
}

/// Applies a reviewed preview. History records the displayed statements (secrets stay masked).
#[tauri::command]
pub async fn apply_preview(state: State<'_, AppState>, id: String, preview_id: String, confirmed: bool) -> AppResult<ApplyReport> {
    let (conn, pool) = writable(&state, &id).await?;
    let shown = state.db.previews.lock().await.get(&preview_id).map(|p| {
        p.plan.statements.iter().map(|s| s.display.as_str()).collect::<Vec<_>>().join(";\n")
    });
    // Previews are stored under the scoped id: one made for database A never runs on database B.
    let conn = Connection { id: id.clone(), ..conn };
    let report = preview::apply(&state.db, &pool, &conn, &preview_id, confirmed).await;
    if let (Some(sql), Ok(r)) = (&shown, &report) {
        state.store.add_history(conn_id(&id), sql, r.failed.is_none()).await?;
    }
    report
}

/// IPC ids are a connection id, optionally scoped to one database of a multi-database connection:
/// `<connId>@<database>` (connection ids are UUIDs, so the first `@` splits them).
pub(crate) fn conn_id(id: &str) -> &str {
    id.split_once('@').map_or(id, |(c, _)| c)
}

/// Pool for an IPC id. A scoped id reuses the main pool for the connection's base database and
/// otherwise opens (once) a pool on that database, through the connection's SSH tunnel if it has one.
/// The connection itself must be open (`NotFound("Not connected")` otherwise).
pub(crate) async fn pool(state: &AppState, id: &str) -> AppResult<Arc<db::Pool>> {
    let base = state.db.pool(conn_id(id)).await?;
    let Some((cid, database)) = id.split_once('@') else { return Ok(base) };
    if let Some(p) = state.db.pools.lock().await.get(id) {
        return Ok(p.clone());
    }
    let conn = state.store.get(cid).await?;
    if conn.driver == Driver::Sqlite || conn.base_database().as_deref() == Some(database) {
        return Ok(base);
    }
    let password = state.secrets.get(cid, SecretKind::Password)?;
    let tunnel_port = state.db.tunnels.lock().await.get(cid).map(|t| t.local_port);
    let scoped = Connection { database: Some(database.to_string()), ..conn };
    let (p, _) = db::connect(&scoped, password.as_deref(), tunnel_port).await?;
    let p = Arc::new(p);
    // shortcut: two concurrent first uses may both open a pool; the later insert wins and the other is dropped.
    state.db.pools.lock().await.insert(id.to_string(), p.clone());
    Ok(p)
}

/// Redis connection for an IPC id; a scoped id (`<connId>@<db>`) opens (once) a connection on that
/// database, through the connection's SSH tunnel if it has one.
pub(crate) async fn kv_conn(state: &AppState, id: &str) -> AppResult<kv::Conn> {
    let base = {
        let map = state.db.kv.lock().await;
        if let Some(c) = map.get(id) {
            return Ok(c.clone());
        }
        map.get(conn_id(id)).cloned().ok_or_else(|| AppError::NotFound("Not connected".into()))?
    };
    let Some((cid, db)) = id.split_once('@') else { return Ok(base) };
    let conn = state.store.get(cid).await?;
    let db = kv::parse_db(db)?;
    if db == kv::base_db(&conn)? {
        return Ok(base);
    }
    let password = state.secrets.get(cid, SecretKind::Password)?;
    let tunnel_port = state.db.tunnels.lock().await.get(cid).map(|t| t.local_port);
    let (c, _) = kv::connect(&conn, password.as_deref(), tunnel_port, db).await?;
    // shortcut: two concurrent first uses may both connect; the later insert wins and the other is dropped.
    state.db.kv.lock().await.insert(id.to_string(), c.clone());
    Ok(c)
}

/// What `open` connected: a SQL pool or a Redis connection.
enum Opened {
    Sql(db::Pool),
    Kv(kv::Conn),
}

/// Opens the SSH tunnel (when configured) and the pool through it. `app` = emit `connection-lost`
/// when the tunnel drops; `None` for one-off tests.
async fn open(
    state: &AppState,
    conn: &Connection,
    password: Option<&str>,
    ssh_secrets: &SshSecrets,
    app: Option<&AppHandle>,
) -> AppResult<(Opened, String, Option<ssh::Tunnel>)> {
    // SQLite is a local file: SSH settings, if any, don't apply.
    let tunnel = match conn.ssh.as_ref().filter(|_| conn.driver != Driver::Sqlite) {
        None => None,
        Some(cfg) => {
            let target_host = conn.host.clone().filter(|h| !h.is_empty()).unwrap_or_else(|| "127.0.0.1".into());
            let target_port = conn.port.unwrap_or(conn.driver.default_port());
            let trusted = state.store.trusted_host_key(&cfg.host, cfg.port).await?;
            let known_hosts = ssh::expand_tilde("~/.ssh/known_hosts");
            let (id, app) = (conn.id.clone(), app.cloned());
            let on_lost: Box<dyn FnOnce(String) + Send> = Box::new(move |message| {
                if let Some(app) = app {
                    let _ = app.emit("connection-lost", ConnectionLost { id, message });
                }
            });
            let t = ssh::open_tunnel(cfg, ssh_secrets, &target_host, target_port, Some(&known_hosts), trusted.as_deref(), on_lost).await?;
            Some(t)
        }
    };
    let port = tunnel.as_ref().map(|t| t.local_port);
    let opened = match conn.driver {
        Driver::Redis => match kv::base_db(conn) {
            Ok(db) => kv::connect(conn, password, port, db).await.map(|(c, v)| (Opened::Kv(c), v)),
            Err(e) => Err(e),
        },
        _ => db::connect(conn, password, port).await.map(|(p, v)| (Opened::Sql(p), v)),
    };
    match opened {
        Ok((opened, version)) => Ok((opened, version, tunnel)),
        Err(e) => {
            if let Some(t) = tunnel {
                t.close().await;
            }
            Err(e)
        }
    }
}

/// Closes the pool and tunnel of a connection, if open.
async fn drop_connection(state: &AppState, id: &str) {
    let pools: Vec<_> = {
        let mut map = state.db.pools.lock().await;
        let keys: Vec<String> = map.keys().filter(|k| conn_id(k) == id).cloned().collect();
        keys.iter().filter_map(|k| map.remove(k)).collect()
    };
    for pool in pools {
        close(&pool).await;
    }
    // Dropping the last clone of a multiplexed connection closes its socket.
    state.db.kv.lock().await.retain(|k, _| conn_id(k) != id);
    if let Some(t) = state.db.tunnels.lock().await.remove(id) {
        t.close().await;
    }
}

async fn close(pool: &db::Pool) {
    match pool {
        db::Pool::Pg(p) => p.close().await,
        db::Pool::My(p) => p.close().await,
        db::Pool::Lite(p) => p.close().await,
    }
}

// ---------- Redis ----------

/// Keys matching a glob pattern (optionally by type and with/without expiry), with type and TTL;
/// continue from the returned cursor ("0" = done).
#[tauri::command]
pub async fn kv_scan(
    state: State<'_, AppState>,
    id: String,
    cursor: String,
    pattern: String,
    type_filter: Option<String>,
    has_ttl: Option<bool>,
    count: u32,
) -> AppResult<KvScanPage> {
    kv::scan(&mut kv_conn(&state, &id).await?, &cursor, &pattern, type_filter.as_deref(), has_ttl, count.clamp(10, 1000)).await
}

#[tauri::command]
pub async fn kv_get(state: State<'_, AppState>, id: String, key: String) -> AppResult<KvEntry> {
    kv::entry(&mut kv_conn(&state, &id).await?, &key).await
}

/// A key browser change. Read-only connections refuse it; production needs `confirmed` (the error
/// carries the commands to show).
#[tauri::command]
pub async fn kv_edit(state: State<'_, AppState>, id: String, edit: KvEdit, confirmed: bool) -> AppResult<()> {
    let conn = state.store.get(conn_id(&id)).await?;
    let mut c = kv_conn(&state, &id).await?;
    let cmds = kv::plan_edit(&mut c, &edit).await?;
    if conn.read_only {
        return Err(AppError::ReadOnly(kv::plan_lines(&cmds)));
    }
    if conn.env == Env::Prod && !confirmed {
        return Err(AppError::NeedsConfirmation(kv::plan_lines(&cmds)));
    }
    kv::run_edit(&mut c, &cmds).await
}

/// One console line. Blocked commands → `Query`; writes on read-only → `ReadOnly`; writes on
/// production without `confirmed` → `NeedsConfirmation`. Recorded in the query history.
#[tauri::command]
pub async fn kv_command(state: State<'_, AppState>, id: String, line: String, confirmed: bool) -> AppResult<KvReply> {
    let conn = state.store.get(conn_id(&id)).await?;
    let args = kv::command::split_args(&line).map_err(AppError::Query)?;
    let class = kv::command::classify(&args);
    let writes = matches!(class, kv::command::CmdClass::Write | kv::command::CmdClass::Critical);
    if let kv::command::CmdClass::Blocked(why) = class {
        return Err(AppError::Query(why.into()));
    }
    if writes && conn.read_only {
        return Err(AppError::ReadOnly(vec![line]));
    }
    if writes && conn.env == Env::Prod && !confirmed {
        return Err(AppError::NeedsConfirmation(vec![line]));
    }
    let reply = kv::run_command(&mut kv_conn(&state, &id).await?, &args).await?;
    state.store.add_history(conn_id(&id), line.trim(), !reply.error).await?;
    Ok(reply)
}

#[tauri::command]
pub async fn kv_memory(state: State<'_, AppState>, id: String) -> AppResult<Option<u64>> {
    kv::server_memory(&mut kv_conn(&state, &id).await?).await
}

#[tauri::command]
pub async fn kv_info(state: State<'_, AppState>, id: String) -> AppResult<Vec<KvInfoSection>> {
    kv::info(&mut kv_conn(&state, &id).await?).await
}

// ---------- data dictionary ----------

/// Dictionary key of a schema on an IPC id (the database comes from its pool).
async fn dict_key(state: &AppState, id: &str, schema: &str) -> AppResult<(Arc<db::Pool>, crate::store::DictKey)> {
    let pool = pool(state, id).await?;
    let db = crate::dict::database_name(&pool, schema).await;
    Ok((pool, crate::store::DictKey { conn: conn_id(id).into(), db, schema: schema.into() }))
}

#[tauri::command]
pub async fn dict_get(state: State<'_, AppState>, id: String, schema: String) -> AppResult<Dictionary> {
    let (pool, key) = dict_key(&state, &id, &schema).await?;
    crate::dict::load(&state.store, &pool, &key).await
}

#[tauri::command]
pub async fn dict_put_note(state: State<'_, AppState>, id: String, schema: String, note: DictNote) -> AppResult<()> {
    if note.table.trim().is_empty() {
        return Err(AppError::Query("A note needs a table".into()));
    }
    let (_, key) = dict_key(&state, &id, &schema).await?;
    if note.note.trim().is_empty() {
        return state.store.delete_note(&key, &note.table, &note.column).await;
    }
    state.store.put_note(&key, &DictNote { note: note.note.trim().into(), ..note }, false).await.map(drop)
}

#[tauri::command]
pub async fn dict_delete_note(state: State<'_, AppState>, id: String, schema: String, table: String, column: String) -> AppResult<()> {
    let (_, key) = dict_key(&state, &id, &schema).await?;
    state.store.delete_note(&key, &table, &column).await
}

/// `previous` = the term's old name when it was renamed.
#[tauri::command]
pub async fn dict_put_term(state: State<'_, AppState>, id: String, schema: String, term: DictTerm, previous: Option<String>) -> AppResult<()> {
    let term = DictTerm { term: term.term.trim().into(), meaning: term.meaning.trim().into(), maps_to: term.maps_to.trim().into(), ..term };
    if term.term.is_empty() || term.meaning.is_empty() {
        return Err(AppError::Query("A term needs a name and a meaning".into()));
    }
    let (_, key) = dict_key(&state, &id, &schema).await?;
    let (_, terms) = state.store.dictionary(&key).await?;
    if previous.as_deref() != Some(term.term.as_str()) && terms.iter().any(|t| t.term == term.term) {
        return Err(AppError::Query(format!("The glossary already has \"{}\"", term.term)));
    }
    state.store.put_term(&key, &term, previous.as_deref(), false).await.map(drop)
}

#[tauri::command]
pub async fn dict_delete_term(state: State<'_, AppState>, id: String, schema: String, term: String) -> AppResult<()> {
    let (_, key) = dict_key(&state, &id, &schema).await?;
    state.store.delete_term(&key, &term).await
}

/// Approves or rejects the schema's drafts at once; `include_unsure` = also the unsure ones.
#[tauri::command]
pub async fn dict_resolve_drafts(state: State<'_, AppState>, id: String, schema: String, approve: bool, include_unsure: bool) -> AppResult<u64> {
    let (_, key) = dict_key(&state, &id, &schema).await?;
    state.store.resolve_drafts(&key, approve, include_unsure).await
}

/// Tables with notes on a connection (all databases), for the navigator.
#[tauri::command]
pub async fn dict_marks(state: State<'_, AppState>, id: String) -> AppResult<Vec<DictMark>> {
    state.store.dict_marks(conn_id(&id)).await
}

fn learn_slot(id: &str, schema: &str) -> String {
    format!("{id}\n{schema}")
}

/// Starts "Learn schema" in the background; progress arrives as `dict-learn` events. Errors before
/// it starts (no key, AI access off, samples without data access, already running) are returned here.
#[tauri::command]
pub async fn dict_learn(app: AppHandle, state: State<'_, AppState>, id: String, schema: String, options: LearnOptions) -> AppResult<()> {
    let conn = Connection { id: id.clone(), ..state.store.get(conn_id(&id)).await? };
    if conn.ai_access == AiAccess::Off {
        return Err(AppError::Query("AI access is off for this connection. Turn it on in the connection settings first.".into()));
    }
    if options.samples && !crate::dict::samples_allowed(&conn) {
        return Err(AppError::Query("Sample data needs AI data access on this connection".into()));
    }
    let key = state
        .secrets
        .get(&secrets::ai_account(options.provider), SecretKind::AiKey)?
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| AppError::Auth(format!("No API key saved for {}. Add one in Settings → AI.", options.provider.as_str())))?;
    let (pool, dict_key) = dict_key(&state, &id, &schema).await?;
    let slot = learn_slot(&id, &schema);
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut running = state.learning.lock().unwrap_or_else(|e| e.into_inner());
        if running.contains_key(&slot) {
            return Err(AppError::Query("Learn schema is already running for this schema".into()));
        }
        running.insert(slot.clone(), stop.clone());
    }
    // shortcut: one OS thread per run, like agent turns (sqlx futures aren't provably `Send` here).
    std::thread::spawn(move || tauri::async_runtime::block_on(async move {
        let state = app.state::<AppState>();
        let chat = crate::ai::client(options.provider, key);
        let learner = crate::dict::Learner {
            chat: chat.as_ref(),
            model: &options.model,
            mgr: &state.db,
            pool: &pool,
            conn: &conn,
            store: &state.store,
            key: dict_key,
            samples: options.samples,
            language: &options.language,
            stop: &stop,
        };
        let event = |done, total, current: &str, drafts, finished, error: Option<String>| LearnEvent {
            id: id.clone(),
            schema: schema.clone(),
            done,
            total,
            current: current.into(),
            drafts,
            finished,
            error,
        };
        let result = learner
            .run(&options.tables, |p| {
                let _ = app.emit("dict-learn", event(p.done, p.total, p.current, p.drafts, false, None));
            })
            .await;
        let last = match result {
            Ok(r) => {
                let error = (!r.failed.is_empty()).then(|| format!("{} table(s) failed: {}", r.failed.len(), r.failed.join("; ")));
                event(0, 0, "", r.drafts, true, error)
            }
            Err(e) => event(0, 0, "", 0, true, Some(e.to_string())),
        };
        state.learning.lock().unwrap_or_else(|e| e.into_inner()).remove(&slot);
        let _ = app.emit("dict-learn", last);
    }));
    Ok(())
}

/// Stops a running "Learn schema" after the table it is on.
#[tauri::command]
pub async fn dict_learn_stop(state: State<'_, AppState>, id: String, schema: String) -> AppResult<()> {
    if let Some(stop) = state.learning.lock().unwrap_or_else(|e| e.into_inner()).get(&learn_slot(&id, &schema)) {
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}
