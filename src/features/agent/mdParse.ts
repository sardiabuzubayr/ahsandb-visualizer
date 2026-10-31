// A small Markdown subset for agent replies, parsed to a tree (rendered as React elements, never as HTML):
// paragraphs, # headings, -/*/1. lists (one nesting level by indent), ``` code, | tables |, > quotes,
// and inline **bold**, *italic*, `code`, [links](url).

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export interface ListItem {
  c: Inline[];
  sub?: Block;
}

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "quote"; c: Block[] };

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => inline(c.trim()));

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of text)
      out.push({ t: "code", lang: fence[1], v: body.join("\n") });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push({ t: "h", level: h[1].length, c: inline(h[2].replace(/\s+#+\s*$/, "")) });
      i++;
      continue;
    }
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cells(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
      out.push({ t: "table", head, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push({ t: "quote", c: parseMarkdown(body.join("\n")) });
      continue;
    }
    if (LIST.test(line)) {
      const [block, next] = parseList(lines, i);
      out.push(block);
      i = next;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && !/^(#{1,6}\s|\s*```|\s*>)/.test(lines[i]) && !(isRow(lines[i]) && isSep(lines[i + 1] ?? ""))) {
      para.push(lines[i++].trim());
    }
    out.push({ t: "p", c: inline(para.join("\n")) });
  }
  return out;
}

/** A list starting at line `i`; lines indented deeper than its marker form one nested list. */
function parseList(lines: string[], i: number): [Block, number] {
  const first = lines[i].match(LIST)!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: ListItem[] = [];
  while (i < lines.length) {
    const m = lines[i].match(LIST);
    if (!m) {
      // Continuation text of the previous item (indented, non-blank).
      if (items.length && lines[i].trim() && /^\s+/.test(lines[i])) {
        items[items.length - 1].c.push({ t: "text", v: "\n" }, ...inline(lines[i].trim()));
        i++;
        continue;
      }
      // A blank line inside the list continues it when the next line is another item at this level.
      if (!lines[i].trim() && LIST.test(lines[i + 1] ?? "") && (lines[i + 1].match(LIST)![1].length >= indent)) {
        i++;
        continue;
      }
      break;
    }
    if (m[1].length > indent && items.length) {
      const [sub, next] = parseList(lines, i);
      items[items.length - 1].sub = sub;
      i = next;
      continue;
    }
    if (m[1].length < indent || /\d/.test(m[2]) !== ordered) break;
    items.push({ c: inline(m[3]) });
    i++;
  }
  return [{ t: "list", ordered, start: ordered ? parseInt(first[2], 10) || 1 : 1, items }, i];
}

/** Inline spans: `code` first (its content is literal), then links, **bold**, *italic* / _italic_.
 *  No lookbehind assertions: macOS 13's WebKit rejects them and the whole bundle would fail to load. The character before
 *  an italic marker is captured instead (groups 6/8) and kept as text. */
export function inline(s: string): Inline[] {
  const out: Inline[] = [];
  const re =
    /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(.+?)\*\*|__(.+?)__|(^|[^\w*])\*([^\s*](?:[^*]*?[^\s*])?)\*(?![\w*])|(^|[^\w])_([^\s_](?:[^_]*?[^\s_])?)_(?!\w)/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    const lead = m[6] ?? m[8] ?? "";
    const start = m.index + lead.length;
    if (start > last) out.push({ t: "text", v: s.slice(last, start) });
    if (m[1] !== undefined) out.push({ t: "code", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "link", href: m[3], c: inline(m[2]) });
    else if (m[4] !== undefined || m[5] !== undefined) out.push({ t: "strong", c: inline(m[4] ?? m[5]) });
    else out.push({ t: "em", c: inline(m[7] ?? m[9]) });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}
