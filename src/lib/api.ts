// Frontend side of the Tauri IPC contract (Rust: src-tauri/src/commands.rs).
// In a plain browser during development the same functions return mock data (src/mock/api.ts).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { mockApi } from "../mock/api";
import type {
  AgentDecision,
  AgentEvent,
  AgentMessage,
  AiModel,
  AiProvider,
  ApplyReport,
  AuditEntry,
  DatabaseDef,
  ExportDataOptions,
  ExportDatabaseOptions,
  FileOptions,
  FilePreview,
  ImportDataOptions,
  ImportSqlOptions,
  JobDone,
  JobProgress,
  AppErrorKind,
  Cell,
  ObjectKind,
  Preview,
  PrivilegeRow,
  Role,
  Routine,
  RowChange,
  TableChange,
  TableDef,
  Trigger,
  ViewDef,
  Column,
  ConnectInfo,
  Connection,
  ErModel,
  HistoryEntry,
  HostKeyInfo,
  OrderBy,
  SchemaNode,
  Secrets,
  SshTestResult,
  StatementResult,
  TablePage,
  TestResult,
  KvEdit,
  KvEntry,
  KvInfoSection,
  KvReply,
  KvScanPage,
} from "../types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export class ApiError extends Error {
  constructor(
    public kind: AppErrorKind,
    message: string,
    /** Statements behind needsConfirmation / readOnly. */
    public detail?: string[],
    /** Server key behind hostKeyUnknown / hostKeyMismatch. */
    public hostKey?: HostKeyInfo,
  ) {
    super(message);
  }
}

export function isApiError(e: unknown, kind?: AppErrorKind): e is ApiError {
  return e instanceof ApiError && (!kind || e.kind === kind);
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const err = e as { kind?: AppErrorKind; message?: string; detail?: string[]; hostKey?: HostKeyInfo } | string;
    if (typeof err === "object" && err?.kind) throw new ApiError(err.kind, err.message ?? "", err.detail, err.hostKey);
    throw new ApiError("internal", String(e));
  }
}

