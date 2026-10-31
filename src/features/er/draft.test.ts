import { expect, test } from "vitest";
import type { ErModel, TableDef } from "../../types";
import { buildView, draftChips, draftReducer, emptyDraft, previewChanges, toChanges, type Draft, type DraftAction } from "./draft";

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const run = (...actions: DraftAction[]) => actions.reduce(draftReducer, emptyDraft);

const orders: TableDef = {
  schema: "public",
  name: "orders",
  columns: [
    { name: "id", type: "bigint", nullable: false, autoIncrement: true },
    { name: "customer_id", type: "bigint", nullable: false, autoIncrement: false },
    { name: "status", type: "text", nullable: true, autoIncrement: false },
  ],
  primaryKey: ["id"],
  foreignKeys: [{ name: "orders_customer_fk", columns: ["customer_id"], refTable: "customers", refColumns: ["id"] }],
  indexes: [{ name: "orders_status_ix", columns: ["status"], unique: false }],
  checks: [],
};
const loaded: DraftAction = { type: "loaded", id: "orders", def: orders };

test("no draft → no changes, no preview call", () => {
  expect(toChanges(emptyDraft)).toEqual([]);
  expect(previewChanges(emptyDraft, false)).toBeNull();
  // Loading a table to edit it is not a change by itself.
  expect(previewChanges(run(loaded), false)).toBeNull();
  // Read-only connections never preview.
  expect(previewChanges(run({ type: "addTable", id: "__new__1", schema: "public", name: "t", driver: "postgres" }), true)).toBeNull();
});

test("+ Table creates a table with a driver-appropriate id PK", () => {
  const d = run(
    { type: "addTable", id: "__new__1", schema: "main", name: "new_table", driver: "sqlite" },
    { type: "renameTable", id: "__new__1", name: "shipments" },
    { type: "addColumn", id: "__new__1" },
    { type: "updateColumn", id: "__new__1", column: "column", patch: { name: "order_id", type: "integer", nullable: false } },
    { type: "addFk", id: "__new__1", fk: { columns: ["order_id"], refTable: "orders", refColumns: ["id"] } },
  );
  expect(toChanges(d)).toEqual([
    {
      target: {
        schema: "main",
        name: "shipments",
        columns: [
          { name: "id", type: "integer", nullable: false, autoIncrement: true },
          { name: "order_id", type: "integer", nullable: false, autoIncrement: false },
        ],
        primaryKey: ["id"],
        foreignKeys: [{ columns: ["order_id"], refTable: "orders", refColumns: ["id"] }],
        indexes: [],
        checks: [],
      },
    },
  ]);
  const pg = run({ type: "addTable", id: "n", schema: "public", name: "x", driver: "postgres" });
  expect(pg.tables.n.columns[0]).toMatchObject({ type: "bigint", autoIncrement: true });
});

test("existing table edits: rename keeps originalName and follows PK/FK/index; add/remove columns", () => {
  const d = run(
    loaded,
    { type: "updateColumn", id: "orders", column: "customer_id", patch: { name: "client_id" } },
    { type: "updateColumn", id: "orders", column: "status", patch: { name: "state", default: "'new'" } },
    { type: "addColumn", id: "orders" },
    { type: "removeColumn", id: "orders", column: "state" },
  );
  const [change] = toChanges(d);
  expect(change.original!.columns.map((c) => c.originalName)).toEqual(["id", "customer_id", "status"]);
  expect(change.target!.columns).toEqual([
    { name: "id", originalName: "id", type: "bigint", nullable: false, autoIncrement: true },
    { name: "client_id", originalName: "customer_id", type: "bigint", nullable: false, autoIncrement: false },
    { name: "column", type: "text", nullable: true, autoIncrement: false },
  ]);
  expect(change.target!.foreignKeys[0].columns).toEqual(["client_id"]);
  // Index on the removed column goes with it.
  expect(change.target!.indexes).toEqual([]);
  expect(draftChips(d, () => undefined, t).map((c) => c.text)).toEqual([
    "orders.customer_id → client_id",
    "+ orders.column",
    "− orders.status",
  ]);
});

