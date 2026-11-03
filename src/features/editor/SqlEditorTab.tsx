import { useEffect, useRef, useState } from "react";
import { AlignLeft, FolderOpen, History, Lock, Play, Save, Square, TriangleAlert } from "lucide-react";
import { useT } from "../../i18n";
import { api, isApiError } from "../../lib/api";
import { useApp, useConnection, useTabDirty, useToast } from "../../state/app";
import type { HistoryEntry, Tab } from "../../types";
import { Button, Dialog, Kbd, Menu, cn } from "../../components/ui";
import { Select } from "../../components/ui/Select";
import { scopedId } from "../../lib/scope";
import { useConnectionError } from "../../components/shell/connectionError";
import { CodeEditor } from "./CodeEditor";
import { dropQueuedSql, peekQueuedSql } from "./pendingSql";
import { ResultsPanel, type ResultView, type RunError } from "./ResultsPanel";
import { toResultSets, type RunResult } from "./results";
import { statementAt } from "./statementAt";
import { formatInEditor } from "./formatSql";
import { getEditorPrefs } from "../../lib/editorPrefs";
import type { EditorView } from "codemirror";
import { loadSql, saveSql } from "../../lib/session";
import { fileName, pickSqlToSave } from "../../lib/sqlFile";
import { useOpenSqlFile } from "./useOpenSqlFile";
import { databaseNames, firstDatabase } from "./treeScope";


