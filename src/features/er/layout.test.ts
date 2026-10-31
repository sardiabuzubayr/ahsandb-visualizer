import { expect, test } from "vitest";
import { CARD_W, cardHeight, dagreLayout, initialPositions, loadPositions, parsePositions } from "./layout";

const tables = [
  { id: "customers", columns: 5 },
  { id: "orders", columns: 6 },
  { id: "order_items", columns: 5 },
  { id: "products", columns: 4 },
  { id: "payments", columns: 5 },
  { id: "loner", columns: 0 },
];
const edges = [
  { source: "customers", target: "orders" },
  { source: "orders", target: "order_items" },
  { source: "products", target: "order_items" },
  { source: "orders", target: "payments" },
  { source: "orders", target: "orders" },
];

test("dagre layout: every table placed, no two cards overlap, references flow left to right", () => {
  const pos = dagreLayout(tables, edges);
  expect(Object.keys(pos).sort()).toEqual(tables.map((t) => t.id).sort());
  const rects = tables.map((t) => ({ ...pos[t.id], w: CARD_W, h: cardHeight(t.columns) }));
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const [a, b] = [rects[i], rects[j]];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlap, `${tables[i].id} vs ${tables[j].id}`).toBe(false);
    }
  expect(pos.customers.x).toBeLessThan(pos.orders.x);
  expect(pos.orders.x).toBeLessThan(pos.order_items.x);
});

test("initial positions: saved win, nothing saved = dagre, new tables stack right of the saved ones", () => {
  expect(initialPositions(tables, edges, {})).toEqual(dagreLayout(tables, edges));
  const saved = { customers: { x: 0, y: 10 }, orders: { x: 300, y: 50 } };
  const out = initialPositions(tables.slice(0, 3), edges, saved);
  expect(out.customers).toEqual(saved.customers);
  expect(out.order_items).toEqual({ x: 300 + CARD_W + 72, y: 10 });
});

test("position parsing tolerates bad input", () => {
  expect(parsePositions(null)).toEqual({});
  expect(parsePositions("{not json")).toEqual({});
  expect(parsePositions("[1,2]")).toEqual({});
  expect(parsePositions("42")).toEqual({});
  expect(parsePositions('{"a":{"x":1,"y":2},"b":{"x":"1","y":2},"c":null,"d":{"x":1}}')).toEqual({ a: { x: 1, y: 2 } });
  // No localStorage in the test environment: reading must not throw.
  expect(loadPositions("er-positions:x:y")).toEqual({});
});
