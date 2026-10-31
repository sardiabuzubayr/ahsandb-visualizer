import type { Driver } from "../../types";

/**
 * The statement under the cursor (offset into `sql`), split on `;` outside quotes, comments and PostgreSQL
 * dollar quotes. Blank lines and comments before a statement belong to it; a cursor right after a `;`, or
 * after the last statement, picks the statement before. Returns null when the text has no statement, or uses
 * MySQL `DELIMITER` (then the caller runs the whole script; the backend splitter handles it).
 */
export function statementAt(sql: string, offset: number, driver: Driver): string | null {
  if (/^\s*DELIMITER\s/im.test(sql)) return null;
  const spans: [number, number][] = [];
  const backslash = driver === "mysql" || driver === "mariadb";
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      i = lineEnd(sql, i);
    } else if (c === "#" && backslash) {
      i = lineEnd(sql, i);
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      i = quoteEnd(sql, i, c, backslash && c !== "`");
    } else if (c === "$" && driver === "postgres") {
      const tag = /^\$[A-Za-z_]?\w*\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end < 0 ? sql.length : end + tag[0].length;
      } else i++;
    } else if (c === ";") {
      spans.push([start, i + 1]);
      start = ++i;
    } else i++;
  }
  spans.push([start, sql.length]);

  const real = spans.filter(([a, b]) => hasCode(sql.slice(a, b)));
  if (!real.length) return null;
  const hit =
    real.find(([a, b]) => offset >= a && offset <= b) ?? [...real].reverse().find(([, b]) => b <= offset) ?? real[0];
  return sql.slice(hit[0], hit[1]).trim();
}

const lineEnd = (s: string, i: number) => {
  const n = s.indexOf("\n", i);
  return n < 0 ? s.length : n + 1;
};

/** Index after the closing quote; doubled quotes (and backslash escapes on MySQL) stay inside. */
function quoteEnd(s: string, i: number, q: string, backslash: boolean): number {
  for (let j = i + 1; j < s.length; j++) {
    if (backslash && s[j] === "\\") j++;
    else if (s[j] === q) {
      if (s[j + 1] === q) j++;
      else return j + 1;
    }
  }
  return s.length;
}

/** Text with something other than whitespace, comments and `;`. */
const hasCode = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .replace(/;/g, "")
    .trim() !== "";
