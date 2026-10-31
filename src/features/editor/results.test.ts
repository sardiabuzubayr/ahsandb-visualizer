import { describe, expect, test } from "vitest";
import { toResultSets, visibleRange } from "./results";

describe("toResultSets", () => {
  const base = { sql: "x", columns: [], rows: [], elapsedMs: 3, truncated: false };

  test("rows, affected, truncated and error map onto result tabs", () => {
    const out = toResultSets(
      [
        { ...base, columns: [{ name: "n", type: "int4", numeric: true }], rows: [[1]], truncated: true },
        { ...base, affected: 3 },
        { ...base, error: { message: "syntax error", position: 8 } },
      ],
      "run",
    );
    expect(out.map((r) => [r.id, r.label])).toEqual([
      ["run-0", "Result 1"],
      ["run-1", "Result 2"],
      ["run-2", "Result 3"],
    ]);
    expect(out[0]).toMatchObject({ rows: [[1]], truncated: true, affected: undefined });
    expect(out[1]).toMatchObject({ affected: 3, truncated: false });
    expect(out[2].error).toEqual({ message: "syntax error", position: 8 });
  });
});

describe("visibleRange", () => {
  test("top of the list", () => expect(visibleRange(0, 280, 28, 1000, 10)).toEqual({ start: 0, end: 20 }));
  test("middle", () => expect(visibleRange(2800, 280, 28, 1000, 10)).toEqual({ start: 90, end: 120 }));
  test("clamped at the end", () => expect(visibleRange(27720, 280, 28, 1000, 10)).toEqual({ start: 980, end: 1000 }));
  test("few rows", () => expect(visibleRange(0, 600, 28, 5, 10)).toEqual({ start: 0, end: 5 }));
  test("empty", () => expect(visibleRange(0, 600, 28, 0, 10)).toEqual({ start: 0, end: 0 }));
});
