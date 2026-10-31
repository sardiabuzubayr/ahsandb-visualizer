import { expect, test } from "vitest";
import { shortcutFor } from "./shortcuts";
import { filterTree } from "./tree";
import { mockSchemaTree } from "../../mock/connections";

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = { metaKey: true }) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

test("⌘K opens the palette only when no modal is open", () => {
  expect(shortcutFor(key("k"), false)).toBe("palette");
  expect(shortcutFor(key("k"), true)).toBeNull();
  expect(shortcutFor(key("j"), true)).toBe("agent");
  expect(shortcutFor(key("k", { ctrlKey: true }), false)).toBe("palette");
  expect(shortcutFor(key("k", {}), false)).toBeNull();
});

test("filterTree keeps ancestors of matches", () => {
  const out = filterTree(mockSchemaTree("c"), "payments");
  expect(out).toHaveLength(1);
  const tables = out[0].children![0].children![0];
  expect(tables.label).toBe("Tables");
  expect(tables.children!.map((n) => n.label)).toEqual(["payments"]);
  expect(filterTree(mockSchemaTree("c"), "zzz")).toEqual([]);
});
