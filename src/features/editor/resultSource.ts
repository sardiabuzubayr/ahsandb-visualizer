import type { Column, ColumnOrigin } from "../../types";

const IDENT = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[\w$]+)`;
const FROM = new RegExp(
  String.raw`^select\s+(?:all\s+|distinct\s+)?([\s\S]+?)\s+from\s+(${IDENT}(?:\s*\.\s*${IDENT})?)(?:\s+(?:as\s+)?(${IDENT}))?(?:\s+(?:where|order|limit|offset|fetch|for|group|having)\b[\s\S]*)?$`,
  "i",
);
const ITEM = new RegExp(String.raw`^(?:(${IDENT})\s*\.\s*)?(${IDENT}|\*)(?:\s+(?:as\s+)?(${IDENT}))?$`, "i");
const unquote = (s: string) => s.replace(/^["`[](.*)["`\]]$/, "$1");

/**
 * Table column behind each result column: the server's origin (PostgreSQL), else, for a plain
 * single-table SELECT of bare columns (`SELECT a, b AS c FROM t WHERE …`), the table it names.
 * Anything else (joins, expressions, unions) gives no source, so the rows can't be deleted.
 */
export function columnSources(columns: Column[], sql: string | undefined, defaultSchema: string): (ColumnOrigin | undefined)[] {
  if (columns.some((c) => c.origin)) return columns.map((c) => c.origin);
  const m = FROM.exec(
    (sql ?? "")
      .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ")
      .trim()
      .replace(/;$/, "")
      .trim(),
  );
  if (!m) return columns.map(() => undefined);
  const [, list, target, alias] = m;
  const parts = target.split(/\s*\.\s*/).map(unquote);
  const table = parts[parts.length - 1];
  const schema = parts.length > 1 ? parts[0] : defaultSchema;
  const names = new Map<string, string>(); // result name → table column
  let star = false;
  for (const raw of list.split(",")) {
    const it = ITEM.exec(raw.trim());
    if (!it) return columns.map(() => undefined);
    const [, qual, col, as] = it;
    if (qual && ![table, alias && unquote(alias)].includes(unquote(qual))) return columns.map(() => undefined);
    if (col === "*") star = true;
    else names.set(unquote(as ?? col).toLowerCase(), unquote(col));
  }
  return columns.map((c) => {
    const column = names.get(c.name.toLowerCase()) ?? (star ? c.name : undefined);
    return column ? { schema, table, column } : undefined;
  });
}

/** Distinct tables the sources point at, in first-seen order. */
export function sourceTables(sources: (ColumnOrigin | undefined)[]): { schema: string; table: string }[] {
  const seen = new Map<string, { schema: string; table: string }>();
  for (const s of sources) if (s && !seen.has(`${s.schema}.${s.table}`)) seen.set(`${s.schema}.${s.table}`, { schema: s.schema, table: s.table });
  return [...seen.values()];
}

/**
 * First table whose whole primary key is in the result: rows can be deleted from it by those
 * columns. `keyIdxs` are result column indexes (ascending), `keyNames` the table's column names for them.
 */
export function deleteTarget(
  sources: (ColumnOrigin | undefined)[],
  tableColumns: { schema: string; table: string; columns: Column[] }[],
): { schema: string; table: string; keyIdxs: number[]; keyNames: string[] } | null {
  for (const { schema, table, columns } of tableColumns) {
    const pk = columns.filter((c) => c.pk);
    if (!pk.length) continue;
    const idxs = pk.map((p) =>
      sources.findIndex((s) => s?.schema === schema && s.table === table && s.column.toLowerCase() === p.name.toLowerCase()),
    );
    if (idxs.some((i) => i < 0)) continue;
    const order = idxs.map((idx, k) => [idx, pk[k].name] as const).sort((a, b) => a[0] - b[0]);
    return { schema, table, keyIdxs: order.map((o) => o[0]), keyNames: order.map((o) => o[1]) };
  }
  return null;
}
