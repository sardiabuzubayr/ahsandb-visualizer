import { expect, test } from "vitest";
import { mockSchemaTree } from "../../mock/connections";
import type { SchemaNode, Trigger } from "../../types";
import { emptyTrigger, isDirty, normalize, objectsIn, triggerTarget, validate } from "./trigger";

const pg: Trigger = {
  schema: "public",
  name: "trg_touch",
  table: "orders",
  timing: "BEFORE",
  events: ["INSERT", "UPDATE"],
  forEachRow: true,
  body: "public.trg_touch()",
};
const my: Trigger = { ...pg, schema: "shop", events: ["INSERT"], body: "BEGIN SET NEW.x = 1; END" };

test("triggerTarget: existing, new, new with table, missing schema", () => {
  expect(triggerTarget("public.trg_a")).toEqual({ schema: "public", name: "trg_a", isNew: false, table: "" });
  expect(triggerTarget("public.trg.with.dots")).toMatchObject({ schema: "public", name: "trg.with.dots" });
  expect(triggerTarget("public.__new__123")).toEqual({ schema: "public", name: "", isNew: true, table: "" });
  expect(triggerTarget("shop.__new__123:orders")).toEqual({ schema: "shop", name: "", isNew: true, table: "orders" });
  expect(triggerTarget(".__new__1:t")).toEqual({ schema: "", name: "", isNew: true, table: "t" });
  expect(triggerTarget("trg_a")).toEqual({ schema: "", name: "trg_a", isNew: false, table: "" });
});

test("emptyTrigger: PG body is a function call, others a BEGIN … END block", () => {
  expect(emptyTrigger("postgres", "public", "orders")).toMatchObject({ schema: "public", table: "orders", name: "", body: "", events: ["INSERT"], forEachRow: true });
  expect(emptyTrigger("mysql", "shop", "").body).toMatch(/^BEGIN[\s\S]*END$/);
});

test("normalize / isDirty: trim, empty condition, event order", () => {
  expect(normalize({ ...pg, body: "  f()  ", condition: "  " })).toMatchObject({ body: "f()", condition: undefined });
  expect(normalize({ ...pg, condition: " NEW.a > 1 " }).condition).toBe("NEW.a > 1");
  expect(isDirty(pg, { ...pg })).toBe(false);
  expect(isDirty(pg, { ...pg, events: ["UPDATE", "INSERT"], body: " public.trg_touch() ", condition: "" })).toBe(false);
  expect(isDirty(pg, { ...pg, events: ["INSERT"] })).toBe(true);
  expect(isDirty(pg, { ...pg, condition: "NEW.a > 1" })).toBe(true);
  expect(isDirty(pg, { ...pg, name: "trg_x" })).toBe(true);
});

test("validate: every rule", () => {
  expect(validate("postgres", pg)).toBeNull();
  expect(validate("mysql", my)).toBeNull();
  expect(validate("postgres", { ...pg, name: " " })).toBe("trigger.err.name");
  expect(validate("postgres", { ...pg, table: "" })).toBe("trigger.err.table");
  expect(validate("postgres", { ...pg, events: [] })).toBe("trigger.err.events");
  expect(validate("mysql", { ...my, events: ["INSERT", "UPDATE"] })).toBe("trigger.err.oneEvent");
  expect(validate("sqlite", { ...my, events: ["TRUNCATE"], forEachRow: false })).toBe("trigger.err.oneEvent");
  expect(validate("postgres", { ...pg, events: ["TRUNCATE"] })).toBe("trigger.err.truncateRow");
  expect(validate("postgres", { ...pg, events: ["TRUNCATE"], forEachRow: false })).toBeNull();
  expect(validate("mariadb", { ...my, timing: "INSTEAD OF" })).toBe("trigger.err.insteadOf");
  expect(validate("mysql", { ...my, timing: "INSTEAD OF" })).toBe("trigger.err.insteadOf");
  expect(validate("sqlite", { ...my, timing: "INSTEAD OF" })).toBeNull();
  expect(validate("postgres", { ...pg, body: "  " })).toBe("trigger.err.body");
});

test("objectsIn: schema from the node or its schema/database ancestor", () => {
  const tree = mockSchemaTree("c");
  expect(objectsIn(tree, "public", ["table", "view"])).toEqual([
    "customers", "order_items", "orders", "payments", "products", "v_daily_revenue", "v_open_orders", "v_top_customers",
  ]);
  expect(objectsIn(tree, "public", ["function"])).toEqual(["fn_order_total"]);
  expect(objectsIn(tree, "other", ["table"])).toEqual([]);
  const real: SchemaNode[] = [{ id: "g", label: "Tables", kind: "group", children: [{ id: "a", label: "a", kind: "table", schema: "shop" }, { id: "b", label: "b", kind: "table", schema: "x" }] }];
  expect(objectsIn(real, "shop", ["table"])).toEqual(["a"]);
});
