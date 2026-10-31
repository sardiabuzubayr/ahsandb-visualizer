import type { CheckState } from "../../components/ui";

/** One object kind of a schema in the export dialog; `meta` is a table's row estimate ("2.4k", "" = unknown). */
export interface ExportGroup {
  key: string;
  items: { name: string; meta: string }[];
}

export const itemKey = (group: string, name: string) => `${group}/${name}`;

export const allKeys = (groups: ExportGroup[]) => new Set(groups.flatMap((g) => g.items.map((i) => itemKey(g.key, i.name))));

export const selectedIn = (g: ExportGroup, sel: Set<string>) => g.items.filter((i) => sel.has(itemKey(g.key, i.name))).length;

export function groupState(g: ExportGroup, sel: Set<string>): CheckState {
  const n = selectedIn(g, sel);
  return n === 0 ? "off" : n === g.items.length ? "on" : "mixed";
}

/** Mixed or off → select every item; on → clear the group. */
export function toggleGroup(g: ExportGroup, sel: Set<string>): Set<string> {
  const on = groupState(g, sel) !== "on";
  const next = new Set(sel);
  for (const i of g.items) {
    const k = itemKey(g.key, i.name);
    if (on) next.add(k);
    else next.delete(k);
  }
  return next;
}

export function toggleItem(key: string, sel: Set<string>): Set<string> {
  const next = new Set(sel);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** "2.4k" → 2400, "1.2M" → 1200000, "860" → 860, "" → 0. */
export const parseCount = (s: string) =>
  Math.round(parseFloat(s || "0") * (s.endsWith("k") ? 1000 : s.endsWith("M") ? 1_000_000 : 1));

export function estimate(groups: ExportGroup[], sel: Set<string>) {
  let rows = 0;
  let tables = 0;
  let others = 0;
  for (const g of groups)
    for (const i of g.items) {
      if (!sel.has(itemKey(g.key, i.name))) continue;
      if (g.key === "tables") {
        tables++;
        rows += parseCount(i.meta);
      } else others++;
    }
  return { rows, tables, others };
}
