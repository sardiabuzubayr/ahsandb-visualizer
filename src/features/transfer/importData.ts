// Pure helpers behind ImportDialog / ImportSqlDialog (unit-tested in importData.test.ts).
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../lib/api";
import type { Cell, ColumnDef, ColumnMapping, FileFormat, FileOptions, ImportDataOptions, OnError, SchemaNode } from "../../types";

/** Format from the file extension; anything but .json reads as CSV. */
export const formatOf = (path: string): FileFormat => (/\.json$/i.test(path) ? "json" : "csv");

/** Last path segment, for labels. */
export const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Names compare case-insensitively, ignoring "_", "-" and spaces ("Tgl Daftar" ≈ tgl_daftar). */
export const normName = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");

/** Target column per file column by name, or null (skip). Each target is used once: the first file column wins. */
export function autoMap(fileColumns: string[], targetColumns: string[]): (string | null)[] {
  const used = new Set<string>();
  return fileColumns.map((f) => {
    const hit = targetColumns.find((c) => !used.has(c) && normName(c) === normName(f));
    if (hit) used.add(hit);
    return hit ?? null;
  });
}

/** A file column in "new table from file" mode: name and type editable, include=false skips it. */
export interface NewColumn {
  name: string;
  type: string;
  include: boolean;
}

export const newColumns = (fileColumns: string[], types: string[]): NewColumn[] =>
  fileColumns.map((name, i) => ({ name, type: types[i] ?? "text", include: true }));

/** Mapping per file column: the existing-table targets, or the included new-table columns. */
export function mappingOf(targets: (string | null)[], newTable?: NewColumn[]): ColumnMapping[] {
  return newTable
    ? newTable.flatMap((c, source) => (c.include ? [{ source, target: c.name.trim() }] : []))
    : targets.flatMap((target, source) => (target ? [{ source, target }] : []));
}

export function buildImportOptions(p: {
  file: FileOptions;
  schema: string;
  table: string;
  targets: (string | null)[];
  /** Set = create the table first, with only the included columns. */
  newTable?: NewColumn[];
  onError: OnError;
  emptyAsNull: boolean;
}): ImportDataOptions {
  const mapping = mappingOf(p.targets, p.newTable);
  const table = p.table.trim();
  const create = p.newTable && {
    schema: p.schema,
    name: table,
    columns: p.newTable
      .filter((c) => c.include)
      .map((c): ColumnDef => ({ name: c.name.trim(), type: c.type.trim(), nullable: true, autoIncrement: false })),
    primaryKey: [],
    foreignKeys: [],
    indexes: [],
    checks: [],
  };
  return { file: p.file, schema: p.schema, table, ...(create && { create }), mapping, onError: p.onError, emptyAsNull: p.emptyAsNull };
}

export interface MappingCheck {
  /** Targets used by more than one file column (blocks the import). */
  duplicates: string[];
  /** NOT NULL target columns without a default that no file column fills (rows will fail). */
  missingRequired: string[];
  /** New table: blank name or column name/type. */
  blank: boolean;
}

/** `targetColumns` = existing table's columns; omit in new-table mode. */
export function checkMapping(mapping: ColumnMapping[], targetColumns?: ColumnDef[], newTable?: { table: string; columns: NewColumn[] }): MappingCheck {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const m of mapping) (seen.has(normName(m.target)) ? dup : seen).add(normName(m.target));
  const duplicates = [...new Set(mapping.filter((m) => dup.has(normName(m.target))).map((m) => m.target))];
  const missingRequired = (targetColumns ?? [])
    .filter((c) => !c.nullable && c.default == null && !c.autoIncrement && !seen.has(normName(c.name)))
    .map((c) => c.name);
  const blank = !!newTable && (!newTable.table.trim() || newTable.columns.some((c) => c.include && (!c.name.trim() || !c.type.trim())));
  return { duplicates, missingRequired, blank };
}

export const canImport = (mapping: ColumnMapping[], c: MappingCheck) => mapping.length > 0 && !c.duplicates.length && !c.blank;

/** Preview rows as they will land: mapped columns only, "" → NULL when emptyAsNull. */
export const landedRows = (rows: Cell[][], mapping: ColumnMapping[], emptyAsNull: boolean): Cell[][] =>
  rows.map((r) => mapping.map((m) => (emptyAsNull && r[m.source] === "" ? null : (r[m.source] ?? null))));

/** Tables in the navigator tree (optionally one database's), with the schema each lives in. */
export function treeTables(nodes: SchemaNode[], database?: string): { schema: string; table: string }[] {
  const out: { schema: string; table: string }[] = [];
  const walk = (ns: SchemaNode[], schema?: string) => {
    for (const n of ns) {
      if (database && n.kind === "database" && n.label !== database) continue;
      if (n.kind === "table") out.push({ schema: n.schema ?? schema ?? "", table: n.label });
      else if (n.children) walk(n.children, n.kind === "schema" || n.kind === "database" ? n.label : schema);
    }
  };
  walk(nodes);
  return out;
}

/** OS open dialog (Tauri); in the browser a fixed mock path so the mock flow works. Null = cancelled. */
export async function pickFile(name: string, extensions: string[], mockPath: string): Promise<string | null> {
  if (!isTauri) return mockPath;
  return invoke<string | null>("plugin:dialog|open", { options: { multiple: false, directory: false, filters: [{ name, extensions }] } });
}
