import { describe, expect, it } from "vitest";
import { bindParams, paramNames } from "./params";

describe("query parameters", () => {
  it("finds :name outside quotes, comments, casts and slices", () => {
    const sql = `SELECT a::text, arr[lo:hi], ':x', $$ :y $$ -- :z
FROM t WHERE id = :s AND b = :s OR c IN (:other) /* :w */`;
    expect(paramNames(sql, "postgres")).toEqual(["s", "other"]);
  });

  it("ignores MySQL := assignment", () => {
    expect(paramNames("SET @a := 1; SELECT :p", "mysql")).toEqual(["p"]);
  });

  it("binds every occurrence as typed", () => {
    expect(bindParams("SELECT :a, :b, :a::int, ':a'", { a: "1", b: "'x'" }, "postgres")).toBe("SELECT 1, 'x', 1::int, ':a'");
  });
});
