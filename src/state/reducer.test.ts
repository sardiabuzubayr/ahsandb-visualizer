import { expect, test } from "vitest";
import { initialState } from "./app";
import { reducer, type AppState } from "./reducer";

const base = { ...initialState, tabs: initialState.tabs.map((t) => ({ ...t, dirty: false })) };

test("opening a table tab twice focuses the existing one", () => {
  const s1 = reducer(base, { type: "openTab", kind: "table", connectionId: "orders-prod", title: "orders", target: "orders" });
  expect(s1.tabs).toHaveLength(base.tabs.length);
  expect(s1.activeTabId).toBe("t-orders");
});

test("SQL tabs are always new", () => {
  const s1 = reducer(base, { type: "openTab", kind: "sql", connectionId: "orders-prod", title: "q.sql" });
  expect(s1.tabs).toHaveLength(base.tabs.length + 1);
  expect(s1.activeTabId).toBe(s1.tabs.at(-1)!.id);
});

test("closing a dirty tab asks first; force closes it", () => {
  const dirty = reducer(base, { type: "setDirty", id: "t-orders", dirty: true });
  const asked = reducer(dirty, { type: "closeTab", id: "t-orders" });
  expect(asked.confirmCloseIds).toEqual(["t-orders"]);
  expect(asked.tabs).toHaveLength(base.tabs.length);
  const closed = reducer(asked, { type: "closeTab", id: "t-orders", force: true });
  expect(closed.tabs.find((t) => t.id === "t-orders")).toBeUndefined();
  expect(closed.confirmCloseIds).toBeNull();
});

test("close others keeps the chosen tab and focuses it; close all leaves none", () => {
  const others = reducer(base, { type: "closeTabs", ids: base.tabs.filter((t) => t.id !== "t-er").map((t) => t.id) });
  expect(others.tabs.map((t) => t.id)).toEqual(["t-er"]);
  expect(others.activeTabId).toBe("t-er");
  const all = reducer(base, { type: "closeTabs", ids: base.tabs.map((t) => t.id) });
  expect(all.tabs).toHaveLength(0);
  expect(all.activeTabId).toBeNull();
});

test("closing several tabs asks once when any is dirty; force closes them all", () => {
  const dirty = reducer(base, { type: "setDirty", id: "t-orders", dirty: true });
  const ids = base.tabs.map((t) => t.id);
  const asked = reducer(dirty, { type: "closeTabs", ids });
  expect(asked.tabs).toHaveLength(base.tabs.length);
  expect(asked.confirmCloseIds).toEqual(ids);
  const closed = reducer(asked, { type: "closeTabs", ids: asked.confirmCloseIds!, force: true });
  expect(closed.tabs).toHaveLength(0);
  expect(closed.confirmCloseIds).toBeNull();
});

test("closing the active tab focuses a neighbour, closing the last leaves none", () => {
  let s = reducer(base, { type: "closeTab", id: "t-sql" });
  expect(s.activeTabId).toBe("t-orders");
  for (const t of s.tabs) s = reducer(s, { type: "closeTab", id: t.id });
  expect(s.tabs).toHaveLength(0);
  expect(s.activeTabId).toBeNull();
});

test("removeConnection drops its tabs and tree and picks another active connection", () => {
  const withTree = reducer(base, { type: "setTree", id: "orders-prod", tree: { status: "loading" } });
  const s = reducer(withTree, { type: "removeConnection", id: "orders-prod" });
  expect(s.connections.find((c) => c.id === "orders-prod")).toBeUndefined();
  expect(s.tabs.every((t) => t.connectionId !== "orders-prod")).toBe(true);
  expect(s.trees["orders-prod"]).toBeUndefined();
  expect(s.activeConnectionId).not.toBe("orders-prod");
});

test("addConnection upserts and keeps the runtime connected flag when editing", () => {
  const edited = { ...base.connections[0], name: "renamed", connected: false };
  const s = reducer(base, { type: "addConnection", connection: edited });
  expect(s.connections).toHaveLength(base.connections.length);
  expect(s.connections[0].name).toBe("renamed");
  expect(s.connections[0].connected).toBe(true);
});

