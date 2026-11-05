import type { Connection, SchemaNode, Tab, TabKind } from "../types";
import { redisDb, redisTab } from "../components/shell/tree";

export type DialogKind = "connection" | "export" | "import" | "importSql" | "exportData" | "settings";

/** What a transfer dialog is about (set by the place it was opened from). */
export interface DialogContext {
  /** PostgreSQL database of a multi-database connection (→ scopedId). */
  database?: string;
  schema?: string;
  table?: string;
  /** exportData from a result grid: the query to export. */
  sql?: string;
  /** settings: section to open on. */
  section?: "ai";
}

export type TreeState =
  | { status: "loading" }
  | { status: "ready"; nodes: SchemaNode[] }
  | { status: "error"; message: string };

export interface Toast {
  id: number;
  text: string;
}

export interface AppState {
  connections: Connection[];
  activeConnectionId: string;
  tabs: Tab[];
  activeTabId: string | null;
  sidebarOpen: boolean;
  dialog: DialogKind | null;
  /** Connection being edited in the connection dialog; null = new connection. */
  editingConnectionId: string | null;
  dialogContext: DialogContext | null;
  /** Navigator trees per connected connection. */
  trees: Record<string, TreeState>;
  paletteOpen: boolean;
  agentOpen: boolean;
  /** Agent panel fills the window (navigator and tabs hidden, still mounted). */
  agentMaximized: boolean;
  /** Tab waiting for a "discard changes?" answer. */
  /** Tabs waiting for a "discard changes?" answer (one or more, from Close / Close others / Close all). */
  confirmCloseIds: string[] | null;
  toasts: Toast[];
}

export type Action =
  | { type: "openTab"; kind: TabKind; connectionId: string; title: string; target?: string; database?: string; filePath?: string; filter?: string }
  /** A SQL tab was saved to a (new) file. */
  | { type: "setTabFile"; id: string; filePath: string; title: string }
  | { type: "focusTab"; id: string }
  | { type: "closeTab"; id: string; force?: boolean }
  /** Close several tabs; asks once when any of them has unsaved changes (force skips the question). */
  | { type: "closeTabs"; ids: string[]; force?: boolean }
  | { type: "cancelClose" }
  | { type: "setDirty"; id: string; dirty: boolean }
  | { type: "setTabDatabase"; id: string; database: string }
  /** Reopen tabs saved from the last session (startup, after connections are loaded). */
  | { type: "restoreTabs"; tabs: Tab[]; activeTabId: string | null; activeConnectionId?: string | null }
  | { type: "toggleSidebar" }
  | { type: "setActiveConnection"; id: string }
  | { type: "toggleConnected"; id: string }
  | { type: "addConnection"; connection: Connection }
  | { type: "setConnections"; connections: Connection[] }
  | { type: "removeConnection"; id: string }
  | { type: "setConnected"; id: string; connected: boolean; serverVersion?: string }
  | { type: "setTree"; id: string; tree: TreeState | null }
  /** Replaces a lazy database node (same id) with its loaded version. */
  | { type: "setDatabaseNode"; id: string; node: SchemaNode }
  | { type: "openDialog"; dialog: DialogKind; connectionId?: string; context?: DialogContext }
  | { type: "closeDialog" }
  | { type: "setPalette"; open: boolean }
  | { type: "toggleAgent" }
  | { type: "toggleAgentMaximized" }
  | { type: "toast"; text: string; id: number }
  | { type: "dismissToast"; id: number };

let seq = 0;
const newId = (kind: string) => `${kind}-${Date.now().toString(36)}-${seq++}`;

function closeTabs(s: AppState, ids: string[], force?: boolean): AppState {
  const drop = new Set(ids.filter((id) => s.tabs.some((t) => t.id === id)));
  if (!drop.size) return s;
  if (!force && s.tabs.some((t) => drop.has(t.id) && t.dirty)) return { ...s, confirmCloseIds: [...drop] };
  const tabs = s.tabs.filter((t) => !drop.has(t.id));
  // Keep the active tab; if it closed, take the nearest remaining tab to its right, else to its left.
  const at = s.tabs.findIndex((t) => t.id === s.activeTabId);
  const next =
    tabs.find((t) => t.id === s.activeTabId) ??
    s.tabs.slice(at + 1).find((t) => !drop.has(t.id)) ??
    s.tabs.slice(0, Math.max(at, 0)).reverse().find((t) => !drop.has(t.id)) ??
    null;
  return {
    ...s,
    tabs,
    activeTabId: next ? next.id : null,
    activeConnectionId: next ? next.connectionId : s.activeConnectionId,
    confirmCloseIds: null,
  };
}

