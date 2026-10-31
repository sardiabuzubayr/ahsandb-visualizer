import { expect, test } from "vitest";
import { formatCell } from "./format";

test("formatCell", () => {
  expect(formatCell("184250000.00", true)).toBe("184,250,000.00");
  expect(formatCell("-980000", true)).toBe("-980,000");
  expect(formatCell(10231, true)).toBe("10231");
  expect(formatCell("12345", false)).toBe("12345");
  expect(formatCell(null)).toBe("NULL");
  expect(formatCell("")).toBe("");
});
