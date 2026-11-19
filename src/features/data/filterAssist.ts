/** Words in a WHERE filter that are SQL, not column names. */
const KEYWORDS = new Set(
  `and or not null is in like ilike between true false unknown any all some exists case when then else end cast as
  distinct from similar to escape interval date time timestamp zone at with without collate asc desc array
  current_date current_time current_timestamp localtime localtimestamp current_user session_user user
  rlike regexp glob match against binary div mod xor`.split(/\s+/),
);

/** The identifier being typed at `caret` (none inside a string literal or quoted name). */
export function wordAt(text: string, caret: number): { start: number; word: string } | null {
  const before = text.slice(0, caret);
  if ((before.match(/'/g)?.length ?? 0) % 2 || (before.match(/"/g)?.length ?? 0) % 2 || (before.match(/`/g)?.length ?? 0) % 2) return null;
  const m = /[A-Za-z_][\w$]*$/.exec(before);
  if (!m || /[\w$]/.test(text[caret] ?? "")) return null; // only at the end of a word
  if (/(::|\.)\s*$/.test(before.slice(0, m.index))) return null; // a cast type or a qualified name
  return { start: m.index, word: m[0] };
}

/** Columns for a partly typed word: prefix matches first, then the rest that contain it. */
export function suggest(word: string, columns: string[], max = 8): string[] {
  const w = word.toLowerCase();
  const prefix = columns.filter((c) => c.toLowerCase().startsWith(w));
  const inside = columns.filter((c) => !c.toLowerCase().startsWith(w) && c.toLowerCase().includes(w));
  return [...prefix, ...inside].filter((c) => c.toLowerCase() !== w).slice(0, max);
}

/**
 * Names in the filter that aren't columns of the table. Skips string literals, numbers, keywords,
 * function names (followed by `(`), cast types (after `::` or AS) and qualifiers (before `.`).
 * Bare names compare case-insensitively, quoted names exactly.
 */
export function unknownColumns(filter: string, columns: string[]): string[] {
  const lower = new Set(columns.map((c) => c.toLowerCase()));
  const exact = new Set(columns);
  const out = new Set<string>();
  const re = /'(?:[^']|'')*'?|\$\$[\s\S]*?(?:\$\$|$)|"((?:[^"]|"")*)"?|`((?:[^`]|``)*)`?|(\d[\w.]*)|([A-Za-z_][\w$]*)/g;
  let prev = "";
  let prevEnd = 0;
  for (let m; (m = re.exec(filter)); ) {
    const [tok, dq, bq, num, bare] = m;
    const between = filter.slice(prevEnd, m.index);
    const after = filter.slice(m.index + tok.length);
    const skip = /::\s*$/.test(between) || /^\s*[.(]/.test(after) || prev.toLowerCase() === "as" || /\.\s*$/.test(between);
    if (!skip && num === undefined) {
      const quoted = dq ?? bq;
      if (quoted !== undefined) {
        const name = quoted.replace(/""|``/g, (q) => q[0]);
        if (!exact.has(name)) out.add(name);
      } else if (bare !== undefined && !KEYWORDS.has(bare.toLowerCase()) && !lower.has(bare.toLowerCase())) out.add(bare);
    }
    prev = tok;
    prevEnd = m.index + tok.length;
  }
  return [...out];
}
