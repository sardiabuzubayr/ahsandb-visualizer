import { describe, expect, it } from "vitest";
import type { Column } from "../../types";
import { columnSources, deleteTarget, sourceTables } from "./resultSource";

const col = (name: string, extra: Partial<Column> = {}): Column => ({ name, type: "text", ...extra });

describe("columnSources", () => {
  it("uses the server origin when there is one", () => {
    const origin = { schema: "public", table: "transaction", column: "transaction_id" };
    expect(columnSources([col("transaction_id", { origin }), col("x")], "SELECT … JOIN …", "public")).toEqual([origin, undefined]);
  });

  it("reads a plain single-table SELECT", () => {
    const cols = [col("id"), col("name"), col("n")];
    const sql = "-- top\nSELECT o.id, name, `total` AS n FROM shop.orders o WHERE id > 1 ORDER BY id;";
    expect(columnSources(cols, sql, "def")).toEqual([
      { schema: "shop", table: "orders", column: "id" },
      { schema: "shop", table: "orders", column: "name" },
      { schema: "shop", table: "orders", column: "total" },
    ]);
    expect(columnSources([col("ID")], "select * from orders limit 5", "def")).toEqual([{ schema: "def", table: "orders", column: "ID" }]);
  });

  it("gives nothing for joins, expressions, unions and other tables' columns", () => {
    const none = [undefined];
    expect(columnSources([col("id")], "SELECT id FROM a JOIN b ON a.id = b.a_id", "s")).toEqual(none);
    expect(columnSources([col("id")], "SELECT id FROM a, b", "s")).toEqual(none);
    expect(columnSources([col("id")], "SELECT id + 1 AS id FROM a", "s")).toEqual(none);
    expect(columnSources([col("id")], "SELECT id FROM a UNION SELECT id FROM b", "s")).toEqual(none);
    expect(columnSources([col("id")], "SELECT b.id FROM a", "s")).toEqual(none);
  });
});

describe("deleteTarget", () => {
  const t = { schema: "public", table: "transaction" };
  const td = { schema: "public", table: "transaction_details" };
  const sources = [
    { ...t, column: "payment_status" },
    { ...td, column: "transaction_id" },
    { ...t, column: "transaction_id" },
    undefined,
  ];

  it("picks the table whose whole primary key is selected", () => {
    expect(sourceTables(sources)).toEqual([t, td]);
    const tables = [
      { ...td, columns: [col("detail_id", { pk: true }), col("transaction_id")] },
      { ...t, columns: [col("transaction_id", { pk: true }), col("payment_status")] },
    ];
    expect(deleteTarget(sources, tables)).toEqual({ ...t, keyIdxs: [2], keyNames: ["transaction_id"] });
  });

  it("needs every key column and a primary key at all", () => {
    expect(deleteTarget(sources, [{ ...t, columns: [col("transaction_id", { pk: true }), col("seq", { pk: true })] }])).toBeNull();
    expect(deleteTarget(sources, [{ ...t, columns: [col("transaction_id")] }])).toBeNull();
  });
});
