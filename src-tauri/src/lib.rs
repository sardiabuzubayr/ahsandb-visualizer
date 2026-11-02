pub mod ai;
mod commands;
pub mod db;
pub mod ddl;
pub mod dict;
pub mod error;
pub mod kv;
pub mod model;
pub mod objects;
pub mod secrets;
pub mod sql;
pub mod ssh;
pub mod store;
pub mod transfer;

use tauri::Manager;

pub struct AppState {
    pub store: store::Store,
    pub secrets: Box<dyn secrets::SecretStore>,
    pub db: db::Manager,
    pub agent: ai::agent::AgentState,
    /// Running "Learn schema" runs ("<id>\n<schema>") and their stop flags.
    pub learning: std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = tauri::async_runtime::block_on(store::Store::open(&dir.join("app.db")))?;
            let secrets = secrets::FileSecrets::open(&dir)?;
            app.manage(AppState { store, secrets: Box::new(secrets), db: db::Manager::default(), agent: ai::agent::AgentState::default(), learning: Default::default() });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::test_ssh,
            commands::connect,
            commands::disconnect,
            commands::schema_tree,
            commands::table_columns,
            commands::er_model,
            commands::completion_schema,
            commands::execute,
            commands::cancel,
            commands::fetch_more,
            commands::table_page,
            commands::history,
            commands::create_sqlite_file,
            commands::trust_host_key,
            commands::forget_host_key,
            commands::load_table,
            commands::preview_schema_changes,
            commands::preview_row_changes,
            commands::preview_drop,
            commands::load_routine,
            commands::preview_routine,
            commands::run_routine,
            commands::load_roles,
            commands::load_privileges,
            commands::preview_role,
            commands::apply_preview,
            commands::load_trigger,
            commands::preview_trigger,
            commands::load_view,
            commands::preview_view,
            commands::object_ddl,
            commands::preview_create_database,
            commands::preview_rename_database,
            commands::preview_drop_database,
            commands::export_database,
            commands::export_data,
            commands::import_sql,
            commands::inspect_import_file,
            commands::import_data,
            commands::cancel_job,
            commands::ai_key_status,
            commands::ai_set_key,
            commands::ai_list_models,
            commands::agent_send,
            commands::agent_decide,
            commands::agent_stop,
            commands::agent_history,
            commands::agent_clear,
            commands::agent_delete_message,
            commands::agent_audit,
            commands::dict_get,
            commands::dict_put_note,
            commands::dict_delete_note,
            commands::dict_put_term,
            commands::dict_delete_term,
            commands::dict_resolve_drafts,
            commands::dict_marks,
            commands::dict_learn,
            commands::dict_learn_stop,
            commands::read_text_file,
            commands::write_text_file,
            commands::write_base64_file,
            commands::kv_scan,
            commands::kv_get,
            commands::kv_edit,
            commands::kv_command,
            commands::kv_info,
            commands::kv_memory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
