// Shared domain types that mirror the Tauri IPC contract (src-tauri/src/model.rs), so keep UI concerns out.

export type Driver = "postgres" | "mysql" | "mariadb" | "sqlite";
export type Env = "dev" | "staging" | "prod";
export type SshAuth = "password" | "key" | "agent";
export type SslMode = "disable" | "prefer" | "require" | "verify-full";
export type AiAccess = "off" | "schema" | "data";
export type AiProvider = "anthropic" | "openai" | "gemini" | "openrouter" | "deepseek";

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  keyPath?: string;
  /** SSH keep-alive in seconds (default 15; 0 = off). */
  keepaliveSecs?: number;
}

export interface Connection {
  id: string;
  name: string;
  folder: string;
  driver: Driver;
  env: Env;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  file?: string;
  readOnly: boolean;
  connected: boolean;
  ssh?: SshConfig;
  sslMode: SslMode;
  aiAccess: AiAccess;
  serverVersion?: string;
  /** Connect timeout in seconds (default 10). */
  timeoutSecs?: number;
  /** PEM files for TLS: CA to verify the server, client certificate and key for mutual TLS. */
  sslCaPath?: string;
  sslCertPath?: string;
  sslKeyPath?: string;
}

/** An SSH server's host key shown for trust (hostKeyUnknown) or as a warning (hostKeyMismatch). */
export interface HostKeyInfo {
  host: string;
  port: number;
  algorithm: string;
  /** "SHA256:…" */
  fingerprint: string;
  /** OpenSSH public key line, stored when trusted. */
  key: string;
}

/** Secrets sent with save/test. Omitted = keep stored value, "" = delete. Never stored in `Connection`. */
export interface Secrets {
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
}

/** "Test SSH": the SSH login worked; whether the database host answers through the SSH server. */
export interface SshTestResult {
  elapsedMs: number;
  /** host:port of the database as seen from the SSH server. */
  target: string;
  targetReachable: boolean;
  targetError?: string;
}

export interface TestResult {
  serverVersion: string;
  elapsedMs: number;
}

export interface ConnectInfo {
  serverVersion: string;
}

export type NodeKind =
  | "database"
  | "schema"
  | "group"
  | "table"
  | "view"
  | "function"
  | "procedure"
  | "trigger"
  | "sequence"
  | "event"
  | "role"
  | "more";

export interface SchemaNode {
  id: string;
  label: string;
  kind: NodeKind;
  count?: number;
  /** Schema (PostgreSQL) or database (MySQL/MariaDB) the object lives in; "main" for SQLite. */
  schema?: string;
  children?: SchemaNode[];
  /** Database node whose children load on expand: api.schemaTree(scopedId(connId, label)). */
  lazy?: boolean;
  /** Database nodes: size on disk in bytes, when known. */
  size?: number;
}

export interface Column {
  name: string;
  type: string;
  numeric?: boolean;
  pk?: boolean;
  fk?: boolean;
  /** Allowed values of an enum column, in declared order. */
  enumValues?: string[];
}

export type Cell = string | number | null;

export interface ResultSet {
  id: string;
  label: string;
  columns: Column[];
  rows: Cell[][];
  elapsedMs: number;
  /** Set for DML results that return no rows. */
  affected?: number;
}

export interface StatementError {
  message: string;
  /** 1-based character offset in the statement, when the server reports one. */
  position?: number;
  code?: string;
}

/** One statement's outcome from `execute`. */
export interface StatementResult {
  sql: string;
  columns: Column[];
  rows: Cell[][];
  elapsedMs: number;
  affected?: number;
  /** More rows existed than maxRows. */
  truncated: boolean;
  /** This statement failed; later ones were not run. */
  error?: StatementError;
}

export interface OrderBy {
  column: string;
  desc: boolean;
}

export interface TablePage {
  columns: Column[];
  rows: Cell[][];
  hasMore: boolean;
}

export interface HistoryEntry {
  sql: string;
  /** RFC 3339 */
  ranAt: string;
  ok: boolean;
}

/** ER model from the backend; positions are laid out by the frontend. */
export interface ErModel {
  tables: Omit<ErTable, "x" | "y" | "draft">[];
  relations: Omit<ErRelation, "draft">[];
}

export type AppErrorKind =
  | "notFound"
  | "connection"
  | "auth"
  | "query"
  | "cancelled"
  | "needsConfirmation"
  | "readOnly"
  | "notSupported"
  | "hostKeyUnknown"
  | "hostKeyMismatch"
  | "secrets"
  | "io"
  | "internal";

