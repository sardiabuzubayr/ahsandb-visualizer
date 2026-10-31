import { expect, test } from "vitest";
import { mockSchemaTree } from "../../mock/connections";
import type { SchemaNode } from "../../types";
import { databaseNodes } from "../editor/treeScope";
import {
  dataFileName,
  dumpDbName,
  dumpFileName,
  dumpObjects,
  dumpSchemas,
  exportDataOptions,
  exportGroups,
  schemaName,
  treeDatabase,
  withExt,
  withGz,
} from "./exportPlan";
import { allKeys, itemKey, toggleGroup, toggleItem } from "./selection";

const leaf = (id: string, kind: SchemaNode["kind"], schema?: string): SchemaNode => ({ id, label: id.split("/").pop()!, kind, schema });
const group = (id: string, children: SchemaNode[]): SchemaNode => ({ id, label: id, kind: "group", children });

test("tree → schemas per driver shape: PG schemas, MySQL databases, SQLite main", () => {
  // PostgreSQL: database → schemas → groups.
  const pg: SchemaNode[] = [
    {
      id: "c/shop",
      label: "shop",
      kind: "database",
      children: [
        { id: "c/shop/public", label: "public", kind: "schema", schema: "public", children: [group("c/shop/public/tables", [])] },
        { id: "c/shop/sales", label: "sales", kind: "schema", schema: "sales", children: [group("c/shop/sales/tables", [])] },
      ],
    },
    { id: "c/roles", label: "Roles", kind: "role", children: [] },
  ];
  expect(dumpSchemas(pg).map(schemaName)).toEqual(["public", "sales"]);
  // MySQL: database nodes carry `schema` and hold the groups directly.
  const my: SchemaNode[] = ["shop", "crm"].map((d) => ({ id: `m/${d}`, label: d, kind: "database", schema: d, children: [group(`m/${d}/tables`, [])] }));
  expect(dumpSchemas(my).map(schemaName)).toEqual(["shop", "crm"]);
  // A lazy (unloaded) database has nothing yet.
  expect(dumpSchemas([{ id: "c/x", label: "x", kind: "database", lazy: true }])).toEqual([]);
  // Multi-database PG: only the chosen database's schemas.
  const staging = mockSchemaTree("orders-staging@analytics");
  expect(dumpSchemas(databaseNodes(staging, "analytics")).map((n) => n.id)).toEqual(["orders-staging/analytics/public"]);
});

test("schema → groups (row estimates, no 'more' rows, empty groups dropped) → DumpObject[]", () => {
  const p = "c/db/public";
  const schema: SchemaNode = {
    id: p,
    label: "public",
    kind: "schema",
    children: [
      group(`${p}/tables`, [leaf(`${p}/tables/orders`, "table"), leaf(`${p}/tables/users`, "table"), { id: `${p}/tables/more`, label: "6 more…", kind: "more" }]),
      group(`${p}/views`, []),
      group(`${p}/procedures`, [leaf(`${p}/procedures/close_day`, "procedure")]),
      group(`${p}/events`, [leaf(`${p}/events/ev_purge`, "event")]),
    ],
  };
  const groups = exportGroups(schema, { orders: "12.4k" });
  expect(groups).toEqual([
    { key: "tables", items: [{ name: "orders", meta: "12.4k" }, { name: "users", meta: "" }] },
    { key: "procedures", items: [{ name: "close_day", meta: "" }] },
    { key: "events", items: [{ name: "ev_purge", meta: "" }] },
  ]);
  const all = allKeys(groups);
  expect(dumpObjects(groups, all)).toEqual([]);
  expect(dumpObjects(groups, toggleItem(itemKey("tables", "users"), all))).toEqual([
    { kind: "table", name: "orders" },
    { kind: "procedure", name: "close_day" },
    { kind: "event", name: "ev_purge" },
  ]);
  expect(dumpObjects(groups, toggleGroup(groups[0], all))).toEqual([
    { kind: "procedure", name: "close_day" },
    { kind: "event", name: "ev_purge" },
  ]);
  expect(exportGroups(undefined)).toEqual([]);
  // Mock tree: every kind present in the fixture maps to a group.
  const [mockSchema] = dumpSchemas(mockSchemaTree("orders-prod"));
  expect(exportGroups(mockSchema).map((g) => g.key)).toEqual(["tables", "views", "functions", "procedures", "triggers", "sequences"]);
});

test("default file names", () => {
  const d = new Date(2026, 9, 5, 23, 59);
  expect(dumpFileName("orders_db", "public", d, false)).toBe("orders_db-public-2026-10-05.sql");
  expect(dumpFileName("orders_db", "public", d, true)).toBe("orders_db-public-2026-10-05.sql.gz");
  expect(dumpFileName("shop", "shop", d, false)).toBe("shop-2026-10-05.sql");
  expect(dumpFileName("", "shop", d, false)).toBe("shop-2026-10-05.sql");
  expect(withGz("~/a/x.sql", true)).toBe("~/a/x.sql.gz");
  expect(withGz("~/a/x.sql.gz", false)).toBe("~/a/x.sql");
  expect(withGz("~/a/x.sql.gz", true)).toBe("~/a/x.sql.gz");
  expect(dataFileName("orders", "csv")).toBe("orders.csv");
  expect(dataFileName("query", "json")).toBe("query.json");
  expect(withExt("~/out/orders.csv", "sql")).toBe("~/out/orders.sql");
  expect(withExt("~/out/orders", "json")).toBe("~/out/orders.json");
  expect(dumpDbName({ driver: "sqlite", file: "~/Projects/notes/notes.db" })).toBe("notes");
  expect(dumpDbName({ driver: "mysql" })).toBe("");
  expect(dumpDbName({ driver: "postgres" }, "orders_db")).toBe("orders_db");
  expect(treeDatabase({ driver: "postgres", database: "shop, analytics" })).toBe("shop");
  expect(treeDatabase({ driver: "postgres", database: "shop, analytics" }, "analytics")).toBe("analytics");
  expect(treeDatabase({ driver: "postgres", database: "" })).toBe("postgres");
  expect(treeDatabase({ driver: "mysql", database: "shop" })).toBeUndefined();
});

test("export data options per format", () => {
  const source = { kind: "table" as const, schema: "public", table: "orders" };
  const o = { delimiter: ";", header: true, batch: "250", tableName: " orders_copy " };
  expect(exportDataOptions(source, "csv", "/x.csv", o)).toEqual({ source, format: "csv", path: "/x.csv", delimiter: ";", header: true });
  expect(exportDataOptions(source, "json", "/x.json", o)).toEqual({ source, format: "json", path: "/x.json", header: false });
  expect(exportDataOptions(source, "sql", "/x.sql", o)).toEqual({
    source,
    format: "sql",
    path: "/x.sql",
    header: false,
    batchSize: 250,
    tableName: "orders_copy",
  });
  const q = { kind: "query" as const, sql: "SELECT 1" };
  expect(exportDataOptions(q, "sql", "/q.sql", { ...o, batch: "abc", tableName: "" })).toMatchObject({ batchSize: 500, tableName: undefined });
});
