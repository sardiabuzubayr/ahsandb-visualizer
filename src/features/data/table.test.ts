import { describe, expect, it, test } from "vitest";
import { nextSort, splitTarget, followForeignKey, selectRows, sqlLiteral } from "./table";

test("nextSort cycles asc → desc → none and restarts on another column", () => {
  const asc = nextSort(null, "total");
  expect(asc).toEqual({ column: "total", desc: false });
  const desc = nextSort(asc, "total");
  expect(desc).toEqual({ column: "total", desc: true });
  expect(nextSort(desc, "total")).toBeNull();
  expect(nextSort(desc, "id")).toEqual({ column: "id", desc: false });
});

test("splitTarget uses the first dot, else the driver default", () => {
  expect(splitTarget("sales.order.items", { driver: "postgres" })).toEqual({ schema: "sales", table: "order.items" });
  expect(splitTarget("orders", { driver: "postgres" })).toEqual({ schema: "public", table: "orders" });
  expect(splitTarget("orders", { driver: "mariadb", database: "shop" })).toEqual({ schema: "shop", table: "orders" });
  expect(splitTarget("orders", { driver: "sqlite" })).toEqual({ schema: "main", table: "orders" });
});

describe("following a foreign key", () => {
  const fk = { columns: ["customer_id"], refTable: "customers", refColumns: ["id"] };
  const cols = ["id", "customer_id", "note"];
  it("targets the referenced table with a WHERE on its key", () => {
    expect(followForeignKey("postgres", fk, "public", cols, [1, "0198-ab", null])).toEqual({
      target: "public.customers",
      table: "customers",
      filter: `"id" = '0198-ab'`,
    });
    expect(followForeignKey("mysql", { ...fk, refSchema: "crm" }, "shop", cols, [1, 7, null])?.filter).toBe("`id` = 7");
  });
  it("composite keys join with AND; a NULL part means nothing to follow", () => {
    const two = { columns: ["id", "note"], refTable: "t", refColumns: ["a", "b"] };
    expect(followForeignKey("postgres", two, "s", cols, [1, 2, "x'y"])?.filter).toBe(`"a" = 1 AND "b" = 'x''y'`);
    expect(followForeignKey("postgres", fk, "s", cols, [1, null, null])).toBeNull();
  });
  it("escapes literals per driver", () => {
    expect(sqlLiteral("mariadb", "a\\b'c")).toBe("'a\\\\b''c'");
    expect(sqlLiteral("postgres", "a\\b")).toBe("'a\\b'");
    expect(sqlLiteral("sqlite", 1.5)).toBe("1.5");
  });
});

test("selectRows: click selects one, ⌘ toggles, Shift selects a range from the anchor", () => {
  const keys = ["a", "b", "c", "d"];
  const none = { shift: false, toggle: false };
  expect([...selectRows(keys, new Set(["a", "b"]), null, 2, none)]).toEqual(["c"]);
  const toggled = selectRows(keys, new Set(["a"]), 0, 2, { shift: false, toggle: true });
  expect([...toggled]).toEqual(["a", "c"]);
  expect([...selectRows(keys, toggled, 2, 0, { shift: false, toggle: true })]).toEqual(["c"]);
  expect([...selectRows(keys, new Set(["d"]), 3, 1, { shift: true, toggle: false })]).toEqual(["b", "c", "d"]);
  expect([...selectRows(keys, new Set(), null, 1, { shift: true, toggle: false })]).toEqual(["b"]);
});
