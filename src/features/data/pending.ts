import type { Cell, Column, PendingChange, RowChange } from "../../types";

/** `key` is the row's primary key for existing rows, or the insert's tempId for new rows. */
export type PendingAction =
  | { type: "edit"; key: string; column: string; from: Cell; to: Cell }
  | { type: "add"; tempId: string; values: Record<string, Cell> }
  | { type: "delete"; key: string }
  | { type: "discard" };

export function pendingReducer(list: PendingChange[], a: PendingAction): PendingChange[] {
  switch (a.type) {
    case "edit": {
      if (list.some((c) => c.kind === "insert" && c.tempId === a.key))
        return list.map((c) =>
          c.kind === "insert" && c.tempId === a.key ? { ...c, values: { ...c.values, [a.column]: a.to } } : c,
        );
      const i = list.findIndex((c) => c.kind === "update" && c.rowKey === a.key && c.column === a.column);
      const from = i >= 0 ? (list[i] as Extract<PendingChange, { kind: "update" }>).from : a.from;
      if (a.to === from) return list.filter((_, j) => j !== i);
      const change: PendingChange = { kind: "update", rowKey: a.key, column: a.column, from, to: a.to };
      return i >= 0 ? list.map((c, j) => (j === i ? change : c)) : [...list, change];
    }
    case "add":
      return [...list, { kind: "insert", tempId: a.tempId, values: a.values }];
    case "delete": {
      // A new row just disappears; an existing row toggles its DELETE entry.
      if (list.some((c) => c.kind === "insert" && c.tempId === a.key))
        return list.filter((c) => !(c.kind === "insert" && c.tempId === a.key));
      if (list.some((c) => c.kind === "delete" && c.rowKey === a.key))
        return list.filter((c) => !(c.kind === "delete" && c.rowKey === a.key));
      return [...list, { kind: "delete", rowKey: a.key }];
    }
    case "discard":
      return [];
  }
}

/** Row identity in the grid: joined primary-key values, or the row index when there is no PK. */
export const rowKeyOf = (row: Cell[], pkIdxs: number[], i: number) =>
  pkIdxs.length ? pkIdxs.map((j) => String(row[j])).join("|") : String(i);

/** A pending change points at a row that is no longer loaded (e.g. the page was re-sorted). */
export class RowGone extends Error {
  constructor(public rowKey: string) {
    super(`row ${rowKey} is no longer loaded`);
  }
}

/**
 * Pending grid edits → backend RowChanges. Keys are the PK values of the row as loaded (so editing a PK
 * cell still targets the original row); updates per row are merged; edits on a deleted row are dropped;
 * inserts carry only the cells the user set (absent = column default, null = explicit NULL).
 * Order: deletes, updates, inserts — so a deleted row's unique values can be reused by a new row.
 */
export function toRowChanges(list: PendingChange[], columns: Column[], rows: Cell[][]): RowChange[] {
  const pkIdxs = columns.flatMap((c, i) => (c.pk ? [i] : []));
  const byKey = new Map(rows.map((r, i) => [rowKeyOf(r, pkIdxs, i), r]));
  const keyOf = (rowKey: string): Record<string, Cell> => {
    const row = byKey.get(rowKey);
    if (!row || !pkIdxs.length) throw new RowGone(rowKey);
    return Object.fromEntries(pkIdxs.map((j) => [columns[j].name, row[j]]));
  };
  const deleted = list.flatMap((c) => (c.kind === "delete" ? [c.rowKey] : []));
  const updates = new Map<string, Record<string, Cell>>();
  for (const c of list)
    if (c.kind === "update" && !deleted.includes(c.rowKey)) updates.set(c.rowKey, { ...updates.get(c.rowKey), [c.column]: c.to });
  return [
    ...deleted.map((k): RowChange => ({ kind: "delete", key: keyOf(k) })),
    ...[...updates].map(([k, values]): RowChange => ({ kind: "update", key: keyOf(k), values })),
    ...list.flatMap((c): RowChange[] => (c.kind === "insert" ? [{ kind: "insert", values: { ...c.values } }] : [])),
  ];
}
