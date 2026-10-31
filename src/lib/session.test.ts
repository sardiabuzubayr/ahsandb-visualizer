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

test("only SQL tabs of existing connections come back, with their text; closed tabs' text is pruned", () => {
  saveSession([tab("a", "sql"), tab("b", "table"), tab("c", "sql", "gone"), { ...tab("d", "sql"), dirty: true }], "d");
  saveSql("a", "SELECT 1");
  saveSql("old", "SELECT 2");
  const s = loadSession(["c1"]);
  expect(s.tabs.map((t) => t.id)).toEqual(["a", "d"]);
  expect(s.tabs[1].dirty).toBe(false);
  expect(s.activeTabId).toBe("d");
  expect(loadSql("a")).toBe("SELECT 1");
  expect(loadSql("old")).toBeNull();
});

test("empty text removes the stored entry", () => {
  saveSql("a", "x");
  saveSql("a", "");
  expect(loadSql("a")).toBeNull();
});