test("PK toggle makes the column NOT NULL; FK add/remove; types differ warning", () => {
  const d = run(
    loaded,
    { type: "updateColumn", id: "orders", column: "status", patch: { pk: true } },
    { type: "removeFk", id: "orders", columns: ["customer_id"], refTable: "customers" },
    { type: "addFk", id: "orders", fk: { columns: ["status"], refTable: "statuses", refColumns: ["code"] } },
    { type: "addFk", id: "orders", fk: { columns: ["status"], refTable: "statuses", refColumns: ["code"] } },
  );
  const target = toChanges(d)[0].target!;
  expect(target.primaryKey).toEqual(["id", "status"]);
  expect(target.columns[2].nullable).toBe(false);
  expect(target.foreignKeys).toEqual([{ columns: ["status"], refTable: "statuses", refColumns: ["code"] }]);
  const chips = draftChips(d, (table, col) => (table === "statuses" && col === "code" ? "integer" : undefined), t);
  expect(chips).toEqual([
    { text: "~ orders.status" },
    { text: "~ orders PK" },
    { text: "+ FK orders → statuses", warn: true },
    { text: "− FK orders → customers", warn: false },
  ]);
  // bigserial and bigint are the same type for FK purposes.
  const ok = run(loaded, { type: "addFk", id: "orders", fk: { columns: ["id"], refTable: "x", refColumns: ["id"] } });
  expect(draftChips(ok, () => "bigserial", t)[0].warn).toBe(false);
});

test("remove table: new ones vanish (with FKs to them), existing ones toggle a drop", () => {
  let d: Draft = run(
    loaded,
    { type: "addTable", id: "n1", schema: "public", name: "shipments", driver: "postgres" },
    { type: "addFk", id: "orders", fk: { columns: ["id"], refTable: "shipments", refColumns: ["id"] } },
    { type: "removeTable", id: "n1" },
  );
  expect(toChanges(d)).toEqual([]);
  d = draftReducer(d, { type: "removeTable", id: "orders" });
  expect(toChanges(d)).toEqual([{ original: d.originals.orders }]);
  expect(draftChips(d, () => undefined, t)).toEqual([{ text: 'er.chipDrop {"name":"orders"}' }]);
  d = draftReducer(d, { type: "removeTable", id: "orders" });
  expect(toChanges(d)).toEqual([]);
});

test("view: model tables, loaded edits and new tables with draft flags", () => {
  const model: ErModel = {
    tables: [
      { name: "customers", rows: "2", columns: [{ name: "id", type: "bigint", pk: true }] },
      { name: "orders", rows: "5", columns: [] },
    ],
    relations: [{ id: "r", from: "orders", fromColumn: "customer_id", to: "customers", toColumn: "id" }],
  };
  expect(buildView(model, emptyDraft)[1].fks).toEqual([{ columns: ["customer_id"], refTable: "customers", refColumns: ["id"], draft: false }]);
  const d = run(
    loaded,
    { type: "addColumn", id: "orders" },
    { type: "addFk", id: "orders", fk: { columns: ["column"], refTable: "customers", refColumns: ["id"] } },
    { type: "addTable", id: "n1", schema: "public", name: "t", driver: "mysql" },
  );
  const [, o, n] = buildView(model, d);
  expect(o.rows).toBe("5");
  expect(o.columns.map((c) => [c.name, !!c.pk, !!c.fk, !!c.draft])).toEqual([
    ["id", true, false, false],
    ["customer_id", false, true, false],
    ["status", false, false, false],
    ["column", false, true, true],
  ]);
  expect(o.fks.map((f) => f.draft)).toEqual([false, true]);
  expect(n).toMatchObject({ id: "n1", name: "t", isNew: true, dropped: false });
});
