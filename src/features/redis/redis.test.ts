import { expect, test } from "vitest";
import { formatTtl, parseTtl, prettyJson, typeBadge } from "./redis";

test("formatTtl shows the largest units", () => {
  expect(formatTtl(-1)).toBe("");
  expect(formatTtl(-2)).toBe("—");
  expect(formatTtl(45_000)).toBe("45s");
  expect(formatTtl(12 * 60_000)).toBe("12m");
  expect(formatTtl((3 * 3600 + 5 * 60) * 1000)).toBe("3h 5m");
  expect(formatTtl((2 * 86400 + 4 * 3600) * 1000)).toBe("2d 4h");
});

test("parseTtl accepts seconds and unit suffixes; empty = no expiry", () => {
  expect(parseTtl("")).toBeNull();
  expect(parseTtl("90")).toBe(90);
  expect(parseTtl("5m")).toBe(300);
  expect(parseTtl("2H")).toBe(7200);
  expect(parseTtl("1d")).toBe(86400);
  expect(parseTtl("0")).toBeUndefined();
  expect(parseTtl("-5")).toBeUndefined();
  expect(parseTtl("soon")).toBeUndefined();
});

test("prettyJson formats objects and arrays only", () => {
  expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  expect(prettyJson("[1]")).toBe("[\n  1\n]");
  expect(prettyJson("42")).toBeNull();
  expect(prettyJson("{broken")).toBeNull();
});

test("typeBadge falls back for module types", () => {
  expect(typeBadge("hash").label).toBe("HASH");
  expect(typeBadge("ReJSON-RL")).toEqual({ label: "REJS", color: "text-faint" });
});
