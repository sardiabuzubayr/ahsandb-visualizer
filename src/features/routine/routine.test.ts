import { expect, test } from "vitest";
import type { Routine, SchemaNode } from "../../types";
import { isDirty, routineTarget, runArgs } from "./routine";

const proc: Routine = {
  kind: "procedure",
  name: "close_daily_orders",
  database: "shop",
  security: "definer",
  params: [
    { mode: "IN", name: "p_date", type: "DATE" },
    { mode: "OUT", name: "p_closed", type: "INT" },
    { mode: "INOUT", name: "p_note", type: "TEXT" },
    { mode: "IN", name: "p_dry_run", type: "BOOLEAN" },
  ],
  body: "BEGIN END",
};

test("runArgs: IN/INOUT only, declaration order, NULL toggle, bool default", () => {
  expect(runArgs(proc, { p_date: { value: "2026-10-23", isNull: false }, p_note: { value: "", isNull: false } })).toEqual(["2026-10-23", "", "0"]);
  expect(runArgs(proc, { p_note: { value: "x", isNull: true }, p_dry_run: { value: "1", isNull: false } })).toEqual(["", null, "1"]);
  // Functions: every parameter is IN, even if the form still says OUT.
  expect(runArgs({ ...proc, kind: "function" }, {})).toEqual(["", "", "", "0"]);
});

test("isDirty: real edits count, kind round-trips and stale modes don't", () => {
  expect(isDirty(proc, { ...proc })).toBe(false);
  expect(isDirty(proc, { ...proc, body: "BEGIN SELECT 1; END" })).toBe(true);
  expect(isDirty(proc, { ...proc, params: proc.params.slice(1) })).toBe(true);
  // Procedure → function (returns typed) → procedure again is not a change.
  expect(isDirty(proc, { ...proc, returns: "INT" })).toBe(false);
  const fn: Routine = { ...proc, kind: "function", returns: "int", params: [{ mode: "IN", name: "a", type: "int" }] };
  expect(isDirty(fn, { ...fn, params: [{ mode: "OUT", name: "a", type: "int" }] })).toBe(false);
  expect(isDirty(fn, { ...fn, returns: "bigint" })).toBe(true);
});

test("routineTarget: tree tells schema and kind, else connection default and both kinds", () => {
  const tree: SchemaNode[] = [
    { id: "db", label: "shop", kind: "database", children: [{ id: "f", label: "fn_total", kind: "function", schema: "billing" }] },
  ];
  expect(routineTarget("fn_total", "postgres", "shop", tree)).toEqual({ schema: "billing", name: "fn_total", kinds: ["function"] });
  expect(routineTarget("fn_total", "postgres", "shop")).toEqual({ schema: "public", name: "fn_total", kinds: ["procedure", "function"] });
  expect(routineTarget("sales.fn_total", "postgres", "shop", tree)).toEqual({ schema: "sales", name: "fn_total", kinds: ["procedure", "function"] });
  expect(routineTarget("p", "mysql", "shop")).toEqual({ schema: "shop", name: "p", kinds: ["procedure", "function"] });
});
