import { expect, test } from "vitest";
import { revenueColumns } from "../../mock/results";
import { suggestAxes } from "./axes";

test("text column goes to X, numeric measure to Y", () => {
  expect(suggestAxes(revenueColumns)).toEqual({ x: "name", y: "revenue" });
  expect(suggestAxes([{ name: "day", type: "date" }, { name: "n", type: "int4", numeric: true }])).toEqual({ x: "day", y: "n" });
});

test("all-numeric columns: first column is X", () => {
  expect(suggestAxes([{ name: "id", type: "int8", numeric: true }, { name: "qty", type: "int4", numeric: true }])).toEqual({
    x: "id",
    y: "qty",
  });
});

test("no numeric column → null", () => {
  expect(suggestAxes([{ name: "name", type: "text" }, { name: "city", type: "text" }])).toBeNull();
  expect(suggestAxes([])).toBeNull();
});
