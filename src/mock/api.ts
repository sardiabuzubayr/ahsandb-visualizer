// Browser-only stand-in for the Tauri backend (`npm run dev` in a plain browser): UI work, screenshots and
// demos without a database. Only referenced in development builds, so it never ships in the app.
import { ApiError, type Api } from "../lib/api";
import { mockConnections, mockSchemaTree } from "./connections";
import { mockCommand, mockEdit, mockGet, mockInfo, mockScan } from "./redis";
import { mockAgentMessages } from "./agent";
import { analystPrivileges, erDraftSql, erRelations, erTables, mockRoles, mockRoutine, mockTrigger, mockView } from "./objects";
import { mockResults } from "./results";
import { ordersColumns, ordersRows } from "./tableData";
import type {
  AgentDecision,
  AgentEvent,
  AgentEventBody,
  AgentMessage,
  AiModel,
  AiProvider,
  JobDone,
  JobProgress,
  Preview,
} from "../types";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VERSIONS = { postgres: "PostgreSQL 16.4", mysql: "MySQL 8.4", mariadb: "MariaDB 11.4", sqlite: "SQLite 3.46", redis: "Redis 7.2.4" };

// mock: browser-only stand-ins built from the fixtures in src/mock/.
export const mockApi: Api = {
  listConnections: async () => mockConnections,
  saveConnection: async (c) => ({ ...c, id: c.id || `${c.name}-${Date.now().toString(36)}` }),
  deleteConnection: async () => {},
  testConnection: async (c) => (await wait(600), { serverVersion: VERSIONS[c.driver], elapsedMs: 182 }),
  testSsh: async (c) => (await wait(500), { elapsedMs: 96, target: `${c.host || "127.0.0.1"}:${c.port ?? 5432}`, targetReachable: true }),
  connect: async (id) => ({ serverVersion: mockConnections.find((c) => c.id === id)?.serverVersion ?? "PostgreSQL 16.4" }),
  disconnect: async () => {},
  schemaTree: async (id) => mockSchemaTree(id),
  tableColumns: async () => ordersColumns,
  erModel: async () => ({
    tables: erTables.filter((t) => !t.draft).map(({ name, rows, columns }) => ({ name, rows, columns: columns.filter((c) => !c.draft) })),
    relations: erRelations.filter((r) => !r.draft),
  }),
  completionSchema: async () => Object.fromEntries(erTables.map((t) => [t.name, t.columns.map((c) => c.name)])),
  execute: async () => (
    await wait(400),
    mockResults.map((r) => ({ sql: r.label, columns: r.columns, rows: r.rows, elapsedMs: r.elapsedMs, affected: r.affected, truncated: false }))
  ),
  cancel: async () => {},
  fetchMore: async (_id, sql, _runId, maxRows) => {
    await wait(300);
    const r = mockResults[0];
    const rows = Array.from({ length: Math.min(maxRows, 450) }, (_, i) => r.rows[i % r.rows.length]);
    return { sql, columns: r.columns, rows, elapsedMs: 40, truncated: maxRows < 450 };
  },
  tablePage: async () => ({ columns: ordersColumns, rows: ordersRows, hasMore: false }),
  history: async () => [],
  createSqliteFile: async () => {},
  trustHostKey: async () => {},
  forgetHostKey: async () => {},
  onConnectionLost: async () => () => {},
  loadTable: async (_id, schema, table) => {
    const t = erTables.find((x) => x.name === table) ?? erTables[1];
    return {
      schema,
      name: t.name,
      columns: t.columns.filter((c) => !c.draft).map((c) => ({ name: c.name, originalName: c.name, type: c.type, nullable: !c.pk, autoIncrement: !!c.pk && c.type === "bigserial" })),
      primaryKey: t.columns.filter((c) => c.pk).map((c) => c.name),
      foreignKeys: erRelations
        .filter((r) => r.from === t.name)
        .map((r) => ({ columns: [r.fromColumn], refTable: r.to, refColumns: [r.toColumn] })),
      indexes: [],
      checks: [],
    };
  },
  previewSchemaChanges: async () => mockPreview(erDraftSql.split(/;\n+/).filter((x) => /\w/.test(x) && !/^(BEGIN|COMMIT)$/.test(x.trim()))),
  previewRowChanges: async (_id, _schema, table, changes) => mockPreview(changes.map((c) => `-- ${c.kind} ${table}`)),
  previewDrop: async (_id, kind, schema, name) => ({ ...mockPreview([`DROP ${kind.toUpperCase()} ${schema}.${name}`]), destructive: true }),
  loadRoutine: async () => mockRoutine,
  previewRoutine: async (_id, _o, r) => mockPreview([`CREATE OR REPLACE PROCEDURE ${r.database}.${r.name}(…)`]),
  runRoutine: async () => (
    await wait(400),
    [{ sql: "CALL close_daily_orders(…)", columns: [{ name: "p_closed", type: "int", numeric: true }], rows: [[37]], elapsedMs: 12, truncated: false }]
  ),
  loadRoles: async () => mockRoles,
  loadPrivileges: async () => analystPrivileges,
  previewRole: async () => mockPreview(["GRANT SELECT ON public.payments TO analyst", "REVOKE UPDATE ON public.orders FROM analyst"]),
  applyPreview: async () => (await wait(300), { executed: 1, rolledBack: false }),
  loadTrigger: async (_id, schema, name) => ({ ...mockTrigger, schema, name }),
  previewTrigger: async (_id, o, t) =>
    t
      ? mockPreview([...(o ? [`DROP TRIGGER IF EXISTS ${o.name} ON ${o.schema}.${o.table}`] : []), `CREATE TRIGGER ${t.name} …`])
      : { ...mockPreview([`DROP TRIGGER ${o?.name} ON ${o?.schema}.${o?.table}`]), destructive: true },
  loadView: async (_id, schema, name) => ({ ...mockView, schema, name }),
  previewView: async (_id, _o, v) => mockPreview([`CREATE OR REPLACE VIEW ${v.schema}.${v.name} AS\n${v.query}`]),
  objectDdl: async (_id, kind, schema, name) =>
    kind === "sequence"
      ? `CREATE SEQUENCE ${schema}.${name}\n  INCREMENT BY 1 MINVALUE 1 START WITH 1 CACHE 1;\n-- SELECT setval('${schema}.${name}', 1042);`
      : `CREATE EVENT \`${name}\` ON SCHEDULE EVERY 1 DAY DO DELETE FROM sessions WHERE expires_at < NOW();`,
  previewCreateDatabase: async (_id, d) => ({ ...mockPreview([`CREATE DATABASE "${d.name}"`]), transactional: false }),
  previewRenameDatabase: async (_id, from, to) => ({ ...mockPreview([`ALTER DATABASE "${from}" RENAME TO "${to}"`]), transactional: false }),
  previewDropDatabase: async (_id, name) => ({
    ...mockPreview([`DROP DATABASE "${name}"`]),
    transactional: false,
    destructive: true,
    warnings: ["Dropping a database deletes all of its data permanently and can't be undone."],
  }),
  exportDatabase: async (_id, o) => mockJob(`${o.objects.length || 12} objects`, 40, o.path),
  exportData: async (_id, o) => mockJob(o.source.kind === "table" ? o.source.table : "query", 1240, o.path),
  importSql: async (_id, o) => mockJob("statements", 86, o.path),
  inspectImportFile: async (_id, f) => ({
    columns: ["name", "email", "city", "joined"],
    rows: [
      ["PT Sinar Jaya Abadi", "halo@sinarjaya.example", "Jakarta", "2024-03-12"],
      ["CV Maju Bersama", "admin@majubersama.example", "Bandung", "2024-05-02"],
      ["Toko Mekar Sari", null, "Surabaya", "2025-01-20"],
    ],
    totalRows: f.format === "json" ? 120 : 2480,
    types: ["text", "text", "text", "date"],
  }),
  importData: async (_id, o) => mockJob(`${o.schema}.${o.table}`, 2480, o.file.path),
  cancelJob: async (jobId) => void mockCancelled.add(jobId),
  onJobProgress: async (cb) => (mockProgressListeners.add(cb), () => void mockProgressListeners.delete(cb)),
  onJobDone: async (cb) => (mockDoneListeners.add(cb), () => void mockDoneListeners.delete(cb)),
  aiKeyStatus: async () => [...mockKeys],
  aiSetKey: async (p, key) => void (key ? mockKeys.add(p) : mockKeys.delete(p)),
  aiListModels: async (p, key) => {
    await wait(500);
    if (key === "bad") throw new ApiError("auth", "Invalid API key");
    return MOCK_MODELS[p];
  },
  agentSend: async (id, _p, _m, text) => mockAgentTurn(id.split("@")[0], text),
  agentDecide: async (actionId, d) => mockAgentDecide(actionId, d),
  agentStop: async (id) => mockAgentEmit(id.split("@")[0], { type: "status", running: false }),
  agentHistory: async () => mockAgentMessages,
  agentClear: async () => {},
  agentAudit: async () => [
    { at: "2026-10-30T09:12:00Z", provider: "anthropic", model: "claude-opus-5-5", level: "read", sql: "SELECT count(*) FROM orders", decision: "auto", outcome: "ok · 1 row" },
    { at: "2026-10-30T09:13:10Z", provider: "anthropic", model: "claude-opus-5-5", level: "critical", sql: "DELETE FROM sessions WHERE expires_at < now()", decision: "approved", outcome: "ok · 412 rows" },
  ],
  onAgentEvent: async (cb) => (mockAgentListeners.add(cb), () => void mockAgentListeners.delete(cb)),
  readTextFile: async (path) => mockFiles.get(path) ?? "-- Opened from " + path + "\nSELECT * FROM orders LIMIT 100;\n",
  writeTextFile: async (path, contents) => void mockFiles.set(path, contents),
  writeBase64File: async (path, data) => void mockFiles.set(path, data),
  kvScan: async (id, _cursor, pattern, typeFilter, hasTtl) => (await wait(150), mockScan(id, pattern, typeFilter, hasTtl)),
  kvGet: async (id, key) => (await wait(80), mockGet(id, key)),
  kvEdit: async (id, edit) => (await wait(80), mockEdit(id, edit)),
  kvCommand: async (id, line) => (await wait(60), mockCommand(id, line)),
  kvInfo: async () => (await wait(120), mockInfo),
  kvMemory: async () => 4_194_304,
};