/** `designer` = table designer; target "schema.table", or "schema.__new__<id>" for a new table. */
export type TabKind = "sql" | "table" | "er" | "routine" | "roles" | "designer" | "trigger" | "view";

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  connectionId: string;
  /** Object the tab is about, e.g. table name or schema. */
  target?: string;
  /** PostgreSQL database the tab works in (multi-database connections); undefined = the connection's base database. */
  database?: string;
  /** SQL tabs opened from / saved to a .sql file. */
  filePath?: string;
  /** Table tabs: initial WHERE filter (e.g. from following a foreign key). */
  filter?: string;
  dirty?: boolean;
}

export type PendingChange =
  | { kind: "update"; rowKey: string; column: string; from: Cell; to: Cell }
  | { kind: "insert"; tempId: string; values: Record<string, Cell> }
  | { kind: "delete"; rowKey: string };

export interface ErColumn {
  name: string;
  type: string;
  pk?: boolean;
  fk?: boolean;
  draft?: boolean;
}

export interface ErTable {
  name: string;
  rows: string;
  x: number;
  y: number;
  columns: ErColumn[];
  draft?: boolean;
}

export interface ErRelation {
  id: string;
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
  draft?: boolean;
}

export type ParamMode = "IN" | "OUT" | "INOUT";

export interface RoutineParam {
  mode: ParamMode;
  name: string;
  type: string;
}

export interface Routine {
  kind: "function" | "procedure";
  name: string;
  database: string;
  security: "definer" | "invoker";
  params: RoutineParam[];
  returns?: string;
  /** PG language (sql, plpgsql); ignored by MySQL/MariaDB. */
  language?: string;
  body: string;
}

export const ROLE_ATTRS = ["login", "superuser", "createdb", "createrole", "inherit", "replication"] as const;
export type RoleAttr = (typeof ROLE_ATTRS)[number];

export interface Role {
  name: string;
  tag: "login" | "group" | "superuser";
  attrs: Record<RoleAttr, boolean>;
  connLimit?: number;
  /** RFC 3339 or empty. */
  validUntil?: string;
  memberOf: string[];
}

export const PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "USAGE",
  "CREATE",
  "EXECUTE",
] as const;
export type Privilege = (typeof PRIVILEGES)[number];
export type PrivState = "on" | "off" | "na";

export interface PrivilegeRow {
  kind: "schema" | "table" | "view" | "sequence" | "function";
  name: string;
  /** One entry per PRIVILEGES item, same order. */
  cells: PrivState[];
}

export interface AgentStep {
  /** e.g. "Reading schema". */
  label: string;
  /** SQL or object names involved. */
  detail: string;
}

/** Approval level, decided by the app from the SQL, never by the model. */
export type RiskLevel = "read" | "change" | "critical";

export type ActionStatus = "pending" | "approved" | "rejected" | "superseded" | "done" | "failed";

/** One chat entry (persisted per connection; events upsert by id). */
export type AgentMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "agent"; text: string; steps: AgentStep[] }
  | {
      id: string;
      role: "action";
      level: RiskLevel;
      title: string;
      sql: string;
      status: ActionStatus;
      /** Critical: impact explanation written by the agent. */
      impact: string[];
      /** Computed by the app: affected rows, dependent objects, reversibility. */
      facts: string[];
      /** Production + critical: the object name the user must type. */
      confirmName?: string;
      elapsedMs?: number;
      /** After it ran: "3 rows affected", or the error. */
      outcome?: string;
    }
  | { id: string; role: "result"; sql: string; columns: Column[]; rows: Cell[][]; truncated: boolean; elapsedMs: number };

export type AgentEventBody =
  | { type: "message"; message: AgentMessage }
  | { type: "status"; running: boolean }
  | { type: "error"; message: string }
  /** The agent put SQL in a new editor tab (open_in_editor tool). */
  | { type: "openSql"; sql: string };

export type AgentEvent = { connId: string } & AgentEventBody;

export interface AgentDecision {
  kind: "approve" | "reject" | "edit";
  /** edit: the new SQL (a new card asks again). */
  sql?: string;
  /** Production critical: what the user typed. */
  typedName?: string;
}

export interface AiModel {
  id: string;
  name: string;
}

export interface AuditEntry {
  at: string;
  provider: string;
  model: string;
  level: RiskLevel;
  sql: string;
  /** auto | approved | rejected | blocked */
  decision: string;
  outcome: string;
}

// ---------- structure, data edits, routines, roles ----------

export interface ColumnDef {
  name: string;
  /** Name in the database before this edit; undefined = new column (tells rename from drop+add). */
  originalName?: string;
  /** Full SQL type, e.g. varchar(200), numeric(14,2). */
  type: string;
  nullable: boolean;
  /** SQL expression, e.g. now(), 'pending', 0. */
  default?: string;
  autoIncrement: boolean;
}

