// Pure helpers behind ExportDialog / ExportDataDialog: tree → object groups → DumpObject[], file names, options.
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../lib/api";
import type { Connection, DataFormat, DataSource, DumpObject, ExportDataOptions, ObjectKind, SchemaNode } from "../../types";
import { firstDatabase } from "../editor/treeScope";
import { groupState, itemKey, type ExportGroup } from "./selection";

/** Navigator group key (last id segment) → dumped object kind. */
export const GROUP_KINDS: Record<string, ObjectKind> = {
  tables: "table",
  views: "view",
  functions: "function",
  procedures: "procedure",
  triggers: "trigger",
  sequences: "sequence",
  events: "event",
};

/** Nodes whose children are object groups: PostgreSQL schemas, MySQL/MariaDB databases, SQLite's main. */
export function dumpSchemas(nodes: SchemaNode[]): SchemaNode[] {
  return nodes.flatMap((n) =>
    n.children?.some((c) => c.kind === "group") ? [n] : n.kind === "database" || n.kind === "schema" ? dumpSchemas(n.children ?? []) : [],
  );
}

/** The `schema` an export of this node passes to the backend. */
export const schemaName = (n: SchemaNode) => n.schema ?? n.label;

/** PostgreSQL database whose tree an export looks in: the context's, else the one the main pool opens. */
export const treeDatabase = (conn: Pick<Connection, "driver" | "database">, database?: string) =>
  conn.driver === "postgres" ? (database ?? firstDatabase(conn.database) ?? "postgres") : undefined;

/** Object groups of one schema node; tables carry the ER model's row estimate. Empty groups are left out. */
export function exportGroups(schema: SchemaNode | undefined, rows: Record<string, string> = {}): ExportGroup[] {
  return (schema?.children ?? []).flatMap((g) => {
    const key = g.id.split("/").pop() ?? "";
    const items = (g.children ?? []).filter((c) => c.kind !== "more").map((c) => ({ name: c.label, meta: key === "tables" ? (rows[c.label] ?? "") : "" }));
    return g.kind === "group" && GROUP_KINDS[key] && items.length ? [{ key, items }] : [];
  });
}

/** Selected objects for ExportDatabaseOptions.objects: empty when everything is selected (= the whole schema). */
export function dumpObjects(groups: ExportGroup[], sel: Set<string>): DumpObject[] {
  if (groups.every((g) => groupState(g, sel) === "on")) return [];
  return groups.flatMap((g) => g.items.filter((i) => sel.has(itemKey(g.key, i.name))).map((i) => ({ kind: GROUP_KINDS[g.key], name: i.name })));
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local calendar date as YYYY-MM-DD. */
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** `<db>-<schema>-YYYY-MM-DD.sql[.gz]`; db and schema once when equal (MySQL, where the schema is the database). */
export function dumpFileName(db: string, schema: string, date: Date, gz: boolean): string {
  const base = [...new Set([db, schema].filter(Boolean))].join("-") || "dump";
  return `${base}-${isoDay(date)}.sql${gz ? ".gz" : ""}`;
}

/** Name shown for a connection's database in file names: PG database, SQLite file name, else "". */
export const dumpDbName = (conn: Pick<Connection, "driver" | "file">, treeDb?: string) =>
  treeDb ?? (conn.driver === "sqlite" ? (conn.file?.split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, "") : "");

/** Adds or removes the trailing ".gz" when compression is switched. */
export const withGz = (path: string, gz: boolean) => path.replace(/\.gz$/i, "") + (gz ? ".gz" : "");

/** `<table or "query">.<csv|json|sql>` */
export const dataFileName = (name: string, format: DataFormat) => `${name}.${format}`;

/** Swaps a known data extension for the chosen format's (or appends it). */
export const withExt = (path: string, format: DataFormat) => `${path.replace(/\.(csv|json|sql)$/i, "")}.${format}`;

/** Rows per INSERT from a text field; anything not a positive integer → 500. */
export const batchOf = (s: string) => (/^\d+$/.test(s.trim()) && +s > 0 ? +s : 500);

export function exportDataOptions(
  source: DataSource,
  format: DataFormat,
  path: string,
  o: { delimiter: string; header: boolean; batch: string; tableName: string },
): ExportDataOptions {
  if (format === "csv") return { source, format, path, delimiter: o.delimiter, header: o.header };
  if (format === "json") return { source, format, path, header: false };
  return { source, format, path, header: false, batchSize: batchOf(o.batch), tableName: o.tableName.trim() || undefined };
}

/** OS Save dialog (Tauri). Browser mock: null, so the typed path stays. */
export async function pickSavePath(current: string, filter: { name: string; extensions: string[] }): Promise<string | null> {
  if (!isTauri) return null;
  const defaultPath = current.split(/[\\/]/).pop();
  return invoke<string | null>("plugin:dialog|save", { options: { defaultPath, filters: [filter] } });
}
