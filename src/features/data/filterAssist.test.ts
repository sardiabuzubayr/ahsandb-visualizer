import { describe, expect, it } from "vitest";
import { suggest, unknownColumns, wordAt } from "./filterAssist";

const cols = ["order_id", "created_at", "created_by", "status", "MixedCase"];

describe("filter assist", () => {
  it("finds the word being typed, not inside strings, casts or mid-word", () => {
    expect(wordAt("status = 'x' AND cre", 20)).toEqual({ start: 17, word: "cre" });
    expect(wordAt("status = 'cre", 13)).toBeNull();
    expect(wordAt("created_at::tim", 15)).toBeNull();
    expect(wordAt("created", 3)).toBeNull();
  });

  it("suggests prefix matches before contained ones", () => {
    expect(suggest("by", cols)).toEqual(["created_by"]);
    expect(suggest("cr", cols)).toEqual(["created_at", "created_by"]);
    expect(suggest("status", cols)).toEqual([]);
  });

  it("reports names that are not columns", () => {
    expect(unknownColumns("order_id = 'TD59' AND status IN ('a', 'b')", cols)).toEqual([]);
    expect(unknownColumns("orderid = 'x' or Status is not null", cols)).toEqual(["orderid"]);
    expect(unknownColumns(`"MixedCase" = 1 AND "mixedcase" = 2`, cols)).toEqual(["mixedcase"]);
    expect(unknownColumns("created_at::date > now() - interval '1 day' AND cast(status AS text) <> '' AND t.status = 1e3", cols)).toEqual([]);
  });
});
