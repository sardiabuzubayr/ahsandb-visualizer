import { describe, expect, it } from "vitest";
import { inline, parseMarkdown } from "./mdParse";

describe("agent markdown", () => {
  it("parses the inline spans models use", () => {
    expect(inline("**`sales`** (~1.8rb) and *ok* `a*b*`")).toEqual([
      { t: "strong", c: [{ t: "code", v: "sales" }] },
      { t: "text", v: " (~1.8rb) and " },
      { t: "em", c: [{ t: "text", v: "ok" }] },
      { t: "text", v: " " },
      { t: "code", v: "a*b*" },
    ]);
    expect(inline("a *b* _c_ d")).toEqual([
      { t: "text", v: "a " },
      { t: "em", c: [{ t: "text", v: "b" }] },
      { t: "text", v: " " },
      { t: "em", c: [{ t: "text", v: "c" }] },
      { t: "text", v: " d" },
    ]);
    // A lone asterisk and snake_case names stay text.
    expect(inline("2 * 3 and order_items_backup")).toEqual([{ t: "text", v: "2 * 3 and order_items_backup" }]);
  });

  it("parses headings, lists, nested lists, code, tables and paragraphs", () => {
    const md = [
      "Data penjualan ada di beberapa tabel.",
      "",
      "**Tabel utama**",
      "- **`sales`**: transaksi",
      "  - retur: `is_return`",
      "- `sales_items`",
      "",
      "## Query",
      "```sql",
      "SELECT * FROM sales;",
      "```",
      "| tabel | baris |",
      "|---|---:|",
      "| sales | 1800 |",
      "1. satu",
      "2. dua",
    ].join("\n");
    const b = parseMarkdown(md);
    expect(b.map((x) => x.t)).toEqual(["p", "p", "list", "h", "code", "table", "list"]);
    const list = b[2] as Extract<(typeof b)[number], { t: "list" }>;
    expect(list.items).toHaveLength(2);
    expect(list.items[0].sub?.t).toBe("list");
    expect(b[4]).toEqual({ t: "code", lang: "sql", v: "SELECT * FROM sales;" });
    const table = b[5] as Extract<(typeof b)[number], { t: "table" }>;
    expect(table.rows).toEqual([[[{ t: "text", v: "sales" }], [{ t: "text", v: "1800" }]]]);
    expect(b[6]).toMatchObject({ t: "list", ordered: true, start: 1 });
  });

  it("no app source uses regex lookbehind (macOS 13 WebKit rejects it; the app would not start)", () => {
    const sources = import.meta.glob<string>(["../../**/*.{ts,tsx}", "!../../**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true });
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(Object.entries(sources).filter(([, code]) => /\(\?<[!=]/.test(code)).map(([f]) => f)).toEqual([]);
    // Same WebKit drops color-mix() (Safari < 16.2): use the rgba tokens in styles.css instead.
    expect(Object.entries(sources).filter(([, code]) => /color-mix\(/.test(code)).map(([f]) => f)).toEqual([]);
  });

  it("keeps an unterminated code fence as code", () => {
    expect(parseMarkdown("```\nSELECT 1")).toEqual([{ t: "code", lang: "", v: "SELECT 1" }]);
  });
});
