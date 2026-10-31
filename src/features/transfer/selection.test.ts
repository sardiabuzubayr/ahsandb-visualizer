import { expect, test } from "vitest";
import { allKeys, estimate, groupState, itemKey, parseCount, toggleGroup, toggleItem, type ExportGroup } from "./selection";

const groups: ExportGroup[] = [
  {
    key: "tables",
    items: [
      { name: "customers", meta: "2.4k" },
      { name: "orders", meta: "12.4k" },
      { name: "products", meta: "860" },
      { name: "shipments", meta: "" },
    ],
  },
  { key: "views", items: [{ name: "v_open_orders", meta: "" }] },
  { key: "functions", items: [{ name: "fn_tax", meta: "" }, { name: "fn_slug", meta: "" }] },
];
const tables = groups[0];

test("group tri-state follows its items", () => {
  const all = allKeys(groups);
  expect(groupState(tables, all)).toBe("on");
  const one = toggleItem(itemKey("tables", "orders"), all);
  expect(groupState(tables, one)).toBe("mixed");
  expect(groupState(tables, new Set())).toBe("off");
  // Untouched groups stay fully selected.
  expect(groupState(groups[1], one)).toBe("on");
});

test("toggleGroup: mixed/off selects all, on clears", () => {
  const mixed = toggleItem(itemKey("tables", "orders"), allKeys(groups));
  expect(groupState(tables, toggleGroup(tables, mixed))).toBe("on");
  expect(groupState(tables, toggleGroup(tables, allKeys(groups)))).toBe("off");
  expect(groupState(tables, toggleGroup(tables, new Set()))).toBe("on");
});

test("toggleItem flips one key", () => {
  const k = itemKey("views", "v_open_orders");
  expect(toggleItem(k, new Set()).has(k)).toBe(true);
  expect(toggleItem(k, new Set([k])).has(k)).toBe(false);
});

test("estimate counts rows of selected tables and other objects", () => {
  expect(parseCount("2.4k")).toBe(2400);
  expect(parseCount("1.2M")).toBe(1_200_000);
  expect(parseCount("860")).toBe(860);
  expect(parseCount("")).toBe(0);
  expect(estimate(groups, allKeys(groups))).toEqual({ rows: 15660, tables: 4, others: 3 });
  expect(estimate(groups, new Set())).toEqual({ rows: 0, tables: 0, others: 0 });
});