export interface IndexDef {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface ForeignKeyDef {
  name?: string;
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface CheckDef {
  name?: string;
  expression: string;
}

export interface TableDef {
  schema: string;
  name: string;
  columns: ColumnDef[];
  primaryKey: string[];
  foreignKeys: ForeignKeyDef[];
  indexes: IndexDef[];
  checks: CheckDef[];
}

/** original undefined = create; target undefined = drop; both = alter. */
export interface TableChange {
  original?: TableDef;
  target?: TableDef;
}

export type RowChange =
  | { kind: "update"; key: Record<string, Cell>; values: Record<string, Cell> }
  | { kind: "insert"; values: Record<string, Cell> }
  | { kind: "delete"; key: Record<string, Cell> };

/** sequence: PostgreSQL only; event: MySQL/MariaDB only. */
export type ObjectKind = "table" | "view" | "function" | "procedure" | "trigger" | "sequence" | "event";

/** SQL to review; only applyPreview(id) runs it, exactly as shown. */
export interface Preview {
  id: string;
  /** Displayed statements (passwords masked). */
  statements: string[];
  /** All-or-nothing; false for MySQL/MariaDB DDL (commits per statement). */
  transactional: boolean;
  destructive: boolean;
  warnings: string[];
}

export interface ApplyReport {
  executed: number;
  failed?: { index: number; message: string };
  rolledBack: boolean;
}

// ---------- triggers, views ----------

export interface Trigger {
  /** Schema (PG) / database (MySQL/MariaDB) / "main" (SQLite) of the table. */
  schema: string;
  name: string;
  /** Table (or view, for INSTEAD OF) the trigger fires on. */
  table: string;
  timing: "BEFORE" | "AFTER" | "INSTEAD OF";
  /** INSERT/UPDATE/DELETE (+ TRUNCATE on PG, statement level). MySQL/MariaDB/SQLite: exactly one. */
  events: string[];
  /** PG: FOR EACH ROW vs STATEMENT; always true elsewhere. */
  forEachRow: boolean;
  /** WHEN condition without outer parentheses (PG, SQLite). */
  condition?: string;
  /** PG: function call after EXECUTE FUNCTION, e.g. public.trg_touch(). Others: trigger statement (BEGIN … END). */
  body: string;
}

export interface ViewDef {
  schema: string;
  name: string;
  /** SELECT without trailing ";". */
  query: string;
}

// ---------- Databases: create / rename / drop ----------

export interface DatabaseDef {
  name: string;
  /** PostgreSQL OWNER. */
  owner?: string;
  /** MySQL/MariaDB CHARACTER SET. */
  charset?: string;
  /** MySQL/MariaDB COLLATE. */
  collation?: string;
}

// ---------- import / export (background jobs) ----------

export type DumpContent = "both" | "structure" | "data";

export interface DumpObject {
  kind: ObjectKind;
  name: string;
}

export interface ExportDatabaseOptions {
  /** PG schema / MySQL database / "main". */
  schema: string;
  /** Empty = every object of the schema. */
  objects: DumpObject[];
  content: DumpContent;
  transaction: boolean;
  dropExisting: boolean;
  batchSize: number;
  gzip: boolean;
  path: string;
}

export type DataFormat = "csv" | "json" | "sql";

export type DataSource = { kind: "table"; schema: string; table: string } | { kind: "query"; sql: string };

export interface ExportDataOptions {
  source: DataSource;
  format: DataFormat;
  path: string;
  /** CSV, default ",". */
  delimiter?: string;
  /** CSV header row. */
  header: boolean;
  /** SQL: rows per INSERT. */
  batchSize?: number;
  /** SQL: table name in the INSERTs. */
  tableName?: string;
}

export type OnError = "stop" | "skip";

export interface ImportSqlOptions {
  /** .sql or .sql.gz */
  path: string;
  onError: OnError;
}

export type FileFormat = "csv" | "json";

export interface FileOptions {
  path: string;
  format: FileFormat;
  delimiter: string;
  header: boolean;
  /** "UTF-8" | "ISO-8859-1" */
  encoding: string;
}

export interface FilePreview {
  columns: string[];
  /** First 20 rows. */
  rows: Cell[][];
  totalRows: number;
  /** Suggested SQL type per column for this driver. */
  types: string[];
}

export interface ColumnMapping {
  /** 0-based file column. */
  source: number;
  target: string;
}

export interface ImportDataOptions {
  file: FileOptions;
  schema: string;
  table: string;
  /** Create this table first ("new table from file"). */
  create?: TableDef;
  mapping: ColumnMapping[];
  /** stop = one transaction, rolled back on the first bad row; skip = bad rows skipped. */
  onError: OnError;
  emptyAsNull: boolean;
}

export interface JobProgress {
  jobId: string;
  done: number;
  total?: number;
  message: string;
}

export interface JobDone {
  jobId: string;
  ok: boolean;
  cancelled: boolean;
  succeeded: number;
  failed: number;
  /** First 100 errors; index = 1-based statement or row number. */
  errors: { index: number; message: string }[];
  message: string;
}
