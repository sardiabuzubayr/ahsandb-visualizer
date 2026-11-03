import { expect, test } from "vitest";
import { fitWidths } from "./columnWidths";
import type { Column } from "../../types";

const col = (name: string, numeric = false): Column => ({ name, type: numeric ? "int" : "text", numeric }) as Column;
const measure = (text: string) => text.length * 7;

test("fitWidths fits the longest of header and values, capped for long text", () => {
  const w = fitWidths([col("id", true), col("period_key"), col("note")], [[1, "H1448", "x".repeat(200)], [12345, "M2026", null]], measure, () => 16);
  expect(w.id).toBe(64); // "12345" → 35 + 28 padding, raised to the minimum
  expect(w.period_key).toBe(10 * 7 + 16 + 28);
  expect(w.note).toBe(360);
});
