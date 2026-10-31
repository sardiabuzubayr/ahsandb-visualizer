import { expect, test } from "vitest";
import { mockSchemaTree } from "../../mock/connections";
import { initialState } from "../../state/app";
import type { AppState } from "../../state/reducer";
import { filterItems, matchRange } from "./filter";
import { actionItems, connectionItems, tableItems } from "./items";

const items = [{ label: "orders" }, { label: "order_items" }, { label: "customers" }];

test("matchRange is a case-insensitive substring match with a highlight range", () => {
  expect(matchRange("New SQL editor on orders-prod", "ORD")).toEqual([18, 21]);
  expect(matchRange("orders", "  ord ")).toEqual([0, 3]);
  expect(matchRange("customers", "xyz")).toBeNull();
  expect(matchRange("customers", "")).toEqual([0, 0]);
});

test("filterItems keeps matches with ranges; empty query keeps all; no match → []", () => {
  expect(filterItems(items, "ord").map((i) => [i.label, i.range])).toEqual([
    ["orders", [0, 3]],
    ["order_items", [0, 3]],
  ]);
  expect(filterItems(items, "")).toHaveLength(3);
  expect(filterItems(items, "zzz")).toEqual([]);
});

const tableNode = (label: string, schema?: string) => ({ id: `x/${label}`, label, kind: "table" as const, schema });

test("table items come from loaded trees of connected connections and open a table tab", () => {
  const t = (k: string) => k;
  const state: AppState = {
    ...initialState,
    trees: {
      "orders-prod": { status: "ready", nodes: mockSchemaTree("orders-prod") },
      "orders-staging": { status: "loading" },
      // A stale tree of a disconnected connection is ignored.
      "analytics-prod": { status: "ready", nodes: mockSchemaTree("analytics-prod") },
      "shop-local": {
        status: "ready",
        nodes: [{ id: "s/shop", label: "shop", kind: "database", children: [tableNode("orders", "shop"), tableNode("users")] }],
      },
    },
  };
  const tables = tableItems(state);
  expect(tables.some((x) => x.conn === "analytics-prod" || x.conn === "orders-staging")).toBe(false);
  const orders = tables.find((x) => x.label === "orders" && x.conn === "orders-prod");
  expect(orders?.sub).toBe("orders_db.public");
  // PostgreSQL tabs carry the database of the node they came from.
  expect(orders?.run).toEqual([
    { type: "openTab", kind: "table", connectionId: "orders-prod", title: "orders", target: "orders", database: "orders_db" },
  ]);
  // Nodes with a schema carry it in the target as "schema.table".
  const shop = tables.filter((x) => x.conn === "shop-local");
  expect(shop.map((x) => [x.sub, x.run[0]])).toEqual([
    ["shop", { type: "openTab", kind: "table", connectionId: "shop-local", title: "orders", target: "shop.orders" }],
    ["shop", { type: "openTab", kind: "table", connectionId: "shop-local", title: "users", target: "users" }],
  ]);
  expect(tableItems(initialState)).toEqual([]);
  const analytics = connectionItems(initialState, t).find((c) => c.label === "analytics-prod");
  expect(analytics).toMatchObject({ hint: "palette.connect", connect: "analytics-prod" });
});

test("transfer actions: dump/import SQL on the active connection, export/import data for the best table hit", () => {
  const t = (k: string, v?: Record<string, string | number>) => `${k}:${v?.name ?? ""}`;
  const state: AppState = {
    ...initialState,
    activeConnectionId: "orders-prod",
    trees: { "orders-prod": { status: "ready", nodes: mockSchemaTree("orders-prod") } },
  };
  const subject = tableItems(state).find((x) => x.label === "orders");
  const items = actionItems(state, t, subject);
  const run = (id: string) => items.find((x) => x.id === id)?.run;
  expect(run("a:exportDb")).toEqual([{ type: "openDialog", dialog: "export", connectionId: "orders-prod" }]);
  expect(run("a:importSql")).toEqual([{ type: "openDialog", dialog: "importSql", connectionId: "orders-prod" }]);
  const context = { database: "orders_db", schema: undefined, table: "orders" };
  expect(run("a:export")).toEqual([{ type: "openDialog", dialog: "exportData", connectionId: "orders-prod", context }]);
  expect(run("a:import")).toEqual([{ type: "openDialog", dialog: "import", connectionId: "orders-prod", context }]);
  // Disconnected active connection: no dump/import SQL entries.
  const off = actionItems({ ...state, activeConnectionId: "analytics-prod" }, t);
  expect(off.some((x) => x.id === "a:exportDb" || x.id === "a:export")).toBe(false);
});
