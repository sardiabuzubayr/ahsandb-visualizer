import { describe, expect, test } from "vitest";
import { dictModules, resolveLang, translate } from "./index";

describe("dictionaries", () => {
  const entries = Object.entries(dictModules);

  test("every module has identical en/id keys", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const [path, m] of entries) {
      expect(Object.keys(m.id).sort(), path).toEqual(Object.keys(m.en).sort());
    }
  });

  test("no key is defined by two modules", () => {
    const seen = new Map<string, string>();
    for (const [path, m] of entries) {
      for (const k of Object.keys(m.en)) {
        expect(seen.get(k), `${k} in ${path}`).toBeUndefined();
        seen.set(k, path);
      }
    }
  });
});

test("resolveLang", () => {
  expect(resolveLang("system", "id-ID")).toBe("id");
  expect(resolveLang("system", "fr-FR")).toBe("en");
  expect(resolveLang("en", "id-ID")).toBe("en");
});

test("translate interpolates and falls back to the key", () => {
  expect(translate({ a: "{n} rows" }, "a", { n: 3 })).toBe("3 rows");
  expect(translate({}, "missing.key")).toBe("missing.key");
});
