import type { ColumnDef, Driver, TableChange, TableDef } from "../../types";

/** New-table target suffix: "schema.__new__<id>". */
export const NEW_PREFIX = "__new__";

/** Type suggestions for the column type input (free text is still allowed). */
export const TYPE_SUGGESTIONS: Record<Driver, string[]> = {
  postgres: [
    "bigint", "integer", "smallint", "numeric(14,2)", "real", "double precision", "boolean", "text", "varchar(255)",
    "char(1)", "date", "timestamp", "timestamptz", "time", "interval", "uuid", "json", "jsonb", "bytea", "inet",
  ],
  mysql: [
    "bigint", "int", "smallint", "tinyint(1)", "decimal(14,2)", "double", "float", "varchar(255)", "char(1)", "text",
    "longtext", "date", "datetime", "timestamp", "time", "json", "blob",
  ],
  mariadb: [
    "bigint", "int", "smallint", "tinyint(1)", "decimal(14,2)", "double", "float", "varchar(255)", "char(1)", "text",
    "longtext", "date", "datetime", "timestamp", "time", "json", "blob",
  ],
  sqlite: ["integer", "real", "text", "blob", "numeric"],
  redis: [],
};

export const ON_DELETE = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"];

const idType = (d: Driver) => (d === "sqlite" ? "integer" : "bigint");
const textType = (d: Driver) => (d === "mysql" || d === "mariadb" ? "varchar(255)" : "text");

/** A new table starts with an auto-increment `id` primary key. */
export function newTableDef(schema: string, driver: Driver): TableDef {
  return {
    schema,
    name: "",
    columns: [{ name: "id", type: idType(driver), nullable: false, autoIncrement: true }],
    primaryKey: ["id"],
    foreignKeys: [],
    indexes: [],
    checks: [],
  };
}

/** A column added in the designer: no originalName, so the backend plans ADD COLUMN. */
export const newColumn = (n: number, driver: Driver): ColumnDef => ({
  name: `column_${n}`,
  type: textType(driver),
  nullable: true,
  autoIncrement: false,
});

const rename = (list: string[], from: string, to: string) => list.map((x) => (x === from ? to : x));

/** Renames column i and every reference to it (PK, FKs, indexes); originalName is kept so it is a rename. */
export function renameColumn(def: TableDef, i: number, name: string): TableDef {
  const from = def.columns[i].name;
  return {
    ...def,
    columns: def.columns.map((c, j) => (j === i ? { ...c, name } : c)),
    primaryKey: rename(def.primaryKey, from, name),
    foreignKeys: def.foreignKeys.map((f) => ({ ...f, columns: rename(f.columns, from, name) })),
    indexes: def.indexes.map((x) => ({ ...x, columns: rename(x.columns, from, name) })),
  };
}

/** Removes column i and its references; FKs and indexes left with no columns go too. */
export function removeColumn(def: TableDef, i: number): TableDef {
  const name = def.columns[i].name;
  const drop = (l: string[]) => l.filter((x) => x !== name);
  return {
    ...def,
    columns: def.columns.filter((_, j) => j !== i),
    primaryKey: drop(def.primaryKey),
    foreignKeys: def.foreignKeys.flatMap((f) => (f.columns.includes(name) ? [] : [f])),
    indexes: def.indexes.map((x) => ({ ...x, columns: drop(x.columns) })).filter((x) => x.columns.length),
  };
}

/** PK checkbox: appending keeps an existing composite key's order. PK columns are NOT NULL. */
export function togglePk(def: TableDef, name: string): TableDef {
  const on = def.primaryKey.includes(name);
  return {
    ...def,
    primaryKey: on ? def.primaryKey.filter((x) => x !== name) : [...def.primaryKey, name],
    columns: on ? def.columns : def.columns.map((c) => (c.name === name ? { ...c, nullable: false } : c)),
  };
}

/** "a, b ,c" → ["a","b","c"]. */
export const parseList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

const opt = (s: string | undefined) => (s?.trim() ? s.trim() : undefined);

/** Trimmed TableDef as sent to the backend: blank optionals dropped, blank checks removed. */
export function normalize(def: TableDef): TableDef {
  return {
    schema: def.schema,
    name: def.name.trim(),
    columns: def.columns.map((c) => ({
      name: c.name.trim(),
      ...(c.originalName !== undefined && { originalName: c.originalName }),
      type: c.type.trim(),
      nullable: c.nullable,
      ...(opt(c.default) !== undefined && { default: opt(c.default) }),
      autoIncrement: c.autoIncrement,
    })),
    primaryKey: def.primaryKey.map((x) => x.trim()),
    foreignKeys: def.foreignKeys.map((f) => ({
      ...(opt(f.name) && { name: opt(f.name) }),
      columns: f.columns,
      ...(opt(f.refSchema) && { refSchema: opt(f.refSchema) }),
      refTable: f.refTable.trim(),
      refColumns: f.refColumns,
      ...(opt(f.onDelete) && { onDelete: opt(f.onDelete) }),
      ...(opt(f.onUpdate) && { onUpdate: opt(f.onUpdate) }),
    })),
    indexes: def.indexes.map((x) => ({ name: x.name.trim(), columns: x.columns, unique: x.unique })),
    checks: def.checks.flatMap((c) => (c.expression.trim() ? [{ ...(opt(c.name) && { name: opt(c.name) }), expression: c.expression.trim() }] : [])),
  };
}

export const sameDef = (a: TableDef, b: TableDef) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

export interface Problem {
  key: string;
  vars?: Record<string, string | number>;
}

/** Problems that block Review; empty = valid. */
export function validate(def: TableDef): Problem[] {
  const d = normalize(def);
  const out: Problem[] = [];
  if (!d.name) out.push({ key: "designer.err.tableName" });
  if (!d.columns.length) out.push({ key: "designer.err.noColumns" });
  const names = d.columns.map((c) => c.name);
  d.columns.forEach((c, i) => {
    if (!c.name) out.push({ key: "designer.err.columnName", vars: { n: i + 1 } });
    else if (names.indexOf(c.name) !== i) out.push({ key: "designer.err.duplicate", vars: { name: c.name } });
    if (!c.type) out.push({ key: "designer.err.type", vars: { name: c.name || String(i + 1) } });
  });
  const unknown = (l: string[]) => l.find((x) => !names.includes(x));
  d.foreignKeys.forEach((f, i) => {
    const bad = unknown(f.columns);
    if (!f.columns.length || !f.refTable || f.refColumns.length !== f.columns.length)
      out.push({ key: "designer.err.fk", vars: { n: i + 1 } });
    else if (bad) out.push({ key: "designer.err.unknownColumn", vars: { name: bad } });
  });
  d.indexes.forEach((x, i) => {
    const bad = unknown(x.columns);
    if (!x.name || !x.columns.length) out.push({ key: "designer.err.index", vars: { n: i + 1 } });
    else if (bad) out.push({ key: "designer.err.unknownColumn", vars: { name: bad } });
  });
  return out;
}

/** The change sent to previewSchemaChanges: create when there is no original, alter otherwise. */
export const schemaChange = (original: TableDef | null, form: TableDef): TableChange =>
  original ? { original, target: normalize(form) } : { target: normalize(form) };