export interface Api {
  listConnections(): Promise<Connection[]>;
  saveConnection(connection: Connection, secrets: Secrets): Promise<Connection>;
  deleteConnection(id: string): Promise<void>;
  testConnection(connection: Connection, secrets: Secrets): Promise<TestResult>;
  /** Only the SSH tunnel part (login + can the SSH server reach the database host). */
  testSsh(connection: Connection, secrets: Secrets): Promise<SshTestResult>;
  connect(id: string): Promise<ConnectInfo>;
  disconnect(id: string): Promise<void>;
  schemaTree(id: string): Promise<SchemaNode[]>;
  tableColumns(id: string, schema: string, table: string): Promise<Column[]>;
  erModel(id: string, schema: string): Promise<ErModel>;
  completionSchema(id: string): Promise<Record<string, string[]>>;
  execute(id: string, sql: string, runId: string, confirmed: boolean, maxRows: number): Promise<StatementResult[]>;
  cancel(runId: string): Promise<void>;
  /** Re-runs one read statement with a bigger row limit ("Load more"); writes are refused. */
  fetchMore(id: string, sql: string, runId: string, maxRows: number): Promise<StatementResult>;
  /** `filter` = WHERE expression (one read condition; the backend refuses anything else). */
  tablePage(id: string, schema: string, table: string, orderBy: OrderBy | null, filter: string | null, offset: number, limit: number): Promise<TablePage>;
  history(id: string, limit: number): Promise<HistoryEntry[]>;
  createSqliteFile(path: string): Promise<void>;
  trustHostKey(hostKey: HostKeyInfo): Promise<void>;
  forgetHostKey(host: string, port: number): Promise<void>;
  /** Subscribes to SSH tunnel drops; returns an unsubscribe function. */
  onConnectionLost(cb: (e: { id: string; message: string }) => void): Promise<() => void>;
  // Structure and data changes: every change goes preview → applyPreview.
  loadTable(id: string, schema: string, table: string): Promise<TableDef>;
  previewSchemaChanges(id: string, changes: TableChange[]): Promise<Preview>;
  previewRowChanges(id: string, schema: string, table: string, changes: RowChange[]): Promise<Preview>;
  previewDrop(id: string, kind: ObjectKind, schema: string, name: string): Promise<Preview>;
  loadRoutine(id: string, schema: string, name: string, kind: "function" | "procedure"): Promise<Routine>;
  previewRoutine(id: string, original: Routine | null, routine: Routine): Promise<Preview>;
  runRoutine(id: string, routine: Routine, args: Cell[], runId: string, confirmed: boolean): Promise<StatementResult[]>;
  loadRoles(id: string): Promise<Role[]>;
  loadPrivileges(id: string, role: string, schema: string): Promise<PrivilegeRow[]>;
  previewRole(
    id: string,
    original: Role | null,
    target: Role | null,
    password: string | null,
    schema: string,
    privilegesOriginal: PrivilegeRow[],
    privilegesTarget: PrivilegeRow[],
  ): Promise<Preview>;
  /** Production connections need confirmed=true (the user clicked the danger Apply button). */
  applyPreview(id: string, previewId: string, confirmed: boolean): Promise<ApplyReport>;
  loadTrigger(id: string, schema: string, name: string): Promise<Trigger>;
  /** original null = create; target null = drop; both = replace. */
  previewTrigger(id: string, original: Trigger | null, target: Trigger | null): Promise<Preview>;
  loadView(id: string, schema: string, name: string): Promise<ViewDef>;
  /** original null = create. */
  previewView(id: string, original: ViewDef | null, view: ViewDef): Promise<Preview>;
  /** DDL text of a sequence (PostgreSQL) or event (MySQL/MariaDB), for a SQL editor. */
  objectDdl(id: string, kind: "sequence" | "event", schema: string, name: string): Promise<string>;
  /** Database DDL runs on the main pool: pass the bare connection id (also to applyPreview). */
  previewCreateDatabase(id: string, database: DatabaseDef): Promise<Preview>;
  previewRenameDatabase(id: string, from: string, to: string): Promise<Preview>;
  previewDropDatabase(id: string, name: string): Promise<Preview>;
  /** Jobs: each returns a job id at once; progress/result arrive through onJobProgress/onJobDone. */
  exportDatabase(id: string, options: ExportDatabaseOptions): Promise<string>;
  exportData(id: string, options: ExportDataOptions): Promise<string>;
  /** Production connections need confirmed=true. */
  importSql(id: string, options: ImportSqlOptions, confirmed: boolean): Promise<string>;
  inspectImportFile(id: string, file: FileOptions): Promise<FilePreview>;
  importData(id: string, options: ImportDataOptions, confirmed: boolean): Promise<string>;
  cancelJob(jobId: string): Promise<void>;
  onJobProgress(cb: (p: JobProgress) => void): Promise<() => void>;
  onJobDone(cb: (d: JobDone) => void): Promise<() => void>;
  /** AI: providers with a saved key. */
  aiKeyStatus(): Promise<AiProvider[]>;
  /** "" deletes the key. */
  aiSetKey(provider: AiProvider, key: string): Promise<void>;
  /** Tool-capable models; key = test an unsaved key (undefined = stored). Bad key → ApiError "auth". */
  aiListModels(provider: AiProvider, key?: string): Promise<AiModel[]>;
  /** id may be scoped ("<connId>@<db>"). Progress arrives via onAgentEvent. */
  agentSend(id: string, provider: AiProvider, model: string, text: string): Promise<void>;
  agentDecide(actionId: string, decision: AgentDecision): Promise<void>;
  agentStop(id: string): Promise<void>;
  agentHistory(id: string): Promise<AgentMessage[]>;
  agentClear(id: string): Promise<void>;
  agentAudit(id: string, limit: number): Promise<AuditEntry[]>;
  onAgentEvent(cb: (e: AgentEvent) => void): Promise<() => void>;
  /** .sql files picked in the OS dialogs (UTF-8, max 20 MB). */
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;
  /** Binary file (e.g. PNG) as base64. */
  writeBase64File(path: string, data: string): Promise<void>;
  // Redis. `id` may be scoped to a database index (`<connId>@3`).
  /** Keys matching a glob pattern with type and TTL; `hasTtl` true/false = only keys with/without an expiry.
   *  Continue from the returned cursor ("0" = done). */
  kvScan(id: string, cursor: string, pattern: string, typeFilter: string | null, hasTtl: boolean | null, count: number): Promise<KvScanPage>;
  kvGet(id: string, key: string): Promise<KvEntry>;
  /** Read-only connections → readOnly; production without `confirmed` → needsConfirmation (detail = commands). */
  kvEdit(id: string, edit: KvEdit, confirmed: boolean): Promise<void>;
  /** One console line. Blocked commands → query error; writes follow the same read-only / production rules. */
  kvCommand(id: string, line: string, confirmed: boolean): Promise<KvReply>;
  kvInfo(id: string): Promise<KvInfoSection[]>;
  /** Memory the whole server uses (Redis has no per-database figure). */
  kvMemory(id: string): Promise<number | null>;
}

