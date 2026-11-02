//! IPC contract shared with `src/types.ts`. Serialized camelCase; keep both files in sync.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    Postgres,
    Mysql,
    Mariadb,
    Sqlite,
    /// Redis (or a compatible server such as Valkey), standalone.
    Redis,
}

impl Driver {
    /// Server port used when the connection leaves it empty.
    pub fn default_port(self) -> u16 {
        match self {
            Driver::Postgres => 5432,
            Driver::Mysql | Driver::Mariadb => 3306,
            Driver::Redis => 6379,
            Driver::Sqlite => 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Env {
    Dev,
    Staging,
    Prod,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshAuth {
    Password,
    Key,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
    VerifyFull,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiAccess {
    Off,
    Schema,
    Data,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    #[serde(default)]
    pub key_path: Option<String>,
    /// SSH keep-alive interval in seconds (default 15; 0 = off). Shorter keeps idle tunnels alive
    /// through routers/firewalls that drop quiet connections.
    #[serde(default)]
    pub keepalive_secs: Option<u32>,
}

/// Saved connection settings. Secrets never live here (see `Secrets`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    /// Empty on create; the backend assigns a UUID.
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub folder: String,
    pub driver: Driver,
    pub env: Env,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    /// Runtime only: always false in the store, set by the frontend after `connect`.
    #[serde(default)]
    pub connected: bool,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    pub ssl_mode: SslMode,
    pub ai_access: AiAccess,
    #[serde(default)]
    pub server_version: Option<String>,
    /// Connect timeout in seconds (default 10).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// PEM files for TLS: CA to verify the server, client certificate and key for mutual TLS.
    #[serde(default)]
    pub ssl_ca_path: Option<String>,
    #[serde(default)]
    pub ssl_cert_path: Option<String>,
    #[serde(default)]
    pub ssl_key_path: Option<String>,
}

impl Connection {
    /// `database` as a list: comma-separated, trimmed, empty entries dropped. Empty = every database.
    pub fn databases(&self) -> Vec<String> {
        self.database.as_deref().unwrap_or_default().split(',').map(str::trim).filter(|d| !d.is_empty()).map(str::to_string).collect()
    }

    /// Database the main pool opens: the first listed; PostgreSQL falls back to `postgres` when none is.
    pub fn base_database(&self) -> Option<String> {
        self.databases().into_iter().next().or_else(|| (self.driver == Driver::Postgres).then(|| "postgres".into()))
    }
}

/// An SSH server's host key, shown to the user to trust (or to warn about a change).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    /// e.g. `ssh-ed25519`
    pub algorithm: String,
    /// `SHA256:…` as printed by `ssh-keygen -l`.
    pub fingerprint: String,
    /// OpenSSH public key line (`ssh-ed25519 AAAA…`), stored when trusted.
    pub key: String,
}

/// Payload of the `connection-lost` event (SSH tunnel dropped).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLost {
    pub id: String,
    pub message: String,
}

/// Secrets passed alongside a connection. `None` = keep what's stored, `Some("")` = delete.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Secrets {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub ssh_password: Option<String>,
    #[serde(default)]
    pub ssh_passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub server_version: String,
    pub elapsed_ms: u64,
}

/// Result of "Test SSH": the SSH login worked; whether the database host answers through it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestResult {
    /// SSH connect + host key + authentication.
    pub elapsed_ms: u64,
    /// `host:port` of the database as seen from the SSH server.
    pub target: String,
    /// The SSH server could open a connection to the database host.
    pub target_reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub server_version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Database,
    Schema,
    Group,
    Table,
    View,
    Function,
    Procedure,
    Trigger,
    Sequence,
    /// MySQL/MariaDB scheduled event.
    Event,
    Role,
    More,
    /// Redis logical database (`db0`, `db1`, …); `count` = keys.
    Keyspace,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaNode {
    /// Unique path, e.g. `<connId>/orders_db/public/tables/orders`. Group ids end with the group key
    /// (`tables`, `views`, `functions`, `procedures`, `triggers`, `sequences`, `events`, `roles`).
    pub id: String,
    pub label: String,
    pub kind: NodeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    /// Schema (PostgreSQL) or database (MySQL/MariaDB) the object lives in; `main` for SQLite.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<SchemaNode>>,
    /// A database node whose children load on expand (`schema_tree("<connId>@<database>")`).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub lazy: bool,
    /// Database nodes: size on disk in bytes, when the server reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    /// Database type name as reported by the server, lowercase (e.g. `int8`, `numeric`, `varchar`).
    #[serde(rename = "type")]
    pub type_name: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub numeric: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pk: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fk: bool,
    /// Allowed values of an enum column (PostgreSQL enum types, MySQL/MariaDB `ENUM`), in declared order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enum_values: Vec<String>,
}

/// A cell: JSON null, number (integers within ±2^53 and floats) or string (everything else,
/// including decimals and big integers so no precision is lost).
pub type Cell = Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementError {
    pub message: String,
    /// 1-based character offset in the statement, when the server reports one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    pub sql: String,
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Cell>>,
    pub elapsed_ms: u64,
    /// Rows affected for statements that don't return rows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected: Option<u64>,
    /// More rows existed than `maxRows`.
    pub truncated: bool,
    /// Set when this statement failed; later statements were not run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<StatementError>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderBy {
    pub column: String,
    pub desc: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePage {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Cell>>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub sql: String,
    /// RFC 3339 timestamp.
    pub ran_at: String,
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub pk: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub fk: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErTable {
    pub name: String,
    /// Approximate row count, formatted short (e.g. `12.4k`); empty when unknown.
    pub rows: String,
    pub columns: Vec<ErColumn>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErRelation {
    pub id: String,
    pub from: String,
    pub from_column: String,
    pub to: String,
    pub to_column: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErModel {
    pub tables: Vec<ErTable>,
    pub relations: Vec<ErRelation>,
}

// ---------- structure, data edits, routines, roles ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDef {
    pub name: String,
    /// Name in the database before this edit; `None` = new column. Lets the diff tell rename from drop+add.
    #[serde(default)]
    pub original_name: Option<String>,
    /// Full SQL type as written in DDL, e.g. `varchar(200)`, `numeric(14,2)`, `timestamptz`.
    #[serde(rename = "type")]
    pub type_name: String,
    pub nullable: bool,
    /// Default as a SQL expression (`now()`, `'pending'`, `0`); `None` = no default.
    #[serde(default)]
    pub default: Option<String>,
    /// serial/identity (PG), AUTO_INCREMENT (MySQL), INTEGER PRIMARY KEY AUTOINCREMENT (SQLite).
    #[serde(default)]
    pub auto_increment: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDef {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDef {
    /// Constraint name; generated (`<table>_<col>_fkey`) when empty.
    #[serde(default)]
    pub name: Option<String>,
    pub columns: Vec<String>,
    #[serde(default)]
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    /// `CASCADE` | `SET NULL` | `RESTRICT` | `NO ACTION`; `None` = database default.
    #[serde(default)]
    pub on_delete: Option<String>,
    #[serde(default)]
    pub on_update: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckDef {
    #[serde(default)]
    pub name: Option<String>,
    pub expression: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDef {
    /// PostgreSQL schema / MySQL database / `main` for SQLite.
    pub schema: String,
    pub name: String,
    pub columns: Vec<ColumnDef>,
    #[serde(default)]
    pub primary_key: Vec<String>,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyDef>,
    #[serde(default)]
    pub indexes: Vec<IndexDef>,
    #[serde(default)]
    pub checks: Vec<CheckDef>,
}

/// One table edit. `original: None` = create; `target: None` = drop; both = alter (rename when names differ).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableChange {
    #[serde(default)]
    pub original: Option<TableDef>,
    #[serde(default)]
    pub target: Option<TableDef>,
}

/// A data edit from the grid. `key` = primary-key column → current value (identifies exactly one row).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RowChange {
    Update { key: std::collections::BTreeMap<String, Cell>, values: std::collections::BTreeMap<String, Cell> },
    Insert { values: std::collections::BTreeMap<String, Cell> },
    Delete { key: std::collections::BTreeMap<String, Cell> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ObjectKind {
    Table,
    View,
    Function,
    Procedure,
    Trigger,
    /// PostgreSQL only.
    Sequence,
    /// MySQL/MariaDB only.
    Event,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineParam {
    /// `IN` | `OUT` | `INOUT`
    pub mode: String,
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    /// `function` | `procedure`
    pub kind: String,
    pub name: String,
    /// Schema (PG) or database (MySQL/MariaDB).
    pub database: String,
    /// `definer` | `invoker`
    pub security: String,
    pub params: Vec<RoutineParam>,
    #[serde(default)]
    pub returns: Option<String>,
    /// PG language (`sql`, `plpgsql`); ignored by MySQL/MariaDB.
    #[serde(default)]
    pub language: Option<String>,
    /// Routine body as written by the user (PG: inside the dollar quotes; MySQL: `BEGIN … END`).
    pub body: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleAttrs {
    pub login: bool,
    pub superuser: bool,
    pub createdb: bool,
    pub createrole: bool,
    pub inherit: bool,
    pub replication: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    /// PG role name; MySQL/MariaDB `user@host`.
    pub name: String,
    /// `login` | `group` | `superuser`
    pub tag: String,
    pub attrs: RoleAttrs,
    #[serde(default)]
    pub conn_limit: Option<i32>,
    /// RFC 3339 or empty.
    #[serde(default)]
    pub valid_until: Option<String>,
    #[serde(default)]
    pub member_of: Vec<String>,
}

/// One object row of the privilege matrix. `cells` follow PRIVILEGES order:
/// SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES USAGE CREATE EXECUTE; each `on` | `off` | `na`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivilegeRow {
    /// `schema` | `table` | `view` | `sequence` | `function`
    pub kind: String,
    pub name: String,
    pub cells: Vec<String>,
}

pub const PRIVILEGES: [&str; 9] = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "USAGE", "CREATE", "EXECUTE"];

/// SQL the user reviews before applying. Only `apply_preview(id)` runs it — exactly these statements.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub id: String,
    /// What the user sees (passwords masked as `'••••••'`).
    pub statements: Vec<String>,
    /// All-or-nothing (PG, SQLite, MySQL data edits). MySQL/MariaDB DDL commits per statement.
    pub transactional: bool,
    /// Drops data or objects (DROP, column drop, DELETE).
    pub destructive: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyFailure {
    /// 0-based statement index.
    pub index: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    /// Statements that ran (and, when transactional and failed, were rolled back).
    pub executed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed: Option<ApplyFailure>,
    pub rolled_back: bool,
}

// ---------- triggers, views ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    /// Schema (PG) / database (MySQL/MariaDB) / `main` (SQLite) of the trigger's table.
    pub schema: String,
    pub name: String,
    /// Table (or view, for INSTEAD OF) the trigger fires on.
    pub table: String,
    /// `BEFORE` | `AFTER` | `INSTEAD OF` (INSTEAD OF: PG/SQLite on views).
    pub timing: String,
    /// Subset of `INSERT` `UPDATE` `DELETE` (+ `TRUNCATE` on PG, statement level only).
    /// MySQL/MariaDB/SQLite: exactly one.
    pub events: Vec<String>,
    /// PG: FOR EACH ROW (true) or STATEMENT (false). Always true on MySQL/MariaDB/SQLite.
    pub for_each_row: bool,
    /// WHEN condition without the outer parentheses (PG, SQLite); `None` = none.
    #[serde(default)]
    pub condition: Option<String>,
    /// PG: the function call after `EXECUTE FUNCTION`, e.g. `public.trg_touch()`.
    /// MySQL/MariaDB/SQLite: the trigger statement, e.g. `BEGIN … END`.
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewDef {
    pub schema: String,
    pub name: String,
    /// The view's SELECT, without a trailing `;`.
    pub query: String,
}

// ---------- Databases: create / rename / drop ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDef {
    pub name: String,
    /// PostgreSQL `OWNER`; ignored elsewhere.
    #[serde(default)]
    pub owner: Option<String>,
    /// MySQL/MariaDB `CHARACTER SET`; ignored elsewhere.
    #[serde(default)]
    pub charset: Option<String>,
    /// MySQL/MariaDB `COLLATE`; ignored elsewhere.
    #[serde(default)]
    pub collation: Option<String>,
}

// ---------- import / export (background jobs) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DumpContent {
    Both,
    Structure,
    Data,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpObject {
    pub kind: ObjectKind,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDatabaseOptions {
    /// PG schema / MySQL database / `main`.
    pub schema: String,
    /// Objects to dump; empty = every object of the schema.
    #[serde(default)]
    pub objects: Vec<DumpObject>,
    pub content: DumpContent,
    /// Wrap the script in BEGIN/COMMIT (MySQL/MariaDB DDL still commits per statement).
    pub transaction: bool,
    /// `DROP … IF EXISTS` before each CREATE.
    pub drop_existing: bool,
    /// Rows per INSERT statement.
    pub batch_size: u32,
    /// Write gzip (`path` should end in `.gz`).
    pub gzip: bool,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DataFormat {
    Csv,
    Json,
    Sql,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DataSource {
    Table { schema: String, table: String },
    /// A read query (re-run for the export, not limited to the grid's rows).
    Query { sql: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDataOptions {
    pub source: DataSource,
    pub format: DataFormat,
    pub path: String,
    /// CSV delimiter (one character); default `,`.
    #[serde(default)]
    pub delimiter: Option<String>,
    /// CSV header row.
    #[serde(default)]
    pub header: bool,
    /// SQL: rows per INSERT.
    #[serde(default)]
    pub batch_size: Option<u32>,
    /// SQL: table name in the INSERTs; default the source table, else `export`.
    #[serde(default)]
    pub table_name: Option<String>,
}

/// Import behaviour on a failing statement/row: stop (and roll back what can be) or skip and continue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnError {
    Stop,
    Skip,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSqlOptions {
    /// `.sql` or gzip-compressed `.sql.gz` (detected by content).
    pub path: String,
    pub on_error: OnError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileFormat {
    Csv,
    Json,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOptions {
    pub path: String,
    pub format: FileFormat,
    /// CSV delimiter (one character).
    #[serde(default = "default_delimiter")]
    pub delimiter: String,
    /// CSV first row = column names.
    #[serde(default)]
    pub header: bool,
    /// `UTF-8` | `ISO-8859-1`.
    #[serde(default = "default_encoding")]
    pub encoding: String,
}

fn default_delimiter() -> String {
    ",".into()
}

fn default_encoding() -> String {
    "UTF-8".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    /// Header names, or `column1…` without a header. JSON: keys of the objects, first-seen order.
    pub columns: Vec<String>,
    /// First 20 data rows as text/number/bool/null cells.
    pub rows: Vec<Vec<Cell>>,
    pub total_rows: u64,
    /// Suggested SQL type per column for this connection's driver (for "create new table").
    pub types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMapping {
    /// 0-based file column.
    pub source: usize,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDataOptions {
    pub file: FileOptions,
    pub schema: String,
    pub table: String,
    /// Create this table before importing (the "new table from file" path).
    #[serde(default)]
    pub create: Option<TableDef>,
    pub mapping: Vec<ColumnMapping>,
    /// Stop = all rows in one transaction, rolled back on the first bad row; Skip = bad rows are skipped.
    pub on_error: OnError,
    /// Empty CSV fields become NULL.
    #[serde(default)]
    pub empty_as_null: bool,
}

/// `job-progress` event payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub job_id: String,
    pub done: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// What is being worked on, e.g. `public.orders`.
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobError {
    /// 1-based statement index (SQL import) or data row number (data import).
    pub index: u64,
    pub message: String,
}

/// `job-done` event payload.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDone {
    pub job_id: String,
    pub ok: bool,
    pub cancelled: bool,
    /// Statements run / rows written or imported.
    pub succeeded: u64,
    pub failed: u64,
    /// First 100 errors.
    pub errors: Vec<JobError>,
    /// Fatal error, or a short summary (e.g. the written path).
    pub message: String,
}

// ---------- AI agent ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    Anthropic,
    Openai,
    Gemini,
    Openrouter,
    Deepseek,
}

impl AiProvider {
    pub const ALL: [AiProvider; 5] = [AiProvider::Anthropic, AiProvider::Openai, AiProvider::Gemini, AiProvider::Openrouter, AiProvider::Deepseek];

    pub fn as_str(self) -> &'static str {
        match self {
            AiProvider::Anthropic => "anthropic",
            AiProvider::Openai => "openai",
            AiProvider::Gemini => "gemini",
            AiProvider::Openrouter => "openrouter",
            AiProvider::Deepseek => "deepseek",
        }
    }
}

/// A model the user can pick (only tool-calling models are listed where the provider says so).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStep {
    /// e.g. "Reading schema", "Counting rows".
    pub label: String,
    /// SQL or object names involved.
    pub detail: String,
}

/// Approval level, decided by the app from the SQL — never by the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Read,
    Change,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActionStatus {
    Pending,
    Approved,
    Rejected,
    /// Replaced by an edited version (a new card).
    Superseded,
    Done,
    Failed,
}

/// One chat entry as the panel shows it (also what is persisted per connection).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum AgentMessage {
    User { id: String, text: String },
    /// Agent prose; `steps` = what it did (visible trail, incl. SQL).
    #[serde(rename_all = "camelCase")]
    Agent { id: String, text: String, #[serde(default)] steps: Vec<AgentStep> },
    /// A write the user must approve.
    #[serde(rename_all = "camelCase")]
    Action {
        id: String,
        level: RiskLevel,
        title: String,
        sql: String,
        status: ActionStatus,
        /// Impact explanation written by the agent (critical actions).
        #[serde(default)]
        impact: Vec<String>,
        /// Facts computed by the app: affected row counts, dependent objects, reversibility.
        #[serde(default)]
        facts: Vec<String>,
        /// Production + critical: the object name the user must type.
        #[serde(default)]
        confirm_name: Option<String>,
        #[serde(default)]
        elapsed_ms: Option<u64>,
        /// After it ran: e.g. "3 rows affected"; or the error.
        #[serde(default)]
        outcome: Option<String>,
    },
    /// Rows of a read query the agent ran (first rows only).
    #[serde(rename_all = "camelCase")]
    Result { id: String, sql: String, columns: Vec<Column>, rows: Vec<Vec<Cell>>, truncated: bool, elapsed_ms: u64 },
    /// Data-dictionary changes the agent proposes; saved only when the user approves.
    #[serde(rename_all = "camelCase")]
    Note {
        id: String,
        title: String,
        status: ActionStatus,
        items: Vec<NoteItem>,
        /// After a decision: e.g. "Saved 2 entries".
        #[serde(default)]
        outcome: Option<String>,
    },
}

/// One proposed dictionary change: a table note (`column` empty), a column note, or a glossary term
/// (`term` set; `after` = its meaning).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteItem {
    #[serde(default)]
    pub table: String,
    #[serde(default)]
    pub column: String,
    #[serde(default)]
    pub term: String,
    #[serde(default)]
    pub maps_to: String,
    /// What the dictionary says now (empty = nothing yet).
    #[serde(default)]
    pub before: String,
    pub after: String,
}

/// `agent-event` payload. `conn_id` is the bare connection id.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub conn_id: String,
    #[serde(flatten)]
    pub kind: AgentEventKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentEventKind {
    /// Insert or replace (by id) a chat entry.
    Message { message: AgentMessage },
    /// A turn started/stopped (drives the Stop button).
    Status { running: bool },
    /// The turn failed (provider/network/key error); shown inline.
    Error { message: String },
    /// The agent put SQL in a new editor tab for the user to edit (`open_in_editor` tool).
    OpenSql { sql: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DecisionKind {
    Approve,
    Reject,
    /// Replace the SQL: the card is superseded and a new card (re-classified) asks again.
    Edit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDecision {
    pub kind: DecisionKind,
    /// Edit: the new SQL.
    #[serde(default)]
    pub sql: Option<String>,
    /// Production critical approvals: what the user typed (must equal `confirm_name`).
    #[serde(default)]
    pub typed_name: Option<String>,
    /// Dictionary cards: the items to save (index into the card's items) with the text the user
    /// kept or edited; `None` = all, as proposed.
    #[serde(default)]
    pub picks: Option<Vec<NotePick>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotePick {
    pub index: usize,
    pub text: String,
}

// ---------- data dictionary ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteStatus {
    /// Written or approved by the user.
    Verified,
    /// Written by "Learn schema", not reviewed yet.
    Draft,
}

/// A note on a table (`column` empty) or one of its columns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictNote {
    pub table: String,
    #[serde(default)]
    pub column: String,
    pub note: String,
    pub status: NoteStatus,
    /// Drafts: what the AI based the note on.
    #[serde(default)]
    pub evidence: String,
    /// Drafts: the AI was not sure.
    #[serde(default)]
    pub unsure: bool,
}

/// A business term and the tables/columns/conditions it maps to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictTerm {
    pub term: String,
    pub meaning: String,
    #[serde(default)]
    pub maps_to: String,
    pub status: NoteStatus,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub unsure: bool,
}

/// The dictionary of one schema: saved notes and terms, plus the database's own comments (read-only).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dictionary {
    pub notes: Vec<DictNote>,
    pub terms: Vec<DictTerm>,
    pub comments: Vec<DictNote>,
}

/// A table that has dictionary notes (the navigator marks it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictMark {
    pub database: String,
    pub schema: String,
    pub table: String,
    /// Some of its notes are unreviewed drafts.
    pub draft: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnOptions {
    /// Tables to learn; empty = every table of the schema.
    #[serde(default)]
    pub tables: Vec<String>,
    /// Also read sample rows and distinct values (needs AI data access).
    pub samples: bool,
    pub provider: AiProvider,
    pub model: String,
    /// Language the notes are written in (e.g. "en", "id").
    pub language: String,
}

/// `dict-learn` progress payload. `id` = the IPC id the learning runs on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnEvent {
    pub id: String,
    pub schema: String,
    pub done: u32,
    pub total: u32,
    /// Table being read now (empty when finished).
    pub current: String,
    /// Drafts written so far.
    pub drafts: u32,
    pub finished: bool,
    /// Finished with a problem (some tables failed, or the run stopped early).
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    /// RFC 3339.
    pub at: String,
    pub provider: String,
    pub model: String,
    pub level: RiskLevel,
    pub sql: String,
    /// `auto` (reads) | `approved` | `rejected` | `blocked` (read-only / AI access).
    pub decision: String,
    /// "ok · 3 rows" or the error.
    pub outcome: String,
}

// ---------- Redis ----------

/// One key from a SCAN page. `ttl_ms`: -1 = no expiry, -2 = gone by the time it was read.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KvKey {
    pub key: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub ttl_ms: i64,
    /// Bytes from `MEMORY USAGE`; `None` when the server refuses it (ACL, Redis < 4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<u64>,
}

/// A SCAN page; `cursor` "0" = the scan is complete.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvScanPage {
    pub cursor: String,
    pub keys: Vec<KvKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KvStreamEntry {
    pub id: String,
    pub fields: Vec<(String, String)>,
}

/// A key's value by type. Texts that aren't UTF-8 are shown lossily and flagged `binary` (read-only).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum KvValue {
    /// The key doesn't exist (any more).
    None,
    String { value: String, binary: bool },
    Hash { entries: Vec<(String, String)> },
    List { items: Vec<String> },
    Set { members: Vec<String> },
    Zset { entries: Vec<(String, f64)> },
    Stream { entries: Vec<KvStreamEntry> },
    /// Module or newer types (JSON, vector sets…): use the console.
    Other,
}

/// A key with its value. `length` = bytes (string) or items (collections); `truncated` = only the
/// first items (or bytes) were loaded; `binary` = some text wasn't UTF-8, so editing is off.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvEntry {
    pub key: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub ttl_ms: i64,
    pub length: u64,
    pub truncated: bool,
    pub binary: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<u64>,
    pub value: KvValue,
}

/// A change from the key browser. `replace` = the old field/member being renamed (removed atomically).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum KvEdit {
    SetString { key: String, value: String },
    HashSet { key: String, field: String, value: String, #[serde(default)] replace: Option<String> },
    HashDel { key: String, field: String },
    ListSet { key: String, index: i64, value: String },
    ListPush { key: String, value: String, head: bool },
    ListRemove { key: String, value: String },
    SetAdd { key: String, member: String, #[serde(default)] replace: Option<String> },
    SetRemove { key: String, member: String },
    ZsetAdd { key: String, member: String, score: f64, #[serde(default)] replace: Option<String> },
    ZsetRemove { key: String, member: String },
    StreamAdd { key: String, fields: Vec<(String, String)> },
    StreamDel { key: String, id: String },
    /// `ttl_secs` None = remove the expiry.
    Expire { key: String, ttl_secs: Option<i64> },
    /// Fails if `to` exists (RENAMENX).
    Rename { key: String, to: String },
    Delete { keys: Vec<String> },
    /// New key (fails if it exists). `kind`: string, hash, list, set, zset, stream; `field` for hash/stream, `score` for zset.
    Create {
        key: String,
        kind: String,
        #[serde(default)]
        field: Option<String>,
        value: String,
        #[serde(default)]
        score: Option<f64>,
        #[serde(default)]
        ttl_secs: Option<i64>,
    },
}

/// Console reply formatted like redis-cli.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvReply {
    pub text: String,
    pub error: bool,
    pub elapsed_ms: u64,
}

/// `INFO` parsed into its sections (`# Server`, `# Memory`, …) in server order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KvInfoSection {
    pub name: String,
    pub fields: Vec<(String, String)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact shape the frontend sends from the connection dialog (undefined fields omitted).
    #[test]
    fn deserializes_frontend_connection() {
        let c: Connection = serde_json::from_value(serde_json::json!({
            "id": "", "name": "local", "folder": "Local", "driver": "postgres", "env": "dev",
            "host": "localhost", "port": 5432, "database": "ahsandb_test", "user": "app",
            "readOnly": false, "connected": false, "sslMode": "verify-full", "aiAccess": "schema",
            "timeoutSecs": 10
        }))
        .unwrap();
        assert_eq!(c.driver, Driver::Postgres);
        assert_eq!(c.ssl_mode, SslMode::VerifyFull);
        assert!(c.ssh.is_none());
        let s: Secrets = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(s.password.is_none());
    }

    #[test]
    fn redis_ipc_shapes_match_the_frontend() {
        // Shapes as src/types.ts sends them.
        let e: KvEdit = serde_json::from_value(serde_json::json!({"op": "expire", "key": "k", "ttlSecs": null})).unwrap();
        assert!(matches!(e, KvEdit::Expire { ttl_secs: None, .. }));
        let e: KvEdit = serde_json::from_value(serde_json::json!({"op": "hashSet", "key": "k", "field": "f", "value": "v", "replace": "old"})).unwrap();
        assert!(matches!(e, KvEdit::HashSet { replace: Some(r), .. } if r == "old"));
        let e: KvEdit = serde_json::from_value(serde_json::json!({"op": "create", "key": "k", "kind": "zset", "value": "m", "score": 2.5, "ttlSecs": 60})).unwrap();
        assert!(matches!(e, KvEdit::Create { score: Some(_), ttl_secs: Some(60), field: None, .. }));
        let e: KvEdit = serde_json::from_value(serde_json::json!({"op": "streamAdd", "key": "k", "fields": [["a", "1"]]})).unwrap();
        assert!(matches!(e, KvEdit::StreamAdd { fields, .. } if fields == [("a".to_string(), "1".to_string())]));
        let entry = KvEntry {
            key: "k".into(),
            type_name: "zset".into(),
            ttl_ms: -1,
            length: 1,
            truncated: false,
            binary: false,
            memory: Some(72),
            value: KvValue::Zset { entries: vec![("m".into(), 2.5)] },
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            serde_json::json!({"key": "k", "type": "zset", "ttlMs": -1, "length": 1, "truncated": false, "binary": false, "memory": 72, "value": {"kind": "zset", "entries": [["m", 2.5]]}})
        );
        let s = serde_json::to_value(KvValue::String { value: "v".into(), binary: false }).unwrap();
        assert_eq!(s, serde_json::json!({"kind": "string", "value": "v", "binary": false}));
        assert_eq!(serde_json::to_value(KvValue::None).unwrap(), serde_json::json!({"kind": "none"}));
    }

    #[test]
    fn database_lists() {
        let base: Connection = serde_json::from_value(serde_json::json!({
            "name": "x", "folder": "", "driver": "postgres", "env": "dev", "sslMode": "disable", "aiAccess": "off"
        }))
        .unwrap();
        let with = |driver, db: Option<&str>| Connection { driver, database: db.map(str::to_string), ..base.clone() };
        let pg = |db| with(Driver::Postgres, db);
        assert_eq!(pg(Some(" shop ,analytics")).databases(), ["shop", "analytics"]);
        assert_eq!(pg(Some("shop,,analytics,")).databases(), ["shop", "analytics"]);
        assert_eq!(pg(Some(" , ,")).databases(), Vec::<String>::new());
        assert_eq!(pg(Some(" analytics , shop")).base_database().as_deref(), Some("analytics"));
        for db in [None, Some(""), Some(" , ")] {
            assert!(pg(db).databases().is_empty());
            assert_eq!(pg(db).base_database().as_deref(), Some("postgres"));
            assert_eq!(with(Driver::Mysql, db).base_database(), None);
            assert_eq!(with(Driver::Mariadb, db).base_database(), None);
        }
        assert_eq!(with(Driver::Mariadb, Some("shop, x")).base_database().as_deref(), Some("shop"));
    }
}
