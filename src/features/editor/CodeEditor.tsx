import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { MariaSQL, MySQL, PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Driver } from "../../types";
import { getEditorPrefs, useEditorPrefs, type EditorPrefs } from "../../lib/editorPrefs";

const dialects = { postgres: PostgreSQL, mysql: MySQL, mariadb: MariaSQL, sqlite: SQLite };

// Colors come from CSS variables, so one theme serves dark and light.
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.typeName, tags.bool, tags.null], color: "var(--syn-kw)" },
  { tag: [tags.function(tags.variableName), tags.standard(tags.name)], color: "var(--syn-fn)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syn-str)" },
  { tag: tags.number, color: "var(--syn-num)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--syn-cm)", fontStyle: "italic" },
  { tag: tags.special(tags.name), color: "var(--syn-param)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.68" },
  ".cm-content": { padding: "10px 0", caretColor: "var(--accent)" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--faint)" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "32px", paddingRight: "12px" },
  ".cm-activeLine": { backgroundColor: "var(--accent-line)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--accent-sel) !important",
  },
});

/** Font size, tab size and wrapping from Settings → Editor. */
const lookOf = (p: EditorPrefs) => [
  EditorView.theme({ "&": { fontSize: `${p.fontSize}px` } }),
  EditorState.tabSize.of(p.tabSize),
  ...(p.wordWrap ? [EditorView.lineWrapping] : []),
];

export function CodeEditor({
  value,
  onChange,
  driver = "postgres",
  label,
  onRun,
  onSelect,
  schema,
  viewRef,
  onFormat,
}: {
  value: string;
  onChange?: (v: string) => void;
  driver?: Driver;
  label: string;
  /** Called on ⌘↵ / Ctrl+↵; `script` is true for ⇧⌘↵. */
  onRun?: (script: boolean) => void;
  /** Called with the selected text ("" = nothing selected) and the cursor offset whenever either changes. */
  onSelect?: (text: string, cursor: number) => void;
  /** Table → column names for autocomplete. */
  schema?: Record<string, string[]>;
  /** Receives the editor view (for edits that should be undoable, e.g. Format). */
  viewRef?: { current: EditorView | null };
  /** ⇧⌥F */
  onFormat?: () => void;
}) {
  const prefs = useEditorPrefs();
  const look = useRef(new Compartment());
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const cb = useRef({ onChange, onRun, onSelect, onFormat, schema });
  cb.current = { onChange, onRun, onSelect, onFormat, schema };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          lang.current.of(sql({ dialect: dialects[driver], schema: cb.current.schema })),
          syntaxHighlighting(highlight),
          theme,
          look.current.of(lookOf(getEditorPrefs())),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange?.(u.state.doc.toString());
            if (u.selectionSet) {
              const r = u.state.selection.main;
              cb.current.onSelect?.(u.state.sliceDoc(r.from, r.to), r.head);
            }
          }),
          EditorView.domEventHandlers({
            keydown: (e) => {
              // ⇧⌥F (e.code: ⌥ changes e.key on macOS).
              if (e.shiftKey && e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyF" && cb.current.onFormat) {
                e.preventDefault();
                cb.current.onFormat();
                return true;
              }
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && cb.current.onRun) {
                e.preventDefault();
                cb.current.onRun(e.shiftKey);
                return true;
              }
              return false;
            },
          }),
        ],
      }),
    });
    view.current = v;
    if (viewRef) viewRef.current = v;
    return () => {
      if (viewRef?.current === v) viewRef.current = null;
      v.destroy();
    };
    // The editor owns the document after mount; `value` only seeds it (see the sync effect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driver]);

  // Outside replacements (e.g. picking a history entry); typing round-trips through onChange, so this is a no-op then.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(sql({ dialect: dialects[driver], schema })) });
    // driver changes recreate the editor with the current schema already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);

  useEffect(() => {
    view.current?.dispatch({ effects: look.current.reconfigure(lookOf(prefs)) });
  }, [prefs]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
