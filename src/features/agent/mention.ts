/** `@table` mentions in the agent composer. */

export interface Mention {
  /** Index of the "@". */
  start: number;
  /** What was typed after it (up to the caret). */
  query: string;
}

/** The mention being typed at the caret: an "@" at the start or after a space/bracket, followed by name characters. */
export function mentionAt(text: string, caret: number): Mention | null {
  const m = /(^|[\s(["'])@([\w$.]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/** Tables matching the query: name prefix first, then contains; case-insensitive, alphabetical within each. */
export function matchTables(tables: string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  const sorted = [...tables].sort((a, b) => a.localeCompare(b));
  const starts = sorted.filter((t) => t.toLowerCase().startsWith(q));
  const contains = q ? sorted.filter((t) => !t.toLowerCase().startsWith(q) && t.toLowerCase().includes(q)) : [];
  return [...starts, ...contains].slice(0, limit);
}

/** Text and caret after picking `table` for the mention. */
export function insertMention(text: string, m: Mention, caret: number, table: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const insert = `@${table}${after.startsWith(" ") ? "" : " "}`;
  return { text: text.slice(0, m.start) + insert + after, caret: m.start + insert.length };
}
