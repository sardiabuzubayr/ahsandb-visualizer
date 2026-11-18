import type { Driver } from "../../types";
import { lineEnd, quoteEnd } from "./statementAt";

type Hit = { name: string; start: number; end: number };

/** `:name` placeholders outside quotes, comments and dollar quotes; skips `::type` casts, `:=` and `arr[a:b]`. */
function scan(sql: string, driver: Driver): Hit[] {
  const hits: Hit[] = [];
  const backslash = driver === "mysql" || driver === "mariadb";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") i = lineEnd(sql, i);
    else if (c === "#" && backslash) i = lineEnd(sql, i);
    else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "'" || c === '"' || c === "`") i = quoteEnd(sql, i, c, backslash && c !== "`");
    else if (c === "$" && driver === "postgres") {
      const tag = /^\$[A-Za-z_]?\w*\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end < 0 ? sql.length : end + tag[0].length;
      } else i++;
    } else if (c === ":" && next === ":") i += 2;
    else if (c === ":" && !/[\w:]/.test(sql[i - 1] ?? "")) {
      const m = /^[A-Za-z_]\w*/.exec(sql.slice(i + 1));
      if (m) hits.push({ name: m[0], start: i, end: i + 1 + m[0].length });
      i += 1 + (m?.[0].length ?? 0);
    } else i++;
  }
  return hits;
}

/** Distinct parameter names in order of first use. */
export const paramNames = (sql: string, driver: Driver) => [...new Set(scan(sql, driver).map((h) => h.name))];

/** Replaces each `:name` with its value as typed (raw SQL: quote text yourself, e.g. 'abc'). */
export function bindParams(sql: string, values: Record<string, string>, driver: Driver): string {
  let out = sql;
  for (const h of scan(sql, driver).reverse()) out = out.slice(0, h.start) + values[h.name] + out.slice(h.end);
  return out;
}
