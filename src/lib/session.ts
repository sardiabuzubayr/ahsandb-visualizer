// Open tabs (SQL text included), the active connection and which connections were connected survive an app
// restart (per user, in the webview's localStorage).
import type { Tab } from "../types";

const TABS = "session.sqlTabs"; // key kept from when only SQL tabs were saved
const sqlKey = (tabId: string) => `session.sql.${tabId}`;
// Object editors hold unsaved drafts that can't be rebuilt, so only these come back.
const RESTORED: Tab["kind"][] = ["sql", "table", "er"];

export interface Saved {
  tabs: Tab[];
  activeTabId: string | null;
  activeConnectionId: string | null;
  /** Connections that were connected at the last save, to reconnect on startup. */
  connected: string[];
}

function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v === null ? null : (JSON.parse(v) as T);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / blocked storage: the session just isn't restored.
  }
}

/** Tabs to reopen and connections to reconnect, limited to connections that still exist. */
export function loadSession(connectionIds: string[]): Saved {
  const saved = read<Partial<Saved>>(TABS);
  const exists = (id: string | null | undefined): id is string => !!id && connectionIds.includes(id);
  const tabs = (saved?.tabs ?? []).filter((t) => RESTORED.includes(t.kind) && exists(t.connectionId)).map((t) => ({ ...t, dirty: false }));
  // Text of tabs that were closed (or whose connection is gone) is dropped.
  try {
    const keep = new Set(tabs.map((t) => sqlKey(t.id)));
    const all = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
    for (const k of all) if (k.startsWith("session.sql.") && !keep.has(k)) localStorage.removeItem(k);
  } catch {
    // nothing to prune
  }
  const activeTabId = tabs.find((t) => t.id === saved?.activeTabId)?.id ?? tabs.at(-1)?.id ?? null;
  return {
    tabs,
    activeTabId,
    activeConnectionId: exists(saved?.activeConnectionId) ? saved.activeConnectionId : null,
    connected: (saved?.connected ?? []).filter(exists),
  };
}

export function saveSession({ tabs, activeTabId, activeConnectionId, connected }: Saved) {
  const kept = tabs.filter((t) => RESTORED.includes(t.kind)).map(({ dirty: _d, ...t }) => t);
  write(TABS, { tabs: kept, activeTabId: kept.some((t) => t.id === activeTabId) ? activeTabId : null, activeConnectionId, connected });
}

export const loadSql = (tabId: string) => read<string>(sqlKey(tabId));
export const saveSql = (tabId: string, text: string) => write(sqlKey(tabId), text || null);
