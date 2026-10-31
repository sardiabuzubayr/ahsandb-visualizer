import { afterEach, expect, test, vi } from "vitest";
import { resolveTheme } from "./ThemeProvider";
import { readPref } from "../lib/storage";

afterEach(() => vi.unstubAllGlobals());

test("resolveTheme follows the system only for 'system'", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("light", true)).toBe("light");
});

test("readPref falls back when storage throws or holds junk", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
  expect(readPref("theme", ["system", "dark"], "system")).toBe("system");
  vi.stubGlobal("localStorage", { getItem: () => "purple" });
  expect(readPref("theme", ["system", "dark"], "system")).toBe("system");
});