const firstLine = (sql: string) => sql.trim().split("\n")[0];
function when(iso: string): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${hm}`;
}

export function SqlEditorTab({ tab }: { tab: Tab }) {
  const t = useT();
  const toast = useToast();
  const conn = useConnection(tab.connectionId);
  const [sql, setSql] = useState(() => peekQueuedSql(tab.connectionId) ?? loadSql(tab.id) ?? "");
  // File-backed tabs: the text last read from / written to the file (null = not known yet / unreadable).
  const [savedText, setSavedText] = useState<string | null>(null);
  useEffect(() => {
    if (!tab.filePath) return;
    let live = true;
    const unsaved = loadSql(tab.id); // edits from before an app restart win over the file
    api.readTextFile(tab.filePath).then(
      (text) => {
        if (!live) return;
        setSavedText(text);
        if (unsaved === null) setSql(text);
      },
      (e: unknown) => live && toast(isApiError(e) ? e.message : String(e)),
    );
    return () => void (live = false);
    // Read once per file; Save updates savedText itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.filePath]);
  const fileDirty = !!tab.filePath && savedText !== null && sql !== savedText;
  useTabDirty(tab.id, fileDirty);
  // Kept across app restarts (lib/session); written shortly after typing stops.
  useEffect(() => {
    const id = setTimeout(() => saveSql(tab.id, sql), 400);
    return () => clearTimeout(id);
  }, [tab.id, sql]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => dropQueuedSql(tab.connectionId), []);
  const markLost = useConnectionError();
  const [selection, setSelection] = useState("");
  const cursor = useRef(0);
  const [results, setResults] = useState<RunResult[] | null>(null);
  const [runError, setRunError] = useState<RunError | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ sql: string; statements: string[] } | null>(null);
  const [view, setView] = useState<ResultView>("grid");
  const [showEditor, setShowEditor] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [schema, setSchema] = useState<Record<string, string[]>>();
  const running = runId !== null;
  const database = tab.database;
  const sid = scopedId(conn.id, database);
  const { state: app, dispatch } = useApp();
  const tree = app.trees[conn.id];
  const pickable = conn.driver === "postgres" || conn.driver === "mysql" || conn.driver === "mariadb";
  const databases = pickable && tree?.status === "ready" ? databaseNames(tree.nodes) : [];
  // MySQL/MariaDB may have no default database: the picker then starts empty.
  const current = database ?? firstDatabase(conn.database) ?? (conn.driver === "postgres" ? "postgres" : "");

  const loadHistory = () => void api.history(conn.id, 20).then(setHistory, () => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadHistory, [conn.id]);

  // Autocomplete metadata: once per tab while connected, again after a reconnect.
  useEffect(() => {
    if (!conn.connected) return;
    let live = true;
    api.completionSchema(sid).then((s) => live && setSchema(s), () => {});
    return () => {
      live = false;
    };
  }, [sid, conn.connected]);

  const canRun = !running && sql.trim() !== "";
  const exec = async (text: string, confirmed: boolean) => {
    const id = crypto.randomUUID();
    setRunId(id);
    setRunError(null);
    try {
      setResults(toResultSets(await api.execute(sid, text, id, confirmed, getEditorPrefs().pageSize), id));
    } catch (e) {
      setResults(null);
      markLost(conn.id, e);
      if (isApiError(e, "needsConfirmation")) setConfirm({ sql: text, statements: e.detail ?? [] });
      else if (isApiError(e, "readOnly")) setRunError({ message: t("results.readOnly"), hint: e.message, statements: e.detail });
      else if (isApiError(e, "notFound")) setRunError({ message: e.message, hint: t("results.notConnected") });
      else setRunError({ message: isApiError(e) ? e.message : String(e) });
    } finally {
      setRunId(null);
      loadHistory();
    }
  };
  // Run: the selection, else the statement at the cursor (whole text for DELIMITER scripts). Run script: everything.
  const run = (script = false) => {
    if (!canRun) return;
    const text = script ? sql : selection.trim() ? selection : (statementAt(sql, cursor.current, conn.driver) ?? sql);
    void exec(text, false);
  };
  // "Load more": the same read statement again with room for one more page; replaces that result in place.
  const loadMore = async (r: RunResult) => {
    if (!r.sql) return;
    const runId = `more-${Date.now().toString(36)}`;
    try {
      const next = await api.fetchMore(sid, r.sql, runId, r.rows.length + getEditorPrefs().pageSize);
      setResults((rs) => rs && rs.map((x) => (x.id === r.id ? { ...toResultSets([next], runId)[0], id: x.id, label: x.label } : x)));
    } catch (e) {
      markLost(conn.id, e);
      toast(isApiError(e) ? e.message : String(e));
    }
  };
  const cancel = () => {
    if (runId) api.cancel(runId).catch((e) => toast(isApiError(e) ? e.message : String(e)));
  };
  const editorView = useRef<EditorView | null>(null);
  const format = async () => {
    if (!editorView.current) return;
    try {
      await formatInEditor(editorView.current, conn.driver, getEditorPrefs());
    } catch (e) {
      toast(t("editor.formatFailed", { message: e instanceof Error ? e.message.split("\n")[0] : String(e) }));
    }
  };
  const openFile = useOpenSqlFile();
  const writeTo = async (path: string) => {
    try {
      await api.writeTextFile(path, sql);
      setSavedText(sql);
      if (path !== tab.filePath) dispatch({ type: "setTabFile", id: tab.id, filePath: path, title: fileName(path) });
      toast(t("editor.file.saved", { name: fileName(path) }));
    } catch (e) {
      toast(isApiError(e) ? e.message : String(e));
    }
  };
  const saveAs = async () => {
    const path = await pickSqlToSave(tab.filePath ? fileName(tab.filePath) : /\.sql$/i.test(tab.title) ? tab.title : `${tab.title}.sql`).catch(() => null);
    if (path) await writeTo(path);
  };
  const save = () => (tab.filePath ? writeTo(tab.filePath) : saveAs());
  // ⌘S / ⇧⌘S while this tab is the visible one (tabs stay mounted when hidden).
  const active = app.activeTabId === tab.id;
  const keys = useRef({ save, saveAs });
  keys.current = { save, saveAs };
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "s" || document.querySelector("dialog[open]")) return;
      e.preventDefault();
      void (e.shiftKey ? keys.current.saveAs() : keys.current.save());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
  const compact = view === "chart" && !showEditor;
  const runButton = (
    <Button
      variant="primary"
      onClick={() => run()}
      disabled={!canRun}
      title={t(selection.trim() ? "editor.runSelectionHint" : "editor.runHint")}
      className="gap-[7px]"
    >
      <Play size={12} fill="currentColor" aria-hidden="true" />
      {t(selection.trim() ? "editor.runSelection" : "editor.run")}
      {!compact && <span className="font-mono text-[11px] opacity-75">⌘↵</span>}
    </Button>
  );

  return (
    <>
      {compact ? (
        <div className="flex min-h-11 shrink-0 items-center gap-2.5 border-b border-border px-3 py-2">
          {runButton}
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={sql}>
            {sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim()}
          </code>
          <Button variant="ghost" onClick={() => setShowEditor(true)}>
            {t("editor.showEditor")}
          </Button>
        </div>
      ) : (
        <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          {runButton}
          <Button onClick={() => run(true)} disabled={!canRun} className="gap-[7px]">
            {t("editor.runScript")}
            <Kbd>⇧⌘↵</Kbd>
          </Button>
          <Button variant="outline" onClick={cancel} disabled={!running} className="gap-[7px] disabled:text-faint">
            <Square size={11} fill="currentColor" aria-hidden="true" />
            {t("editor.cancel")}
          </Button>
          <span aria-hidden="true" className="h-5 w-px bg-border" />
          <Button variant="ghost" onClick={() => void openFile(tab.database)} title={t("editor.file.openHint")} className="px-2">
            <FolderOpen size={14} aria-hidden="true" />
            {t("editor.file.open")}
          </Button>
          <Button variant="ghost" onClick={() => void save()} title={t("editor.file.saveHint")} className="px-2">
            <Save size={14} aria-hidden="true" />
            {t("editor.file.save")}
          </Button>
          <Button variant="ghost" onClick={() => void saveAs()} title={t("editor.file.saveAsHint")} className="px-2">
            {t("editor.file.saveAs")}
          </Button>
          <span aria-hidden="true" className="h-5 w-px bg-border" />
          <Button variant="ghost" onClick={format} title={t("editor.formatHint")} className="px-2">
            <AlignLeft size={14} aria-hidden="true" />
            {t("editor.format")}
          </Button>
          <Menu
            trigger={(p) => (
              <Button variant="ghost" className="px-2" {...p}>
                <History size={14} aria-hidden="true" />
                {t("editor.history")}
              </Button>
            )}
            items={
              history.length === 0
                ? [{ key: "empty", label: <span className="text-muted">{t("editor.history.empty")}</span>, onSelect: () => {}, disabled: true }]
                : history.map((h, i) => ({
                    key: String(i),
                    onSelect: () => setSql(h.sql),
                    label: (
                      <span className="flex w-[360px] min-w-0 items-center gap-2" title={h.sql}>
                        <span
                          role={h.ok ? undefined : "img"}
                          aria-label={h.ok ? undefined : t("editor.history.failed")}
                          className={cn("size-1.5 shrink-0 rounded-full", h.ok ? "bg-transparent" : "bg-prod")}
                        />
                        <span className={cn("min-w-0 flex-1 truncate font-mono text-xs", !h.ok && "text-muted")}>{firstLine(h.sql)}</span>
                        <span className="shrink-0 text-[11px] text-faint">{when(h.ranAt)}</span>
                      </span>
                    ),
                  }))
            }
          />
          <span className="flex-1" />
          {databases.length > 1 || (databases.length > 0 && !current) ? (
            <Select
              compact
              mono
              aria-label={t("editor.databasePick")}
              title={t("editor.databasePick")}
              value={current}
              onChange={(e) => dispatch({ type: "setTabDatabase", id: tab.id, database: e.target.value })}
              className="w-44"
            >
              {!current && <option value="">{t("editor.noDatabase")}</option>}
              {databases.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </Select>
          ) : (
            <span title={t("editor.database")} className="inline-flex h-7 items-center rounded-md border border-border px-2.5 font-mono text-xs text-muted">
              {database ?? firstDatabase(conn.database) ?? conn.file}
            </span>
          )}
          {conn.env === "prod" && (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-md bg-prod-bg px-2.5 text-xs font-medium text-prod">
              <Lock size={12} aria-hidden="true" />
              {t("editor.prodBadge")}
            </span>
          )}
        </div>
      )}
      <div className={compact ? "hidden" : "h-[304px] shrink-0"}>
        <CodeEditor
          value={sql}
          onChange={setSql}
          onSelect={(text, at) => {
            setSelection(text);
            cursor.current = at;
          }}
          driver={conn.driver}
          label={t("editor.label")}
          onRun={run}
          schema={schema}
          viewRef={editorView}
          onFormat={format}
        />
      </div>
      <ResultsPanel
        key={results?.[0]?.id ?? "none"}
        results={results}
        error={runError}
        running={running}
        view={view}
        onLoadMore={loadMore}
        onView={(v) => {
          setView(v);
          setShowEditor(false);
        }}
      />
      <Dialog open={!!confirm} onClose={() => setConfirm(null)} labelledBy={`${tab.id}-confirm`} className="top-[20%] max-w-[560px] border-prod!">
        <div className="flex items-center gap-2 bg-prod-bg px-5 py-3.5 text-prod">
          <TriangleAlert size={16} aria-hidden="true" />
          <h1 id={`${tab.id}-confirm`} className="m-0 text-[15px] font-semibold">
            {t("editor.confirm.title")}
          </h1>
        </div>
        <div className="px-5 pt-4 pb-1">
          <p className="m-0 text-muted">{t("editor.confirm.body", { name: conn.name })}</p>
          <pre className="mt-3 mb-0 max-h-64 overflow-auto rounded-lg border border-border bg-bg px-3 py-2.5 font-mono text-[11.5px] leading-[19px] whitespace-pre-wrap">
            {confirm?.statements.join("\n\n")}
          </pre>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3.5">
          <Button variant="outline" size="lg" onClick={() => setConfirm(null)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            size="lg"
            onClick={() => {
              const text = confirm!.sql;
              setConfirm(null);
              void exec(text, true);
            }}
          >
            {t("editor.confirm.run", { n: confirm?.statements.length ?? 0 })}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
