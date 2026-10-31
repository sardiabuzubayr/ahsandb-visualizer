import type { TFn } from "../../i18n";
import type { ColumnDef, Driver, ErColumn, ErModel, ForeignKeyDef, TableChange, TableDef } from "../../types";

/** Unapplied ER edits. Keys are node ids: an existing table's name, or "__new__…" for a table added in the draft. */
export interface Draft {
  /** Existing tables as loaded from the database (loaded lazily on first edit). */
  originals: Record<string, TableDef>;
  /** Target definition of every loaded or new table. */
  tables: Record<string, TableDef>;
  /** Existing tables to drop. */
  dropped: string[];
}

export const emptyDraft: Draft = { originals: {}, tables: {}, dropped: [] };

export type ColumnPatch = Partial<Omit<ColumnDef, "originalName">> & { pk?: boolean };

export type DraftAction =
  | { type: "loaded"; id: string; def: TableDef }
  | { type: "addTable"; id: string; schema: string; name: string; driver: Driver }
  | { type: "renameTable"; id: string; name: string }
  | { type: "addColumn"; id: string }
  | { type: "updateColumn"; id: string; column: string; patch: ColumnPatch }
  | { type: "removeColumn"; id: string; column: string }
  /** New table: removed from the draft. Existing table: toggles a drop. */
  | { type: "removeTable"; id: string }
  | { type: "addFk"; id: string; fk: ForeignKeyDef }
  | { type: "removeFk"; id: string; columns: string[]; refTable: string }
  | { type: "discard" };

const rename = (cols: string[], from: string, to: string) => cols.map((c) => (c === from ? to : c));
const sameFk = (a: ForeignKeyDef, b: ForeignKeyDef) =>
  a.refTable === b.refTable && a.columns.join() === b.columns.join() && a.refColumns.join() === b.refColumns.join();
const mapTables = (tables: Record<string, TableDef>, fn: (t: TableDef) => TableDef) =>
  Object.fromEntries(Object.entries(tables).map(([k, t]) => [k, fn(t)]));
