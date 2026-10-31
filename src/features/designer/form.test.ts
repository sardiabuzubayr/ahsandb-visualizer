import { describe, expect, test } from "vitest";
import type { TableDef } from "../../types";
import { newColumn, newTableDef, normalize, parseList, removeColumn, renameColumn, sameDef, schemaChange, togglePk, validate } from "./form";

const loaded: TableDef = {
  schema: "public",
  name: "orders",
  columns: [
    { name: "id", originalName: "id", type: "bigint", nullable: false, autoIncrement: true },
    { name: "customer_id", originalName: "customer_id", type: "bigint", nullable: false, autoIncrement: false },
    { name: "status", originalName: "status", type: "text", nullable: false, default: "'pending'", autoIncrement: false },
  ],
  primaryKey: ["id"],
  foreignKeys: [{ name: "orders_customer_fk", columns: ["customer_id"], refTable: "customers", refColumns: ["id"], onDelete: "CASCADE" }],
  indexes: [{ name: "orders_status_idx", columns: ["status", "customer_id"], unique: false }],
  checks: [{ name: "orders_status_chk", expression: "status <> ''" }],
};

describe("designer form ↔ TableDef", () => {
  test("unchanged loaded def round-trips as-is", () => {
    expect(normalize(loaded)).toEqual(loaded);
    expect(schemaChange(loaded, loaded)).toEqual({ original: loaded, target: loaded });
  });

  test("rename keeps originalName and updates PK/FK/index references", () => {
    const d = normalize(renameColumn(renameColumn(loaded, 1, "client_id"), 0, "order_id"));
    expect(d.columns[1]).toMatchObject({ name: "client_id", originalName: "customer_id" });
    expect(d.primaryKey).toEqual(["order_id"]);
    expect(d.foreignKeys[0].columns).toEqual(["client_id"]);
    expect(d.indexes[0].columns).toEqual(["status", "client_id"]);
  });

  test("new columns have no originalName; removed columns and their FKs are absent", () => {
    const added = { ...loaded, columns: [...loaded.columns, newColumn(4, "postgres")] };
    const d = normalize(removeColumn(added, 1));
    expect(d.columns.map((c) => c.name)).toEqual(["id", "status", "column_4"]);
    expect(d.columns[2].originalName).toBeUndefined();
    expect(d.foreignKeys).toEqual([]);
    expect(d.indexes[0].columns).toEqual(["status"]);
    expect(sameDef(added, loaded)).toBe(false);
  });

  test("blank default/check are dropped; PK toggle sets NOT NULL and keeps order", () => {
    const edited: TableDef = {
      ...loaded,
      columns: loaded.columns.map((c) => (c.name === "status" ? { ...c, default: "  " } : { ...c, nullable: true })),
      checks: [...loaded.checks, { expression: " " }],
    };
    const d = normalize(togglePk(edited, "customer_id"));
    expect(d.columns[2].default).toBeUndefined();
    expect(d.checks).toEqual(loaded.checks);
    expect(d.primaryKey).toEqual(["id", "customer_id"]);
    expect(d.columns[1].nullable).toBe(false);
    expect(normalize(togglePk(d, "id")).primaryKey).toEqual(["customer_id"]);
  });

  test("new table: id PK per driver, create change has no original", () => {
    expect(newTableDef("public", "postgres").columns[0]).toEqual({ name: "id", type: "bigint", nullable: false, autoIncrement: true });
    expect(newTableDef("main", "sqlite").columns[0].type).toBe("integer");
    expect(newTableDef("shop", "mysql").primaryKey).toEqual(["id"]);
    const d = { ...newTableDef("public", "postgres"), name: " invoices " };
    expect(schemaChange(null, d)).toEqual({ target: { ...d, name: "invoices" } });
  });

  test("validate", () => {
    expect(validate(loaded)).toEqual([]);
    expect(validate(newTableDef("public", "postgres")).map((p) => p.key)).toEqual(["designer.err.tableName"]);
    const bad: TableDef = {
      ...loaded,
      columns: [...loaded.columns, { name: "status", type: "", nullable: true, autoIncrement: false }, { name: " ", type: "int", nullable: true, autoIncrement: false }],
      foreignKeys: [{ columns: ["customer_id"], refTable: "", refColumns: [] }],
      indexes: [{ name: "x", columns: ["nope"], unique: true }],
    };
    expect(validate(bad).map((p) => p.key)).toEqual([
      "designer.err.duplicate",
      "designer.err.type",
      "designer.err.columnName",
      "designer.err.fk",
      "designer.err.unknownColumn",
    ]);
    expect(validate({ ...loaded, columns: [], primaryKey: [], foreignKeys: [], indexes: [] }).map((p) => p.key)).toEqual(["designer.err.noColumns"]);
  });

  test("parseList", () => {
    expect(parseList(" a, b ,,c ")).toEqual(["a", "b", "c"]);
  });
});
