import type { SqlLanguage } from "sql-formatter";
import type { KeywordCase } from "../../lib/editorPrefs";
import type { Driver } from "../../types";

const LANGUAGE: Record<Driver, SqlLanguage> = { postgres: "postgresql", mysql: "mysql", mariadb: "mariadb", sqlite: "sqlite", redis: "sql" };

/** Pretty-prints SQL for the driver's dialect. Rejects on text the formatter can't parse (the caller shows it). */
export async function formatSql(sql: string, driver: Driver, opts: { keywordCase: KeywordCase; tabSize: number }): Promise<string> {
  // Loaded on first use: the formatter is large and only needed when the user formats.
  const { format } = await import("sql-formatter");
  return format(sql, {
    language: LANGUAGE[driver],
    keywordCase: opts.keywordCase,
    dataTypeCase: opts.keywordCase,
    functionCase: opts.keywordCase,
    tabWidth: opts.tabSize,
    linesBetweenQueries: 1,
  });
}

/** Formats the editor's selection (or the whole text) in place, as one undoable edit. */
export async function formatInEditor(
  view: { state: { selection: { main: { from: number; to: number } }; doc: { length: number; toString(): string }; sliceDoc(a: number, b: number): string }; dispatch(tr: object): void },
  driver: Driver,
  opts: { keywordCase: KeywordCase; tabSize: number },
) {
  const { from, to } = view.state.selection.main;
  const [a, b] = from === to ? [0, view.state.doc.length] : [from, to];
  const text = view.state.sliceDoc(a, b);
  if (!text.trim()) return;
  const formatted = await formatSql(text, driver, opts);
  if (view.state.sliceDoc(a, b) !== text) return; // edited while the formatter loaded
  view.dispatch({ changes: { from: a, to: b, insert: formatted }, selection: { anchor: a, head: a + formatted.length } });
}