const real: Api = {
  listConnections: () => call("list_connections"),
  saveConnection: (connection, secrets) => call("save_connection", { connection, secrets }),
  deleteConnection: (id) => call("delete_connection", { id }),
  testConnection: (connection, secrets) => call("test_connection", { connection, secrets }),
  testSsh: (connection, secrets) => call("test_ssh", { connection, secrets }),
  connect: (id) => call("connect", { id }),
  disconnect: (id) => call("disconnect", { id }),
  schemaTree: (id) => call("schema_tree", { id }),
  tableColumns: (id, schema, table) => call("table_columns", { id, schema, table }),
  erModel: (id, schema) => call("er_model", { id, schema }),
  completionSchema: (id) => call("completion_schema", { id }),
  execute: (id, sql, runId, confirmed, maxRows) => call("execute", { id, sql, runId, confirmed, maxRows }),
  cancel: (runId) => call("cancel", { runId }),
  fetchMore: (id, sql, runId, maxRows) => call("fetch_more", { id, sql, runId, maxRows }),
  tablePage: (id, schema, table, orderBy, filter, offset, limit) =>
    call("table_page", { id, schema, table, orderBy, filter, offset, limit }),
  history: (id, limit) => call("history", { id, limit }),
  createSqliteFile: (path) => call("create_sqlite_file", { path }),
  trustHostKey: (hostKey) => call("trust_host_key", { hostKey }),
  forgetHostKey: (host, port) => call("forget_host_key", { host, port }),
  onConnectionLost: (cb) => listen<{ id: string; message: string }>("connection-lost", (e) => cb(e.payload)),
  loadTable: (id, schema, table) => call("load_table", { id, schema, table }),
  previewSchemaChanges: (id, changes) => call("preview_schema_changes", { id, changes }),
  previewRowChanges: (id, schema, table, changes) => call("preview_row_changes", { id, schema, table, changes }),
  previewDrop: (id, kind, schema, name) => call("preview_drop", { id, kind, schema, name }),
  loadRoutine: (id, schema, name, kind) => call("load_routine", { id, schema, name, kind }),
  previewRoutine: (id, original, routine) => call("preview_routine", { id, original, routine }),
  runRoutine: (id, routine, args, runId, confirmed) => call("run_routine", { id, routine, args, runId, confirmed }),
  loadRoles: (id) => call("load_roles", { id }),
  loadPrivileges: (id, role, schema) => call("load_privileges", { id, role, schema }),
  previewRole: (id, original, target, password, schema, privilegesOriginal, privilegesTarget) =>
    call("preview_role", { id, original, target, password, schema, privilegesOriginal, privilegesTarget }),
  applyPreview: (id, previewId, confirmed) => call("apply_preview", { id, previewId, confirmed }),
  loadTrigger: (id, schema, name) => call("load_trigger", { id, schema, name }),
  previewTrigger: (id, original, target) => call("preview_trigger", { id, original, target }),
  loadView: (id, schema, name) => call("load_view", { id, schema, name }),
  previewView: (id, original, view) => call("preview_view", { id, original, view }),
  objectDdl: (id, kind, schema, name) => call("object_ddl", { id, kind, schema, name }),
  previewCreateDatabase: (id, database) => call("preview_create_database", { id, database }),
  previewRenameDatabase: (id, from, to) => call("preview_rename_database", { id, from, to }),
  previewDropDatabase: (id, name) => call("preview_drop_database", { id, name }),
  exportDatabase: (id, options) => call("export_database", { id, options }),
  exportData: (id, options) => call("export_data", { id, options }),
  importSql: (id, options, confirmed) => call("import_sql", { id, options, confirmed }),
  inspectImportFile: (id, file) => call("inspect_import_file", { id, file }),
  importData: (id, options, confirmed) => call("import_data", { id, options, confirmed }),
  cancelJob: (jobId) => call("cancel_job", { jobId }),
  onJobProgress: (cb) => listen<JobProgress>("job-progress", (e) => cb(e.payload)),
  onJobDone: (cb) => listen<JobDone>("job-done", (e) => cb(e.payload)),
  aiKeyStatus: () => call("ai_key_status"),
  aiSetKey: (provider, key) => call("ai_set_key", { provider, key }),
  aiListModels: (provider, key) => call("ai_list_models", { provider, key: key ?? null }),
  agentSend: (id, provider, model, text) => call("agent_send", { id, provider, model, text }),
  agentDecide: (actionId, decision) => call("agent_decide", { actionId, decision }),
  agentStop: (id) => call("agent_stop", { id }),
  agentHistory: (id) => call("agent_history", { id }),
  agentClear: (id) => call("agent_clear", { id }),
  agentAudit: (id, limit) => call("agent_audit", { id, limit }),
  onAgentEvent: (cb) => listen<AgentEvent>("agent-event", (e) => cb(e.payload)),
  readTextFile: (path) => call("read_text_file", { path }),
  writeTextFile: (path, contents) => call("write_text_file", { path, contents }),
  writeBase64File: (path, data) => call("write_base64_file", { path, data }),
  kvScan: (id, cursor, pattern, typeFilter, hasTtl, count) => call("kv_scan", { id, cursor, pattern, typeFilter, hasTtl, count }),
  kvGet: (id, key) => call("kv_get", { id, key }),
  kvEdit: (id, edit, confirmed) => call("kv_edit", { id, edit, confirmed }),
  kvCommand: (id, line, confirmed) => call("kv_command", { id, line, confirmed }),
  kvInfo: (id) => call("kv_info", { id }),
  kvMemory: (id) => call("kv_memory", { id }),
};

// Development in a plain browser uses the mock; production builds drop it (import.meta.env.DEV is false there).
export const api: Api = !import.meta.env.DEV || isTauri ? real : mockApi;
