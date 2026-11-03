import { firstDatabase } from "../editor/treeScope";
import { quoteIdent } from "../../components/shell/tree";
import type { Cell, Connection, Driver, ForeignKeyDef, OrderBy } from "../../types";

/** Where unqualified names live when a tab target has no schema part. */
export function defaultSchema(conn: Pick<Connection, "driver" | "database">): string {
  if (conn.driver === "postgres") return "public";
  if (conn.driver === "sqlite") return "main";
  return firstDatabase(conn.database) ?? "";
}

/** Table tabs target "schema.table"; split on the first dot. */
export function splitTarget(target: string, conn: Pick<Connection, "driver" | "database">): { schema: string; table: string } {
  const i = target.indexOf(".");
  return i < 0 ? { schema: defaultSchema(conn), table: target } : { schema: target.slice(0, i), table: target.slice(i + 1) };
}

/** Row selection after a click on row `i`: plain = just it, ⌘/Ctrl = toggle it, Shift = range from the anchor row. */
export function selectRows(
  keys: string[],
  prev: ReadonlySet<string>,
  anchor: number | null,
  i: number,
  mod: { shift: boolean; toggle: boolean },
): Set<string> {
  if (mod.shift && anchor !== null) return new Set(keys.slice(Math.min(anchor, i), Math.max(anchor, i) + 1));
  if (!mod.toggle) return new Set([keys[i]]);
  const next = new Set(prev);
  if (!next.delete(keys[i])) next.add(keys[i]);
  return next;
}

/** Header click cycle: asc → desc → none; another column starts at asc. */
export function nextSort(current: OrderBy | null, column: string): OrderBy | null {
  if (current?.column !== column) return { column, desc: false };
  return current.desc ? null : { column, desc: true };
}

/** macOS smart quotes (‘ ’ “ ”) typed into a SQL text field, turned back into ASCII quotes. */
export function straightQuotes(sql: string): string {
  return sql.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

/** A cell as a SQL literal for the driver (strings quoted, MySQL backslashes escaped). */
export function sqlLiteral(driver: Driver, v: Cell): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const esc = driver === "mysql" || driver === "mariadb" ? s.replace(/\\/g, "\\\\") : s;
  return `'${esc.replace(/'/g, "''")}'`;
}

/** Where a foreign key in `row` points: the referenced table and a WHERE matching its key; null if any part is NULL. */
export function followForeignKey(
  driver: Driver,
  fk: ForeignKeyDef,
  schema: string,
  columns: string[],
  row: Cell[],
): { target: string; table: string; filter: string } | null {
  const values = fk.columns.map((c) => row[columns.indexOf(c)]);
  if (values.some((v) => v === null || v === undefined)) return null;
  const filter = fk.refColumns.map((c, i) => `${quoteIdent(driver, c)} = ${sqlLiteral(driver, values[i])}`).join(" AND ");
  return { target: `${fk.refSchema || schema}.${fk.refTable}`, table: fk.refTable, filter };
}