const unique = (base: string, taken: string[]) => {
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base}_${i}`;
  return name;
};

export function draftReducer(d: Draft, a: DraftAction): Draft {
  if (a.type === "discard") return emptyDraft;
  if (a.type === "loaded") {
    if (d.tables[a.id]) return d;
    // originalName marks existing columns, so a rename isn't read as drop + add.
    const def = { ...a.def, columns: a.def.columns.map((c) => ({ ...c, originalName: c.originalName ?? c.name })) };
    return { ...d, originals: { ...d.originals, [a.id]: def }, tables: { ...d.tables, [a.id]: def } };
  }
  if (a.type === "addTable") {
    const id: ColumnDef = { name: "id", type: a.driver === "sqlite" ? "integer" : "bigint", nullable: false, autoIncrement: true };
    const table: TableDef = { schema: a.schema, name: a.name, columns: [id], primaryKey: ["id"], foreignKeys: [], indexes: [], checks: [] };
    return { ...d, tables: { ...d.tables, [a.id]: table } };
  }
  const t = d.tables[a.id];
  if (!t) return d;
  const put = (next: TableDef, tables = d.tables): Draft => ({ ...d, tables: { ...tables, [a.id]: next } });

  switch (a.type) {
    case "renameTable": {
      // FKs drafted against the new table follow its name.
      const tables = mapTables(d.tables, (x) => ({
        ...x,
        foreignKeys: x.foreignKeys.map((fk) => (fk.refTable === t.name ? { ...fk, refTable: a.name } : fk)),
      }));
      return put({ ...tables[a.id], name: a.name }, tables);
    }
    case "addColumn": {
      const name = unique("column", t.columns.map((c) => c.name));
      return put({ ...t, columns: [...t.columns, { name, type: "text", nullable: true, autoIncrement: false }] });
    }
    case "updateColumn": {
      const col = t.columns.find((c) => c.name === a.column);
      if (!col) return d;
      const { pk, ...patch } = a.patch;
      const next = { ...col, ...patch };
      let tables = d.tables;
      let target: TableDef = { ...t, columns: t.columns.map((c) => (c === col ? next : c)) };
      if (next.name !== col.name) {
        const r = (cols: string[]) => rename(cols, col.name, next.name);
        target = {
          ...target,
          primaryKey: r(target.primaryKey),
          foreignKeys: target.foreignKeys.map((fk) => ({ ...fk, columns: r(fk.columns) })),
          indexes: target.indexes.map((ix) => ({ ...ix, columns: r(ix.columns) })),
        };
        tables = mapTables({ ...tables, [a.id]: target }, (x) => ({
          ...x,
          foreignKeys: x.foreignKeys.map((fk) => (fk.refTable === t.name ? { ...fk, refColumns: r(fk.refColumns) } : fk)),
        }));
        target = tables[a.id];
      }
      if (pk !== undefined) {
        const rest = target.primaryKey.filter((c) => c !== next.name);
        target = {
          ...target,
          primaryKey: pk ? [...rest, next.name] : rest,
          // PK columns can't be NULL.
          columns: pk ? target.columns.map((c) => (c.name === next.name ? { ...c, nullable: false } : c)) : target.columns,
        };
      }
      return put(target, tables);
    }
    case "removeColumn": {
      const keep = (cols: string[]) => !cols.includes(a.column);
      const tables = mapTables(d.tables, (x) => ({
        ...x,
        foreignKeys: x.foreignKeys.filter((fk) => fk.refTable !== t.name || keep(fk.refColumns)),
      }));
      const x = tables[a.id];
      return put(
        {
          ...x,
          columns: x.columns.filter((c) => c.name !== a.column),
          primaryKey: x.primaryKey.filter((c) => c !== a.column),
          foreignKeys: x.foreignKeys.filter((fk) => keep(fk.columns)),
          indexes: x.indexes.filter((ix) => keep(ix.columns)),
        },
        tables,
      );
    }
    case "removeTable": {
      if (d.originals[a.id])
        return { ...d, dropped: d.dropped.includes(a.id) ? d.dropped.filter((x) => x !== a.id) : [...d.dropped, a.id] };
      const { [a.id]: _gone, ...rest } = d.tables;
      return {
        ...d,
        tables: mapTables(rest, (x) => ({ ...x, foreignKeys: x.foreignKeys.filter((fk) => fk.refTable !== t.name) })),
      };
    }
    case "addFk":
      return t.foreignKeys.some((fk) => sameFk(fk, a.fk)) ? d : put({ ...t, foreignKeys: [...t.foreignKeys, a.fk] });
    case "removeFk":
      return put({
        ...t,
        foreignKeys: t.foreignKeys.filter((fk) => fk.refTable !== a.refTable || !a.columns.every((c) => fk.columns.includes(c))),
      });
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Creates first (new tables may be referenced by later alters), then alters, then drops. Untouched loaded tables are skipped. */
export function toChanges(d: Draft): TableChange[] {
  const creates: TableChange[] = [];
  const alters: TableChange[] = [];
  for (const [id, target] of Object.entries(d.tables)) {
    const original = d.originals[id];
    if (!original) creates.push({ target });
    else if (!d.dropped.includes(id) && !same(original, target)) alters.push({ original, target });
  }
  return [...creates, ...alters, ...d.dropped.map((id) => ({ original: d.originals[id] }))];
}

/** What to send to previewSchemaChanges; null = don't call (no draft, or the connection can't apply anyway). */
export function previewChanges(d: Draft, readOnly: boolean): TableChange[] | null {
  const changes = toChanges(d);
  return changes.length && !readOnly ? changes : null;
}

const ALIASES: Record<string, string> = {
  serial: "integer", int: "integer", int4: "integer", bigserial: "bigint", int8: "bigint", smallserial: "smallint", int2: "smallint",
};
const normType = (s: string) => {
  const v = s.toLowerCase().replace(/\s+/g, " ").trim();
  return ALIASES[v] ?? v;
};
export const typesDiffer = (a?: string, b?: string) => !!a && !!b && normType(a) !== normType(b);

export interface Chip {
  text: string;
  /** FK between columns of different types. */
  warn?: boolean;
}

/** One chip per change for the draft banner; `typeOf` looks up a column type anywhere in the diagram. */
export function draftChips(d: Draft, typeOf: (table: string, column: string) => string | undefined, t: TFn): Chip[] {
  const fkChips = (table: TableDef, fks: ForeignKeyDef[], sign: string) =>
    fks.map((fk) => ({
      text: `${sign} FK ${table.name} → ${fk.refTable}`,
      warn:
        sign === "+" &&
        fk.columns.some((c, i) => typesDiffer(table.columns.find((x) => x.name === c)?.type, typeOf(fk.refTable, fk.refColumns[i]))),
    }));
  return toChanges(d).flatMap(({ original: o, target: n }): Chip[] => {
    if (!o) return [{ text: t("er.chipTable", { name: n!.name }) }, ...fkChips(n!, n!.foreignKeys, "+")];
    if (!n) return [{ text: t("er.chipDrop", { name: o.name }) }];
    const chips: Chip[] = [];
    for (const c of n.columns) {
      const before = o.columns.find((x) => x.name === c.originalName);
      if (!before) chips.push({ text: `+ ${n.name}.${c.name}` });
      else {
        if (before.name !== c.name) chips.push({ text: `${n.name}.${before.name} → ${c.name}` });
        if (!same({ ...before, name: "" }, { ...c, name: "" })) chips.push({ text: `~ ${n.name}.${c.name}` });
      }
    }
    for (const c of o.columns) if (!n.columns.some((x) => x.originalName === c.name)) chips.push({ text: `− ${n.name}.${c.name}` });
    // PK compared by original column names so a rename alone isn't a PK change.
    const pkNames = n.primaryKey.map((p) => n.columns.find((c) => c.name === p)?.originalName ?? p);
    if (!same(pkNames, o.primaryKey)) chips.push({ text: `~ ${n.name} PK` });
    const renamedBack = (fk: ForeignKeyDef) => ({
      ...fk,
      columns: fk.columns.map((c) => n.columns.find((x) => x.name === c)?.originalName ?? c),
    });
    chips.push(...fkChips(n, n.foreignKeys.filter((fk) => !o.foreignKeys.some((x) => sameFk(x, renamedBack(fk)))), "+"));
    chips.push(...fkChips(o, o.foreignKeys.filter((fk) => !n.foreignKeys.some((x) => sameFk(fk, renamedBack(x)))), "−"));
    return chips;
  });
}

export interface ViewColumn extends ErColumn {
  changed?: boolean;
}
export interface ViewFk {
  columns: string[];
  refTable: string;
  refColumns: string[];
  draft: boolean;
}
export interface ViewTable {
  id: string;
  name: string;
  rows: string;
  columns: ViewColumn[];
  fks: ViewFk[];
  isNew: boolean;
  dropped: boolean;
}

/** What the diagram shows: the loaded model with the draft applied. */
export function buildView(model: ErModel, d: Draft): ViewTable[] {
  const fromDef = (id: string, def: TableDef, rows: string): ViewTable => {
    const o = d.originals[id];
    return {
      id,
      name: def.name,
      rows,
      isNew: !o,
      dropped: d.dropped.includes(id),
      columns: def.columns.map((c) => {
        const before = o?.columns.find((x) => x.name === c.originalName);
        return {
          name: c.name,
          type: c.type,
          pk: def.primaryKey.includes(c.name),
          fk: def.foreignKeys.some((fk) => fk.columns.includes(c.name)),
          draft: !!o && !before,
          changed: !!before && !same(before, c),
        };
      }),
      fks: def.foreignKeys.map((fk) => ({ ...fk, draft: !o?.foreignKeys.some((x) => sameFk(x, fk)) })),
    };
  };
  const existing = model.tables.map((m) =>
    d.tables[m.name]
      ? fromDef(m.name, d.tables[m.name], m.rows)
      : {
          id: m.name,
          name: m.name,
          rows: m.rows,
          columns: m.columns,
          isNew: false,
          dropped: false,
          fks: model.relations
            .filter((r) => r.from === m.name)
            .map((r) => ({ columns: [r.fromColumn], refTable: r.to, refColumns: [r.toColumn], draft: false })),
        },
  );
  const added = Object.entries(d.tables)
    .filter(([id]) => !d.originals[id])
    .map(([id, def]) => fromDef(id, def, ""));
  return [...existing, ...added];
}