export function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case "openTab": {
      // Every tab belongs to a connection; with none yet, ask the user to create one.
      const conn = s.connections.find((c) => c.id === a.connectionId);
      if (!conn) return { ...s, dialog: "connection", editingConnectionId: null, paletteOpen: false };
      // Redis has no SQL: "new SQL editor" (⌘T, +, palette, agent) opens its console instead.
      if (a.kind === "sql" && conn.driver === "redis") return reducer(s, redisTab("console", conn.id, a.database ?? redisDb(conn)));
      // SQL editors are always new (unless the same file is already open); other kinds reuse an existing tab for the same object.
      const sameFile = a.filePath && s.tabs.find((t) => t.filePath === a.filePath);
      if (sameFile) return { ...s, activeTabId: sameFile.id, activeConnectionId: sameFile.connectionId };
      const existing =
        a.kind !== "sql" &&
        s.tabs.find(
          (t) =>
            t.kind === a.kind && t.connectionId === a.connectionId && t.target === a.target && t.database === a.database && t.filter === a.filter,
        );
      if (existing) return { ...s, activeTabId: existing.id, activeConnectionId: a.connectionId };
      // A new SQL editor without a database of its own runs in the connection's default database.
      const database = a.database ?? (a.kind === "sql" ? conn.defaultDatabase : undefined);
      const tab: Tab = { id: newId(a.kind), kind: a.kind, title: a.title, connectionId: a.connectionId, target: a.target, database, filePath: a.filePath, filter: a.filter };
      return { ...s, tabs: [...s.tabs, tab], activeTabId: tab.id, activeConnectionId: a.connectionId };
    }
    case "focusTab": {
      const tab = s.tabs.find((t) => t.id === a.id);
      return tab ? { ...s, activeTabId: tab.id, activeConnectionId: tab.connectionId } : s;
    }
    case "closeTab":
      return closeTabs(s, [a.id], a.force);
    case "closeTabs":
      return closeTabs(s, a.ids, a.force);
    case "cancelClose":
      return { ...s, confirmCloseIds: null };
    case "setDirty":
      return { ...s, tabs: s.tabs.map((t) => (t.id === a.id && !!t.dirty !== a.dirty ? { ...t, dirty: a.dirty } : t)) };
    case "toggleSidebar":
      return { ...s, sidebarOpen: !s.sidebarOpen };
    case "setActiveConnection":
      return { ...s, activeConnectionId: a.id };
    case "toggleConnected":
      return { ...s, connections: s.connections.map((c) => (c.id === a.id ? { ...c, connected: !c.connected } : c)) };
    case "addConnection": {
      // Upsert: editing keeps the runtime connected state of the existing entry.
      const old = s.connections.find((c) => c.id === a.connection.id);
      const merged = old ? { ...a.connection, connected: old.connected, serverVersion: old.serverVersion } : a.connection;
      const connections = old ? s.connections.map((c) => (c.id === merged.id ? merged : c)) : [...s.connections, merged];
      return { ...s, connections, activeConnectionId: merged.id, dialog: null, editingConnectionId: null };
    }
    case "setConnections":
      return {
        ...s,
        connections: a.connections,
        activeConnectionId: a.connections.some((c) => c.id === s.activeConnectionId)
          ? s.activeConnectionId
          : (a.connections[0]?.id ?? ""),
      };
    case "removeConnection": {
      const connections = s.connections.filter((c) => c.id !== a.id);
      const tabs = s.tabs.filter((t) => t.connectionId !== a.id);
      const { [a.id]: _gone, ...trees } = s.trees;
      return {
        ...s,
        connections,
        tabs,
        trees,
        activeTabId: tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : (tabs.at(-1)?.id ?? null),
        activeConnectionId: s.activeConnectionId === a.id ? (connections[0]?.id ?? "") : s.activeConnectionId,
      };
    }
    case "setConnected":
      return {
        ...s,
        connections: s.connections.map((c) =>
          c.id === a.id ? { ...c, connected: a.connected, serverVersion: a.serverVersion ?? c.serverVersion } : c,
        ),
      };
    case "setTree": {
      const { [a.id]: _old, ...rest } = s.trees;
      return { ...s, trees: a.tree ? { ...rest, [a.id]: a.tree } : rest };
    }
    case "setTabFile":
      return { ...s, tabs: s.tabs.map((t) => (t.id === a.id ? { ...t, filePath: a.filePath, title: a.title } : t)) };
    case "restoreTabs": {
      const tabs = [...a.tabs.filter((t) => !s.tabs.some((x) => x.id === t.id)), ...s.tabs];
      const active = s.activeTabId ?? a.activeTabId;
      const tab = tabs.find((t) => t.id === active);
      const savedConn = s.connections.some((c) => c.id === a.activeConnectionId) ? a.activeConnectionId! : s.activeConnectionId;
      return { ...s, tabs, activeTabId: tab?.id ?? null, activeConnectionId: tab?.connectionId ?? savedConn };
    }
    case "setTabDatabase":
      return { ...s, tabs: s.tabs.map((t) => (t.id === a.id ? { ...t, database: a.database } : t)) };
    case "setDatabaseNode": {
      const tree = s.trees[a.id];
      if (tree?.status !== "ready") return s;
      const nodes = tree.nodes.map((n) => (n.id === a.node.id ? a.node : n));
      return { ...s, trees: { ...s.trees, [a.id]: { status: "ready", nodes } } };
    }
    case "openDialog":
      return { ...s, dialog: a.dialog, editingConnectionId: a.connectionId ?? null, dialogContext: a.context ?? null, paletteOpen: false };
    case "closeDialog":
      return { ...s, dialog: null, editingConnectionId: null, dialogContext: null };
    case "setPalette":
      return { ...s, paletteOpen: a.open };
    case "toggleAgent":
      return { ...s, agentOpen: !s.agentOpen, agentMaximized: s.agentOpen ? false : s.agentMaximized };
    case "toggleAgentMaximized":
      return { ...s, agentMaximized: !s.agentMaximized };
    case "toast":
      return { ...s, toasts: [...s.toasts, { id: a.id, text: a.text }] };
    case "dismissToast":
      return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) };
  }
}
