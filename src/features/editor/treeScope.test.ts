import { describe, expect, it } from "vitest";
import type { SchemaNode } from "../../types";
import { databaseNames, databaseNodes, firstDatabase } from "./treeScope";

const shop: SchemaNode = { id: "c/shop", label: "shop", kind: "database", children: [{ id: "c/shop/public", label: "public", kind: "schema" }] };
const lazy: SchemaNode = { id: "c/analytics", label: "analytics", kind: "database", lazy: true };
const roles: SchemaNode = { id: "c/roles", label: "Roles", kind: "group" };
const nodes = [shop, lazy, roles];

describe("databaseNodes", () => {
  it("returns only the named database's children", () => expect(databaseNodes(nodes, "shop")).toEqual(shop.children));
  it("returns nothing for an unloaded database", () => expect(databaseNodes(nodes, "analytics")).toEqual([]));
  it("falls back to all nodes without a database or a matching node", () => {
    expect(databaseNodes(nodes)).toBe(nodes);
    expect(databaseNodes(nodes, "missing")).toBe(nodes);
  });
  it("lists database labels", () => expect(databaseNames(nodes)).toEqual(["shop", "analytics"]));
});

describe("firstDatabase", () => {
  it("takes the first non-empty entry", () => expect(firstDatabase(" , shop, analytics,")).toBe("shop"));
  it("is undefined for an empty list", () => {
    expect(firstDatabase(undefined)).toBeUndefined();
    expect(firstDatabase(" ,")).toBeUndefined();
  });
});
