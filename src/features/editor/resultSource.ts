import type { Column, ColumnOrigin, ForeignKeyDef } from "../../types";

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
 * The foreign key each result column is part of in its source table, with the result's column names for
 * that table (lowercased, "" for other columns) so `followForeignKey` can read the key values from a row.
 */
export function columnForeignKeys(
  sources: (ColumnOrigin | undefined)[],
  tables: { schema: string; table: string; foreignKeys: ForeignKeyDef[] }[],
): ({ fk: ForeignKeyDef; schema: string; columns: string[] } | undefined)[] {
  return sources.map((s) => {
    const tb = s && tables.find((x) => x.schema === s.schema && x.table === s.table);
    const col = s?.column.toLowerCase();
    const fk = tb?.foreignKeys.find((f) => f.columns.some((c) => c.toLowerCase() === col));
    if (!fk || !tb) return undefined;
    const columns = sources.map((o) => (o?.schema === tb.schema && o.table === tb.table ? o.column.toLowerCase() : ""));
    return { fk: { ...fk, columns: fk.columns.map((c) => c.toLowerCase()) }, schema: tb.schema, columns };
  });
}

/**
 * First table whose whole primary key is in the result: its rows can be edited and deleted by those
 * columns. `keyIdxs` are result column indexes (ascending), `keyNames` the table's column names for them,
 * `tableCols` the table column behind each result column (undefined: another table or an expression),
 * `complete` whether every table column is in the result (rows can then be duplicated).
 */
export function editTarget(
  sources: (ColumnOrigin | undefined)[],
  tableColumns: { schema: string; table: string; columns: Column[] }[],
): { schema: string; table: string; keyIdxs: number[]; keyNames: string[]; tableCols: (Column | undefined)[]; complete: boolean } | null {
  for (const { schema, table, columns } of tableColumns) {
    const pk = columns.filter((c) => c.pk);
    if (!pk.length) continue;
    const idxs = pk.map((p) =>
      sources.findIndex((s) => s?.schema === schema && s.table === table && s.column.toLowerCase() === p.name.toLowerCase()),
    );
    if (idxs.some((i) => i < 0)) continue;
    const order = idxs.map((idx, k) => [idx, pk[k].name] as const).sort((a, b) => a[0] - b[0]);
    const tableCols = sources.map((s) =>
      s?.schema === schema && s.table === table ? columns.find((c) => c.name.toLowerCase() === s.column.toLowerCase()) : undefined,
    );
    return {
      schema,
      table,
      keyIdxs: order.map((o) => o[0]),
      keyNames: order.map((o) => o[1]),
      tableCols,
      complete: columns.every((c) => tableCols.includes(c)),
    };
  }
  return null;
}
