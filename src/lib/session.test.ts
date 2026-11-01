import { beforeEach, expect, test } from "vitest";
import { loadSession, loadSql, saveSession, saveSql } from "./session";
import type { Tab } from "../types";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
});

const tab = (id: string, kind: Tab["kind"], connectionId = "c1"): Tab => ({ id, kind, title: `${id}.sql`, connectionId });

test("SQL, table and ER tabs of existing connections come back; editors don't; closed tabs' text is pruned", () => {
  const session = (tabs: Tab[], activeTabId: string) => ({ tabs, activeTabId, activeConnectionId: "c1", connected: ["c1", "gone"] });
  saveSession(session([tab("a", "sql"), tab("b", "table"), tab("e", "er"), tab("r", "routine"), tab("c", "sql", "gone"), { ...tab("d", "sql"), dirty: true }], "d"));
  saveSql("a", "SELECT 1");
  saveSql("old", "SELECT 2");
  const s = loadSession(["c1"]);
  expect(s.tabs.map((t) => t.id)).toEqual(["a", "b", "e", "d"]);
  expect(s.tabs[3].dirty).toBe(false);
  expect(s.activeTabId).toBe("d");
  expect(s.activeConnectionId).toBe("c1");
  expect(s.connected).toEqual(["c1"]);
  expect(loadSql("a")).toBe("SELECT 1");
  expect(loadSql("old")).toBeNull();
});

test("a session saved before connections were tracked still loads", () => {
  store.set("session.sqlTabs", JSON.stringify({ tabs: [tab("a", "sql")], activeTabId: "a" }));
  expect(loadSession(["c1"])).toEqual({ tabs: [{ ...tab("a", "sql"), dirty: false }], activeTabId: "a", activeConnectionId: null, connected: [] });
});

test("empty text removes the stored entry", () => {
  saveSql("a", "x");
  saveSql("a", "");
  expect(loadSql("a")).toBeNull();
});
