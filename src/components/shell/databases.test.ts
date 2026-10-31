import { expect, test } from "vitest";
import type { SchemaNode } from "../../types";
import { mockSchemaTree } from "../../mock/connections";
import { canRenameDatabase, dropDatabaseConfirmed, formatBytes, inDatabase, nextDatabaseList, nodeActions } from "./tree";

const db: SchemaNode = { id: "c/shop", label: "shop", kind: "database", schema: "shop" };

test("formatBytes: B below 1 KB, one decimal from KB up to TB", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1023)).toBe("1023 B");
  expect(formatBytes(1024)).toBe("1.0 KB");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(13_002_342)).toBe("12.4 MB");
  expect(formatBytes(1_288_490_189)).toBe("1.2 GB");
  expect(formatBytes(3 * 1024 ** 4)).toBe("3.0 TB");
  expect(formatBytes(5 * 1024 ** 5)).toBe("5120.0 TB");
  // Rounds up into the next unit instead of "1024.0 KB".
  expect(formatBytes(1024 * 1024 - 1)).toBe("1.0 MB");
});

test("nodeActions: server database nodes get new/rename/drop (drop last); SQLite and other nodes don't", () => {
  expect(nodeActions(db, "postgres").slice(-3)).toEqual(["newDatabase", "renameDatabase", "dropDatabase"]);
  expect(nodeActions(db, "mariadb").at(-1)).toBe("dropDatabase");
  expect(nodeActions(db, "sqlite")).toEqual(nodeActions(db));
  expect(nodeActions(db)).not.toContain("dropDatabase");
  const schema: SchemaNode = { id: "c/shop/public", label: "public", kind: "schema" };
  expect(nodeActions(schema, "postgres")).not.toContain("newDatabase");
  expect([canRenameDatabase("postgres"), canRenameDatabase("mysql"), canRenameDatabase("mariadb")]).toEqual([true, false, false]);
});

test("nextDatabaseList: create appends, rename replaces, drop removes; no explicit list = no update", () => {
  expect(nextDatabaseList("orders_db, analytics", null, "new_db")).toBe("orders_db, analytics, new_db");
  expect(nextDatabaseList("orders_db,analytics", "analytics", "stats")).toBe("orders_db, stats");
  expect(nextDatabaseList(" orders_db , analytics ", "analytics", null)).toBe("orders_db");
  expect(nextDatabaseList("shop", "shop", null)).toBe("");
  expect(nextDatabaseList("shop", null, "shop")).toBe("shop");
  expect(nextDatabaseList(undefined, null, "x")).toBeUndefined();
  expect(nextDatabaseList(" , ", "x", null)).toBeUndefined();
});

test("inDatabase: PG matches the tab database; MySQL the target or its prefix", () => {
  expect(inDatabase("postgres", "shop", { database: "shop", target: "public.orders" })).toBe(true);
  expect(inDatabase("postgres", "shop", { database: "shop2" })).toBe(false);
  expect(inDatabase("postgres", "shop", { target: "shop.orders" })).toBe(false);
  expect(inDatabase("mysql", "shop", { target: "shop.orders" })).toBe(true);
  expect(inDatabase("mariadb", "shop", { target: "shop" })).toBe(true);
  expect(inDatabase("mysql", "shop", { target: "shop2.orders" })).toBe(false);
  expect(inDatabase("mysql", "shop", {})).toBe(false);
});

test("dropDatabaseConfirmed: needs the checkbox and the exact, case-sensitive name", () => {
  expect(dropDatabaseConfirmed("Shop", false, "Shop")).toBe(false);
  expect(dropDatabaseConfirmed("Shop", true, "shop")).toBe(false);
  expect(dropDatabaseConfirmed("Shop", true, "Shop ")).toBe(false);
  expect(dropDatabaseConfirmed("Shop", true, "Shop")).toBe(true);
});

test("mock: database nodes carry a size", () => {
  expect(mockSchemaTree("orders-staging").filter((n) => n.kind === "database").every((n) => n.size! > 0)).toBe(true);
  expect(mockSchemaTree("orders-prod")[0].size).toBeGreaterThan(0);
});
