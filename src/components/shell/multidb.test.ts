import { expect, test } from "vitest";
import { mockSchemaTree } from "../../mock/connections";
import { reducer } from "../../state/reducer";
import { initialState } from "../../state/app";
import type { SchemaNode } from "../../types";
import { tableItems } from "../../features/palette/items";
import { isMultiDb, reloadedDatabases, tabDatabase } from "./tree";

const db = (name: string, extra: Partial<SchemaNode> = {}): SchemaNode => ({ id: `c/${name}`, label: name, kind: "database", ...extra });
const loaded = (name: string) => db(name, { children: [{ id: `c/${name}/public`, label: "public", kind: "schema" }] });

test("isMultiDb: more than one top-level database node", () => {
  expect(isMultiDb([loaded("a"), { id: "c/roles", label: "Roles", kind: "role" }])).toBe(false);
  expect(isMultiDb([db("a", { lazy: true }), db("b", { lazy: true })])).toBe(true);
  expect(isMultiDb(mockSchemaTree("orders-staging"))).toBe(true);
  expect(isMultiDb(mockSchemaTree("orders-prod"))).toBe(false);
});

test("reloadedDatabases: only databases loaded before that came back lazy", () => {
  const prev = [loaded("a"), db("b", { lazy: true }), db("c", { children: [] })];
  const next = [db("a", { lazy: true }), db("b", { lazy: true }), db("c", { lazy: true }), db("d", { lazy: true })];
  expect(reloadedDatabases(prev, next).map((n) => n.label)).toEqual(["a"]);
  expect(reloadedDatabases(undefined, next)).toEqual([]);
  // A single-database tree comes back loaded: nothing to reload.
  expect(reloadedDatabases(prev, [loaded("a")])).toEqual([]);
});

test("tabDatabase: PostgreSQL nodes carry their database; Roles and other drivers don't", () => {
  const table: SchemaNode = { id: "c/shop/public/tables/orders", label: "orders", kind: "table", schema: "public" };
  expect(tabDatabase("postgres", table)).toBe("shop");
  expect(tabDatabase("postgres", db("shop"))).toBe("shop");
  expect(tabDatabase("postgres", { id: "c/roles", label: "Roles", kind: "role" })).toBeUndefined();
  expect(tabDatabase("mysql", table)).toBeUndefined();
});

test("mock: scoped schemaTree returns the loaded database node with the lazy node's id", () => {
  const [a, b] = mockSchemaTree("orders-staging");
  expect([a.lazy, b.lazy, a.children, b.label]).toEqual([true, true, undefined, "analytics"]);
  const [node] = mockSchemaTree(`orders-staging@${b.label}`);
  expect(node.id).toBe(b.id);
  expect(node.lazy).toBeUndefined();
  // Loaded into the tree, its tables open tabs in that database from the palette.
  let s = reducer(initialState, { type: "setTree", id: "orders-staging", tree: { status: "ready", nodes: [a, b] } });
  s = reducer(s, { type: "setDatabaseNode", id: "orders-staging", node });
  const orders = tableItems(s).find((x) => x.conn === "orders-staging" && x.label === "orders");
  expect(orders?.sub).toBe("analytics.public");
  expect(orders?.run[0]).toMatchObject({ connectionId: "orders-staging", database: "analytics" });
});
