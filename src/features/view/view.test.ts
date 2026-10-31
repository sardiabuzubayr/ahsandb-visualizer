import { expect, test } from "vitest";
import type { ViewDef } from "../../types";
import { emptyView, isDirty, normalizeQuery, normalizeView, parseTarget, validate } from "./view";

const v: ViewDef = { schema: "public", name: "v_open_orders", query: "SELECT id FROM orders" };

test("parseTarget: schema.name, new marker, dots after the schema stay in the name", () => {
  expect(parseTarget("public.v_open_orders")).toEqual({ schema: "public", name: "v_open_orders", isNew: false });
  expect(parseTarget("sales.__new__1730000000000")).toEqual({ schema: "sales", name: "__new__1730000000000", isNew: true });
  expect(parseTarget("main.v.x")).toEqual({ schema: "main", name: "v.x", isNew: false });
  expect(parseTarget("v_only")).toEqual({ schema: "", name: "v_only", isNew: false });
});

test("emptyView", () => {
  expect(emptyView("shop")).toEqual({ schema: "shop", name: "", query: "" });
});

test("normalizeQuery: trims whitespace and every trailing ;", () => {
  expect(normalizeQuery("  SELECT 1;\n")).toBe("SELECT 1");
  expect(normalizeQuery("SELECT 1 ; ;;\n\t")).toBe("SELECT 1");
  expect(normalizeQuery("SELECT ';' AS x")).toBe("SELECT ';' AS x");
  expect(normalizeQuery(" ;\n ")).toBe("");
  expect(normalizeView({ ...v, name: " v2 ", query: "SELECT 1;" })).toEqual({ schema: "public", name: "v2", query: "SELECT 1" });
});

test("isDirty: real edits only", () => {
  expect(isDirty(v, { ...v })).toBe(false);
  expect(isDirty(v, { ...v, query: v.query + ";\n" })).toBe(false);
  expect(isDirty(v, { ...v, query: v.query + " WHERE id > 1" })).toBe(true);
  expect(isDirty(v, { ...v, name: "v_renamed" })).toBe(true);
  expect(isDirty(emptyView("public"), emptyView("public"))).toBe(false);
  expect(isDirty(emptyView("public"), { ...emptyView("public"), name: "x" })).toBe(true);
});

test("validate: name, then query", () => {
  expect(validate(v)).toBeNull();
  expect(validate({ ...v, name: "  " })).toBe("view.nameRequired");
  expect(validate({ ...v, query: ";\n" })).toBe("view.queryRequired");
  expect(validate(emptyView("public"))).toBe("view.nameRequired");
});