// mock: files "saved" during a browser session.
const mockFiles = new Map<string, string>();

// mock: Anthropic + OpenAI "have keys"; a turn answers in text, or proposes a DELETE when asked to delete.
const mockKeys = new Set<AiProvider>(["anthropic", "openai"]);
const MOCK_MODELS: Record<AiProvider, AiModel[]> = {
  anthropic: [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  ],
  openai: [{ id: "gpt-5", name: "gpt-5" }],
  gemini: [{ id: "gemini-2.5-pro", name: "gemini-2.5-pro" }],
  openrouter: [{ id: "anthropic/claude-opus-5-5", name: "Anthropic: Claude Opus 5.5" }],
  deepseek: [{ id: "deepseek-chat", name: "deepseek-chat" }],
};
const mockAgentListeners = new Set<(e: AgentEvent) => void>();
const mockAgentEmit = (connId: string, e: AgentEventBody) => mockAgentListeners.forEach((cb) => cb({ connId, ...e }));
const mockPending = new Map<string, { connId: string; message: Extract<AgentMessage, { role: "action" }> }>();
async function mockAgentTurn(connId: string, text: string) {
  const say = (message: AgentMessage) => mockAgentEmit(connId, { type: "message", message });
  say({ id: `u${Date.now()}`, role: "user", text });
  mockAgentEmit(connId, { type: "status", running: true });
  await wait(600);
  if (/delete|hapus/i.test(text)) {
    const message: Extract<AgentMessage, { role: "action" }> = {
      id: `act${Date.now()}`,
      role: "action",
      level: "critical",
      title: "Delete expired sessions",
      sql: "DELETE FROM sessions WHERE expires_at < now()",
      status: "pending",
      impact: ["Removes expired login sessions; active users stay signed in."],
      facts: ["412 rows will be deleted (counted just now)", "No foreign keys reference sessions", "Cannot be undone after commit"],
      confirmName: undefined,
    };
    mockPending.set(message.id, { connId, message });
    say({ id: `a${Date.now()}`, role: "agent", text: "I counted the expired sessions first. Approve the delete below if it looks right.", steps: [{ label: "Counting rows", detail: "SELECT count(*) FROM sessions WHERE expires_at < now()" }] });
    say(message);
  } else {
    say({ id: `a${Date.now()}`, role: "agent", text: "There are 1,240 orders this month; 38 are still pending.", steps: [{ label: "Running query", detail: "SELECT status, count(*) FROM orders GROUP BY status" }] });
  }
  mockAgentEmit(connId, { type: "status", running: false });
}
async function mockAgentDecide(actionId: string, d: AgentDecision) {
  const p = mockPending.get(actionId);
  if (!p) throw new ApiError("notFound", "This action is no longer pending");
  mockPending.delete(actionId);
  const done: AgentMessage =
    d.kind === "approve"
      ? { ...p.message, status: "done", elapsedMs: 14, outcome: "412 rows affected" }
      : { ...p.message, status: d.kind === "edit" ? "superseded" : "rejected" };
  mockAgentEmit(p.connId, { type: "message", message: done });
  if (d.kind === "reject") mockAgentEmit(p.connId, { type: "message", message: { id: `a${Date.now()}`, role: "agent", text: "Okay, I won't delete anything. What would you like instead?", steps: [] } });
}

// mock: jobs tick to `total` over ~2 s and report success (or cancelled).
const mockProgressListeners = new Set<(p: JobProgress) => void>();
const mockDoneListeners = new Set<(d: JobDone) => void>();
const mockCancelled = new Set<string>();
function mockJob(message: string, total: number, path: string): string {
  const jobId = `job-${Date.now().toString(36)}`;
  let done = 0;
  const timer = setInterval(() => {
    const cancelled = mockCancelled.has(jobId);
    done = Math.min(total, done + Math.ceil(total / 20));
    if (!cancelled) mockProgressListeners.forEach((cb) => cb({ jobId, done, total, message }));
    if (done < total && !cancelled) return;
    clearInterval(timer);
    const result: JobDone = { jobId, ok: !cancelled, cancelled, succeeded: done, failed: 0, errors: [], message: path };
    mockDoneListeners.forEach((cb) => cb(result));
  }, 100);
  return jobId;
}

function mockPreview(statements: string[]): Preview {
  return { id: `mock-${Date.now()}`, statements, transactional: true, destructive: false, warnings: [] };
}
