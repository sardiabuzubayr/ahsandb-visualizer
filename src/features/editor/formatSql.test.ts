import { expect, test } from "vitest";
import { formatSql } from "./formatSql";

test("formats per dialect with the chosen keyword case and indent", async () => {
  const out = await formatSql("select id, name from customers where id = 1; select 2", "postgres", { keywordCase: "upper", tabSize: 2 });
  expect(out).toBe("SELECT\n  id,\n  name\nFROM\n  customers\nWHERE\n  id = 1;\n\nSELECT\n  2");
  expect(await formatSql("SELECT `a` FROM t", "mysql", { keywordCase: "lower", tabSize: 4 })).toBe("select\n    `a`\nfrom\n    t");
});

test("unparseable text throws instead of mangling it", async () => {
  await expect(formatSql("SELECT 'unterminated", "postgres", { keywordCase: "upper", tabSize: 2 })).rejects.toThrow();
});
