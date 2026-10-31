// SQL editor preferences (Settings → Editor), per user in localStorage; editors update live.
import { useSyncExternalStore } from "react";

export type KeywordCase = "upper" | "lower" | "preserve";

export interface EditorPrefs {
  fontSize: number;
  tabSize: 2 | 4;
  wordWrap: boolean;
  /** Keyword case used by Format SQL. */
  keywordCase: KeywordCase;
  /** Rows a query result shows first ("Load more" fetches the next batch). */
  pageSize: number;
}

export const FONT_SIZES = [11, 12, 12.5, 13, 14, 15, 16, 18];
export const PAGE_SIZES = [100, 200, 500, 1000];
const DEFAULTS: EditorPrefs = { fontSize: 12.5, tabSize: 2, wordWrap: false, keywordCase: "upper", pageSize: 200 };
const KEY = "editor.prefs";

function load(): EditorPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<EditorPrefs>;
    return {
      fontSize: FONT_SIZES.includes(v.fontSize as number) ? (v.fontSize as number) : DEFAULTS.fontSize,
      tabSize: v.tabSize === 4 ? 4 : 2,
      wordWrap: v.wordWrap === true,
      keywordCase: v.keywordCase === "lower" || v.keywordCase === "preserve" ? v.keywordCase : "upper",
      pageSize: PAGE_SIZES.includes(v.pageSize as number) ? (v.pageSize as number) : DEFAULTS.pageSize,
    };
  } catch {
    return DEFAULTS;
  }
}

let prefs = load();
const subs = new Set<() => void>();

export const getEditorPrefs = () => prefs;

export function setEditorPrefs(patch: Partial<EditorPrefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // shortcut: without storage the change lasts until the app closes.
  }
  subs.forEach((f) => f());
}

export const useEditorPrefs = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => prefs,
  );