test("opening a tab without a known connection opens the New connection dialog instead", () => {
  const empty = { ...base, connections: [], activeConnectionId: "" };
  const s = reducer(empty, { type: "openTab", kind: "sql", connectionId: "", title: "q.sql" });
  expect(s.tabs).toHaveLength(empty.tabs.length);
  expect(s.dialog).toBe("connection");
});

test("restoreTabs reopens saved tabs before any opened since, and focuses the saved active one", () => {
  const empty = { ...base, tabs: [], activeTabId: null };
  const saved = [{ id: "sql-1", kind: "sql" as const, title: "a.sql", connectionId: "orders-staging" }];
  const s = reducer(empty, { type: "restoreTabs", tabs: saved, activeTabId: "sql-1" });
  expect(s.tabs.map((t) => t.id)).toEqual(["sql-1"]);
  expect(s.activeTabId).toBe("sql-1");
  expect(s.activeConnectionId).toBe("orders-staging");
});

test("restoreTabs without tabs focuses the saved connection if it still exists", () => {
  const empty = { ...base, tabs: [], activeTabId: null };
  expect(reducer(empty, { type: "restoreTabs", tabs: [], activeTabId: null, activeConnectionId: "orders-staging" }).activeConnectionId).toBe("orders-staging");
  expect(reducer(empty, { type: "restoreTabs", tabs: [], activeTabId: null, activeConnectionId: "gone" }).activeConnectionId).toBe(base.activeConnectionId);
});

test("opening the same .sql file again focuses its tab; Save as renames the tab", () => {
  const open = { type: "openTab", kind: "sql", connectionId: "orders-prod", title: "q.sql", filePath: "/tmp/q.sql" } as const;
  const s1 = reducer(base, open);
  const s2 = reducer(reducer(s1, { type: "focusTab", id: "t-er" }), open);
  expect(s2.tabs).toHaveLength(s1.tabs.length);
  expect(s2.activeTabId).toBe(s1.activeTabId);
  const s3 = reducer(s2, { type: "setTabFile", id: s1.activeTabId!, filePath: "/tmp/r.sql", title: "r.sql" });
  expect(s3.tabs.find((t) => t.id === s1.activeTabId)).toMatchObject({ title: "r.sql", filePath: "/tmp/r.sql" });
});

test("a SQL tab on a Redis connection opens its console instead (once per database)", () => {
  const redis = { ...base.connections[0], id: "cache", driver: "redis" as const, database: "2" };
  const s0 = { ...base, connections: [...base.connections, redis] };
  const s1 = reducer(s0, { type: "openTab", kind: "sql", connectionId: "cache", title: "untitled.sql" });
  const tab = s1.tabs.find((t) => t.id === s1.activeTabId)!;
  expect(tab).toMatchObject({ kind: "console", connectionId: "cache", database: "2", target: "db2" });
  const s2 = reducer(s1, { type: "openTab", kind: "sql", connectionId: "cache", title: "untitled.sql" });
  expect(s2.tabs).toHaveLength(s1.tabs.length);
});

test("a new SQL editor opens on the connection's default database unless given one", () => {
  const s0 = { ...base, connections: base.connections.map((c) => (c.id === "orders-prod" ? { ...c, defaultDatabase: "analytics" } : c)) };
  const tabOf = (s: AppState) => s.tabs.find((t) => t.id === s.activeTabId)!;
  expect(tabOf(reducer(s0, { type: "openTab", kind: "sql", connectionId: "orders-prod", title: "q.sql" })).database).toBe("analytics");
  expect(tabOf(reducer(s0, { type: "openTab", kind: "sql", connectionId: "orders-prod", title: "q.sql", database: "shop" })).database).toBe("shop");
  expect(tabOf(reducer(s0, { type: "openTab", kind: "table", connectionId: "orders-prod", title: "t", target: "t" })).database).toBeUndefined();
});
