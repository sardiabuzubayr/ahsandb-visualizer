import { Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Field, Input } from "../../components/ui";
import { useConnectionError } from "../../components/shell/connectionError";
import { previewErrorText } from "../../components/shell/PreviewList";
import { errorText, useConnect } from "../../components/shell/useConnect";
import { CodeEditor } from "../editor/CodeEditor";
import { ResultsPanel, type ResultView, type RunError } from "../editor/ResultsPanel";
import { toResultSets, type RunResult } from "../editor/results";
import { ReviewDialog, type ReviewState } from "../routine/ReviewDialog";
import { useT } from "../../i18n";
import { api, isApiError } from "../../lib/api";
import { scopedId } from "../../lib/scope";
import { useApp, useConnection, useTabDirty, useToast } from "../../state/app";
import type { AppErrorKind, Tab, ViewDef } from "../../types";
import { emptyView, isDirty, normalizeQuery, normalizeView, parseTarget, validate } from "./view";

const PREVIEW_ROWS = 100;

export function ViewDesignerTab({ tab }: { tab: Tab }) {
  const t = useT();
  const toast = useToast();
  const conn = useConnection(tab.connectionId);
  const sid = scopedId(conn.id, tab.database);
  const { dispatch } = useApp();
  const markLost = useConnectionError();
  const { loadTree } = useConnect();
  const { schema, name, isNew } = parseTarget(tab.target ?? tab.title);
  /** The view as it is in the database; an empty one for a new view. */
  const [original, setOriginal] = useState<ViewDef | null>(() => (isNew ? emptyView(schema) : null));
  const [v, setV] = useState<ViewDef | null>(original);
  const [loadError, setLoadError] = useState<{ kind?: AppErrorKind; message: string } | null>(null);
  const [reload, setReload] = useState(0);
  const [editorKey, setEditorKey] = useState(0);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [results, setResults] = useState<RunResult[] | null>(null);
  const [runError, setRunError] = useState<RunError | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [resultView, setResultView] = useState<ResultView>("grid");
  const [completion, setCompletion] = useState<Record<string, string[]>>();
  const dirty = !!original && !!v && isDirty(original, v);
  useTabDirty(tab.id, dirty);

  // (Re)load on open, Retry and after a save. Not on reconnect: that would wipe unsaved edits.
  useEffect(() => {
    if (isNew) return;
    let live = true;
    api.loadView(sid, schema, name).then(
      (x) => {
        if (!live) return;
        setOriginal(x);
        setV(x);
        setLoadError(null);
        setEditorKey((k) => k + 1); // CodeEditor only reads `value` on mount
      },
      (e) => {
        if (!live) return;
        markLost(conn.id, e);
        setLoadError({ kind: isApiError(e) ? e.kind : undefined, message: errorText(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [isNew, sid, schema, name, reload, markLost]);

  // Autocomplete metadata, as in the SQL editor.
  useEffect(() => {
    if (!conn.connected) return;
    let live = true;
    api.completionSchema(sid).then((s) => live && setCompletion(s), () => {});
    return () => {
      live = false;
    };
  }, [sid, conn.connected]);

  if (!v || !original || loadError) {
    const notFound = loadError?.kind === "notFound" && loadError.message !== "Not connected";
    const notSupported = loadError?.kind === "notSupported";
    return (
      <div className="grid flex-1 place-items-center p-6 text-center">
        {loadError ? (
          <div role="alert" className="max-w-md">
            <p className="m-0 font-medium">
              {notSupported ? t("view.notSupported") : notFound ? t("view.notFound", { name, schema }) : loadError.message}
            </p>
            {(notFound || notSupported) && <p className="mt-1 mb-0 text-xs text-muted">{loadError.message}</p>}
            {!notSupported && (
              <Button className="mt-3" onClick={() => (setLoadError(null), setReload((n) => n + 1))}>
                {t("view.retry")}
              </Button>
            )}
          </div>
        ) : (
          <p className="m-0 text-muted">{t("view.loading")}</p>
        )}
      </div>
    );
  }

  const running = runId !== null;
  const problem = validate(v);
  const canSave = dirty && !conn.readOnly && !problem;
  const canRun = !running && normalizeQuery(v.query) !== "";
  const set = (patch: Partial<ViewDef>) => setV((x) => x && { ...x, ...patch });
  const discard = () => {
    setV(original);
    setEditorKey((k) => k + 1);
  };

  const run = async () => {
    if (!canRun) return;
    const id = crypto.randomUUID();
    setRunId(id);
    setRunError(null);
    try {
      // Only the first result set: a view is one SELECT.
      setResults(toResultSets(await api.execute(sid, normalizeQuery(v.query), id, false, PREVIEW_ROWS), id).slice(0, 1));
    } catch (e) {
      setResults(null);
      markLost(conn.id, e);
      // Never confirmed: a preview must not write, so a write statement just shows as an error.
      if (isApiError(e, "needsConfirmation")) setRunError({ message: t("view.notRead"), statements: e.detail });
      else if (isApiError(e, "readOnly")) setRunError({ message: t("results.readOnly"), hint: e.message, statements: e.detail });
      else if (isApiError(e, "notFound")) setRunError({ message: e.message, hint: t("results.notConnected") });
      else setRunError({ message: errorText(e) });
    } finally {
      setRunId(null);
    }
  };
  const cancel = () => {
    if (runId) api.cancel(runId).catch((e) => toast(errorText(e)));
  };

  const save = async () => {
    if (!canSave) return;
    setReview({ busy: true });
    try {
      setReview({ preview: await api.previewView(sid, isNew ? null : original, normalizeView(v)) });
    } catch (e) {
      markLost(conn.id, e);
      setReview({ error: previewErrorText(t, e) });
    }
  };
  const apply = async () => {
    const preview = review?.preview;
    if (!preview) return;
    setReview({ preview, busy: true });
    const target = normalizeView(v);
    try {
      const report = await api.applyPreview(sid, preview.id, true);
      if (report.failed) {
        setReview({ preview, report });
        if (report.executed > 0) void loadTree(conn.id);
        return;
      }
      setReview(null);
      toast(t("view.saved", { name: target.name }));
      void loadTree(conn.id);
      if (isNew || target.name !== name) {
        // The tab's target names the old (or no) view: reopen the designer on the view as it now exists.
        dispatch({ type: "closeTab", id: tab.id, force: true });
        dispatch({ type: "openTab", kind: "view", connectionId: conn.id, title: target.name, target: `${schema}.${target.name}`, database: tab.database });
      } else setReload((n) => n + 1);
    } catch (e) {
      markLost(conn.id, e);
      setReview({ preview, error: previewErrorText(t, e) });
    }
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          void save();
        }
      }}
    >
      <div className="flex shrink-0 flex-col gap-[18px] px-6 py-5">
        <div className="flex flex-wrap items-end gap-4">
          <Field label={t("view.name")} className="flex-[1_1_240px]">
            <Input mono value={v.name} placeholder="new_view" onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label={t("view.schema")} className="flex-[0_1_180px]">
            <Input mono value={schema} readOnly className="text-muted" />
          </Field>
        </div>

        <section aria-label={t("view.query")} className="flex flex-col">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="m-0 text-[13px] font-semibold">{t("view.query")}</h2>
            <span className="flex-1 text-xs text-faint">{t("view.previewHint")}</span>
            <Button variant="outline" onClick={cancel} disabled={!running} className="gap-[7px] disabled:text-faint">
              <Square size={11} fill="currentColor" aria-hidden="true" />
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void run()} disabled={!canRun} className="gap-[7px]">
              <Play size={12} fill="currentColor" aria-hidden="true" />
              {t("view.runPreview")}
              <span className="font-mono text-[11px] opacity-75">⌘↵</span>
            </Button>
          </div>
          <div className="h-[220px] overflow-hidden rounded-lg border border-border bg-panel">
            <CodeEditor
              key={editorKey}
              value={v.query}
              onChange={(query) => set({ query })}
              onRun={() => void run()}
              driver={conn.driver}
              schema={completion}
              label={t("view.queryEditor")}
            />
          </div>
        </section>
      </div>

      <ResultsPanel key={results?.[0]?.id ?? "none"} results={results} error={runError} running={running} view={resultView} onView={setResultView} />

      <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2.5 border-t border-border bg-panel px-6 py-2.5">
        <span className="min-w-[240px] flex-1 text-xs text-muted">{conn.readOnly ? t("view.readOnly") : problem && (dirty || isNew) ? t(problem) : null}</span>
        <Button variant="ghost" size="lg" onClick={discard} disabled={!dirty}>
          {t("common.discard")}
        </Button>
        <Button variant="primary" size="lg" className="font-semibold" onClick={() => void save()} disabled={!canSave}>
          {t("view.save")}
          <span className="ml-0.5 font-mono text-[11px] opacity-75">⌘S</span>
        </Button>
      </div>

      <ReviewDialog
        id={`${tab.id}-review`}
        title={t("view.reviewTitle", { name: v.name.trim() })}
        state={review}
        prod={conn.env === "prod"}
        onApply={() => void apply()}
        onClose={() => setReview(null)}
      />
    </div>
  );
}
