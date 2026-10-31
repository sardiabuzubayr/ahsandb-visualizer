import { describe, expect, test } from "vitest";
import { mockSchemaTree } from "../../mock/connections";
import type { SchemaNode } from "../../types";
import { closesOnDrop, dropKind, nodeActions, objectSchema } from "./tree";

const node = (kind: SchemaNode["kind"], extra: Partial<SchemaNode> = {}): SchemaNode => ({ id: kind, label: kind, kind, ...extra });
const flat = (ns: SchemaNode[]): SchemaNode[] => ns.flatMap((n) => [n, ...flat(n.children ?? [])]);

describe("navigator: triggers, views, sequences", () => {
  test("menu items for the new object kinds", () => {
    expect(nodeActions(node("table"))).toContain("newTrigger");
    expect(nodeActions(node("view"))).toContain("editView");
    expect(nodeActions(node("schema"))).toContain("newView");
    expect(nodeActions(node("database"))).not.toContain("newView");
    expect(nodeActions(node("trigger"))).toEqual(["open", "copyName", "dropTrigger"]);
    expect(nodeActions(node("sequence"))).toEqual(["showDdl", "copyName", "dropSequence"]);
    expect(nodeActions(node("event"))).toEqual(["showDdl", "copyName", "dropEvent"]);
    expect(nodeActions(node("group", { id: "c/db/public/triggers" }))).toEqual(["newTrigger", "refresh"]);
    expect(nodeActions(node("group", { id: "c/db/public/events" }))).toEqual(["refresh"]);
  });

  test("schema of a node: own, schema label, or a child's for groups", () => {
    expect(objectSchema(node("trigger", { schema: "sales" }))).toBe("sales");
    expect(objectSchema(node("schema", { label: "sales" }))).toBe("sales");
    expect(objectSchema(node("group", { id: "x/triggers", children: [node("trigger", { schema: "sales" })] }))).toBe("sales");
    expect(objectSchema(node("group"))).toBeUndefined();
  });

  test("drop kind per node and the tabs a drop closes", () => {
    expect(["table", "view", "trigger", "sequence", "event"].map((k) => dropKind(node(k as SchemaNode["kind"])))).toEqual([
      "table",
      "view",
      "trigger",
      "sequence",
      "event",
    ]);
    const trg = node("trigger", { label: "trg_x" });
    expect(closesOnDrop(trg, "public", { kind: "trigger", target: "public.trg_x" })).toBe(true);
    expect(closesOnDrop(trg, "public", { kind: "table", target: "public.trg_x" })).toBe(false);
    expect(closesOnDrop(trg, "public", { kind: "view", target: "public.trg_x" })).toBe(false);
    const v = node("view", { label: "v1" });
    expect(closesOnDrop(v, "public", { kind: "view", target: "public.v1" })).toBe(true);
    expect(closesOnDrop(v, "public", { kind: "table", target: "v1" })).toBe(true);
    const tbl = node("table", { label: "orders", schema: "public" });
    expect(closesOnDrop(tbl, "public", { kind: "designer", target: "public.orders" })).toBe(true);
    expect(closesOnDrop(tbl, "public", { kind: "trigger", target: "public.orders" })).toBe(false);
  });

  test("mock tree: PG has a trigger and a sequence, MySQL/MariaDB an Events group", () => {
    const pg = flat(mockSchemaTree("orders-prod"));
    expect(pg.some((n) => n.kind === "trigger" && n.label === "trg_orders_touch")).toBe(true);
    expect(pg.some((n) => n.kind === "sequence")).toBe(true);
    expect(pg.some((n) => n.kind === "event")).toBe(false);
    for (const id of ["analytics-prod", "shop-local"]) {
      const my = flat(mockSchemaTree(id));
      expect(my.find((n) => n.id === `${id}/orders_db/public/events`)?.children?.[0].kind).toBe("event");
    }
  });
});
