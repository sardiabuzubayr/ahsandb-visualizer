import { expect, test } from "vitest";
import type { SchemaNode } from "../../types";
import { nodeActions, transferDialog } from "./tree";

const pgDb: SchemaNode = { id: "c/shop", label: "shop", kind: "database", lazy: true };
const pgSchema: SchemaNode = { id: "c/shop/sales", label: "sales", kind: "schema", schema: "sales" };
const pgTable: SchemaNode = { id: "c/shop/sales/tables/orders", label: "orders", kind: "table", schema: "sales" };
const myDb: SchemaNode = { id: "m/crm", label: "crm", kind: "database", schema: "crm" };
const lite: SchemaNode = { id: "l/main", label: "main", kind: "database", schema: "main" };

test("database/schema nodes export + import SQL on every driver; tables export/import data", () => {
  for (const [n, d] of [[pgDb, "postgres"], [pgSchema, "postgres"], [myDb, "mariadb"], [lite, "sqlite"]] as const) {
    expect(nodeActions(n, d)).toEqual(expect.arrayContaining(["export", "importSql"]));
    expect(nodeActions(n, d)).not.toContain("exportData");
  }
  expect(nodeActions(pgTable)).toEqual(expect.arrayContaining(["exportData", "importData"]));
  expect(nodeActions(pgTable)).not.toContain("export");
  for (const k of ["view", "trigger", "group"] as const)
    expect(nodeActions({ id: k, label: k, kind: k })).not.toEqual(expect.arrayContaining(["export"]));
});

test("transfer entries open their dialog with the node's database/schema/table", () => {
  // PG database node: its database, no schema (the dialog defaults to public).
  expect(transferDialog("export", pgDb, "postgres")).toEqual({ dialog: "export", context: { database: "shop", schema: undefined } });
  expect(transferDialog("importSql", pgSchema, "postgres")).toEqual({ dialog: "importSql", context: { database: "shop", schema: "sales" } });
  expect(transferDialog("exportData", pgTable, "postgres")).toEqual({ dialog: "exportData", context: { database: "shop", schema: "sales", table: "orders" } });
  expect(transferDialog("importData", pgTable, "postgres")).toEqual({ dialog: "import", context: { database: "shop", schema: "sales", table: "orders" } });
  // MySQL/SQLite: no scoped database; the database is the schema.
  expect(transferDialog("export", myDb, "mysql")).toEqual({ dialog: "export", context: { database: undefined, schema: "crm" } });
  expect(transferDialog("export", lite, "sqlite")).toEqual({ dialog: "export", context: { database: undefined, schema: "main" } });
  expect(transferDialog("refresh", pgDb, "postgres")).toBeNull();
});
