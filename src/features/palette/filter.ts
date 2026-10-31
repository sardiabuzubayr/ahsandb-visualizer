/** [start, end) of the matched substring; [0, 0] when the query is empty. */
export type Range = [number, number];

/** Case-insensitive substring match. Empty query matches everything. */
export function matchRange(text: string, query: string): Range | null {
  const q = query.trim().toLowerCase();
  if (!q) return [0, 0];
  const i = text.toLowerCase().indexOf(q);
  return i < 0 ? null : [i, i + q.length];
}

/** Items whose label matches, in their original order, each with its highlight range. */
export function filterItems<T extends { label: string }>(items: T[], query: string): (T & { range: Range })[] {
  const out: (T & { range: Range })[] = [];
  for (const it of items) {
    const range = matchRange(it.label, query);
    if (range) out.push({ ...it, range });
  }
  return out;
}
