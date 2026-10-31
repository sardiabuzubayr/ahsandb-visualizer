// Open SQL tabs and their text survive an app restart (per user, in the webview's localStorage).
import type { Tab } from "../types";

const TABS = "session.sqlTabs";
const sqlKey = (tabId: string) => `session.sql.${tabId}`;

interface Saved {
  tabs: Tab[];
  activeTabId: string | null;
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

/** SQL tabs to reopen, limited to connections that still exist. */
export function loadSession(connectionIds: string[]): Saved {
  const saved = read<Saved>(TABS);
  const tabs = (saved?.tabs ?? []).filter((t) => t.kind === "sql" && connectionIds.includes(t.connectionId)).map((t) => ({ ...t, dirty: false }));
  // Text of tabs that were closed (or whose connection is gone) is dropped.
  try {
    const keep = new Set(tabs.map((t) => sqlKey(t.id)));
    const all = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
    for (const k of all) if (k.startsWith("session.sql.") && !keep.has(k)) localStorage.removeItem(k);
  } catch {
    // nothing to prune
  }
  const activeTabId = tabs.some((t) => t.id === saved?.activeTabId) ? saved!.activeTabId : (tabs.at(-1)?.id ?? null);
  return { tabs, activeTabId };
}

export function saveSession(tabs: Tab[], activeTabId: string | null) {
  const sql = tabs.filter((t) => t.kind === "sql").map(({ dirty: _d, ...t }) => t);
  write(TABS, { tabs: sql, activeTabId: sql.some((t) => t.id === activeTabId) ? activeTabId : null });
}

export const loadSql = (tabId: string) => read<string>(sqlKey(tabId));
export const saveSql = (tabId: string, text: string) => write(sqlKey(tabId), text || null);
