import { ChevronDown, Play, Plus, TextAlignStart, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Dialog, Field, IconButton, Input, Segmented, Switch, cn } from "../../components/ui";
import { Select } from "../../components/ui/Select";
import { isConnectionError, useConnectionError } from "../../components/shell/connectionError";
import { previewErrorText } from "../../components/shell/PreviewList";
import { errorText, useConnect } from "../../components/shell/useConnect";
import { CodeEditor } from "../editor/CodeEditor";
import { formatInEditor } from "../editor/formatSql";
import { getEditorPrefs } from "../../lib/editorPrefs";
import type { EditorView } from "codemirror";
import { formatCell } from "../editor/format";
import { useT } from "../../i18n";
import { api, isApiError } from "../../lib/api";
import { scopedId } from "../../lib/scope";
import { databaseNodes, firstDatabase } from "../editor/treeScope";
import { useApp, useConnection, useTabDirty, useToast } from "../../state/app";
import type { AppErrorKind, ParamMode, Routine, RoutineParam, StatementResult, Tab } from "../../types";
import { ReviewDialog, type ReviewState } from "./ReviewDialog";
import { isBool, isDirty, modeOf, normalize, routineTarget, runArgs, type ArgInput } from "./routine";

const MODES: ParamMode[] = ["IN", "OUT", "INOUT"];
const PG_LANGUAGES = ["sql", "plpgsql"];

const SELECT = "w-full appearance-none rounded-md border bg-surface outline-none focus:border-accent disabled:opacity-100";
const CELL_INPUT = "h-7 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 font-mono text-[12.5px] outline-none hover:border-border focus:border-accent";

export function RoutineEditorTab({ tab }: { tab: Tab }) {
  const t = useT();
  const toast = useToast();
  const conn = useConnection(tab.connectionId);
  const sid = scopedId(conn.id, tab.database);
  const { state } = useApp();
  const markLost = useConnectionError();
  const { loadTree } = useConnect();
  const [key, setKey] = useState(() => {
    const tree = state.trees[conn.id];
    return routineTarget(tab.target ?? tab.title, conn.driver, firstDatabase(conn.database), tree?.status === "ready" ? databaseNodes(tree.nodes, tab.database) : undefined);
  });
  const [original, setOriginal] = useState<Routine | null>(null);
  const [r, setR] = useState<Routine | null>(null);
  const [loadError, setLoadError] = useState<{ kind?: AppErrorKind; message: string } | null>(null);
  const [bodyKey, setBodyKey] = useState(0);
  const bodyView = useRef<EditorView | null>(null);
  // Procedural bodies (plpgsql, BEGIN … END) are formatted as statements; the formatter refuses what it can't parse.
  const formatBody = async () => {
    if (!bodyView.current) return;
    try {
      await formatInEditor(bodyView.current, conn.driver, getEditorPrefs());
    } catch (e) {
      toast(t("routine.formatFailed", { message: e instanceof Error ? e.message.split("\n")[0] : String(e) }));
    }
  };
  const [review, setReview] = useState<ReviewState | null>(null);
  const [args, setArgs] = useState<Record<string, ArgInput>>({});
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<StatementResult[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const dirty = !!original && !!r && isDirty(original, r);
  useTabDirty(tab.id, dirty);

  // (Re)load on open, Retry and after a save. Not on reconnect: that would wipe unsaved edits.
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const [i, kind] of key.kinds.entries()) {
        try {
          const x = await api.loadRoutine(sid, key.schema, key.name, kind);
          if (!live) return;
          setOriginal(x);
          setR(x);
          setLoadError(null);
          setBodyKey((k) => k + 1); // CodeEditor only reads `value` on mount
          return;
        } catch (e) {
          if (!live) return;
          if (isApiError(e, "notFound") && !isConnectionError(e) && i < key.kinds.length - 1) continue;
          markLost(conn.id, e);
          setLoadError({ kind: isApiError(e) ? e.kind : undefined, message: errorText(e) });
          return;
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [key, sid, markLost]);

  if (!r || !original || loadError) {
    const notFound = loadError?.kind === "notFound" && loadError.message !== "Not connected";
    return (
      <div className="grid flex-1 place-items-center p-6 text-center">
        {loadError ? (
          <div role="alert" className="max-w-md">
            <p className="m-0 font-medium">
              {loadError.kind === "notSupported"
                ? t("routine.notSupported")
                : notFound
                  ? t("routine.notFound", { name: key.name, schema: key.schema })
                  : loadError.message}
            </p>
            {(notFound || loadError.kind === "notSupported") && <p className="mt-1 mb-0 text-xs text-muted">{loadError.message}</p>}
            {loadError.kind !== "notSupported" && (
              <Button className="mt-3" onClick={() => (setLoadError(null), setKey({ ...key }))}>
                {t("routine.retry")}
              </Button>
            )}
          </div>
        ) : (
          <p className="m-0 text-muted">{t("routine.loading")}</p>
        )}
      </div>
    );
  }

  const fn = r.kind === "function";
  const set = (patch: Partial<Routine>) => setR((x) => x && { ...x, ...patch });
  const setParam = (i: number, patch: Partial<RoutineParam>) =>
    set({ params: r.params.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const setArg = (name: string, patch: Partial<ArgInput>) =>
    setArgs((a) => ({ ...a, [name]: { ...(a[name] ?? { value: "", isNull: false }), ...patch } }));
  const discard = () => {
    setR(original);
    setBodyKey((k) => k + 1);
  };

  const canSave = dirty && !conn.readOnly && r.name.trim() !== "";
  const save = async () => {
    if (!canSave) return;
    setReview({ busy: true });
    try {
      setReview({ preview: await api.previewRoutine(sid, original, normalize(r)) });
    } catch (e) {
      markLost(conn.id, e);
      setReview({ error: previewErrorText(t, e) });
    }
  };
  const apply = async () => {
    const preview = review?.preview;
    if (!preview) return;
    setReview({ preview, busy: true });
    try {
      const report = await api.applyPreview(sid, preview.id, true);
      if (report.failed) {
        setReview({ preview, report });
        if (report.executed > 0) void loadTree(conn.id);
        return;
      }
      setReview(null);
      toast(t("routine.saved", { name: r.name }));
      void loadTree(conn.id);
      setKey({ schema: key.schema, name: r.name, kinds: [r.kind] });
    } catch (e) {
      markLost(conn.id, e);
      setReview({ preview, error: previewErrorText(t, e) });
    }
  };

  // Runs the saved routine (`original`), never the unsaved form.
  const run = async (confirmed: boolean) => {
    setRunning(true);
    setRunError(null);
    setResults(null);
    try {
      setResults(await api.runRoutine(sid, original, runArgs(original, args), crypto.randomUUID(), confirmed));
    } catch (e) {
      markLost(conn.id, e);
      if (isApiError(e, "needsConfirmation")) setConfirm(e.detail ?? []);
      else setRunError(errorText(e));
    } finally {
      setRunning(false);
    }
  };

  const savedFn = original.kind === "function";
  const inputs = original.params.filter((p) => modeOf(original, p) !== "OUT");
  const outs = original.params.filter((p) => modeOf(original, p) === "OUT");
  const failed = !!runError || !!results?.some((s) => s.error);

  return (
    <div
      className="flex min-h-0 flex-1"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          void save();
        }
      }}
    >
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto px-6 py-5">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <div className="mb-1.5 text-xs text-muted">{t("routine.kind")}</div>
              <Segmented
                label={t("routine.kindLabel")}
                value={r.kind}
                onChange={(kind) => set({ kind })}
                options={[
                  { value: "function", label: t("routine.function") },
                  { value: "procedure", label: t("routine.procedure") },
                ]}
              />
            </div>
            <Field label={t("routine.name")} className="flex-[1_1_240px]">
              <Input mono value={r.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label={t("routine.database")} className="flex-[0_1_180px]">
              <Input mono value={r.database} readOnly className="text-muted" />
            </Field>
            {fn && (
              <Field label={t("routine.returns")} className="flex-[0_1_160px]">
                <Input mono value={r.returns ?? ""} onChange={(e) => set({ returns: e.target.value })} />
              </Field>
            )}
            {conn.driver === "postgres" && (
              <Field label={t("routine.language")} className="flex-[0_1_130px]">
                <Select mono value={r.language ?? "plpgsql"} onChange={(e) => set({ language: e.target.value })}>
                  {[...new Set([...PG_LANGUAGES, r.language ?? "plpgsql"])].map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </Select>
              </Field>
            )}
            <div>
              <div className="mb-1.5 text-xs text-muted">{t("routine.security")}</div>
              <Segmented
                label={t("routine.security")}
                value={r.security}
                onChange={(security) => set({ security })}
                options={[
                  { value: "definer", label: t("routine.definer") },
                  { value: "invoker", label: t("routine.invoker") },
                ]}
              />
            </div>
          </div>

          <section aria-label={t("routine.params")}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="m-0 text-[13px] font-semibold">{t("routine.params")}</h2>
              <span className="text-xs text-faint">{t(fn ? "routine.paramsHintFunction" : "routine.paramsHintProcedure")}</span>
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="grid h-[30px] grid-cols-[110px_minmax(160px,1fr)_minmax(160px,1fr)_44px] items-center border-b border-border bg-panel text-xs text-muted">
                <span className="px-3">{t("routine.mode")}</span>
                <span className="px-3">{t("routine.paramName")}</span>
                <span className="px-3">{t("routine.paramType")}</span>
              </div>
              {r.params.map((p, i) => (
                <div key={i} className="grid h-[38px] grid-cols-[110px_minmax(160px,1fr)_minmax(160px,1fr)_44px] items-center border-b border-border">
                  <span className="relative px-2">
                    <select
                      value={modeOf(r, p)}
                      disabled={fn}
                      aria-label={t("routine.modeOf", { name: p.name })}
                      onChange={(e) => setParam(i, { mode: e.target.value as ParamMode })}
                      className={cn(SELECT, "h-7 border-border px-2 font-mono text-xs", modeOf(r, p) === "IN" ? "text-text" : "text-syn-param")}
                    >
                      {(fn ? MODES.slice(0, 1) : MODES).map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                    {!fn && <ChevronDown size={10} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-faint" />}
                  </span>
                  <span className="px-1.5">
                    <input value={p.name} aria-label={t("routine.nameOf", { n: i + 1 })} onChange={(e) => setParam(i, { name: e.target.value })} className={CELL_INPUT} />
                  </span>
                  <span className="px-1.5">
                    <input value={p.type} aria-label={t("routine.typeOf", { n: i + 1 })} onChange={(e) => setParam(i, { type: e.target.value })} className={cn(CELL_INPUT, "text-muted")} />
                  </span>
                  <IconButton label={t("routine.removeParam")} size={28} onClick={() => set({ params: r.params.filter((_, j) => j !== i) })} className="text-faint">
                    <X size={12} />
                  </IconButton>
                </div>
              ))}
              <button
                type="button"
                onClick={() => set({ params: [...r.params, { mode: "IN", name: `p_param${r.params.length + 1}`, type: "INT" }] })}
                className="flex h-[34px] w-full items-center gap-1.5 px-3 text-left text-muted hover:text-text"
              >
                <Plus size={12} aria-hidden="true" />
                {t("routine.addParam")}
              </button>
            </div>
          </section>

          <section aria-label={t("routine.body")} className="flex min-h-[300px] flex-1 flex-col">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="m-0 text-[13px] font-semibold">{t("routine.body")}</h2>
              <Button variant="ghost" size="sm" onClick={formatBody} title={t("routine.formatHint")}>
                <TextAlignStart size={13} aria-hidden="true" />
                {t("routine.format")}
              </Button>
            </div>
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-panel">
              <div className="absolute inset-0">
                <CodeEditor
                  key={bodyKey}
                  value={r.body}
                  onChange={(body) => set({ body })}
                  driver={conn.driver}
                  label={t("routine.bodyEditor")}
                  viewRef={bodyView}
                  onFormat={formatBody}
                />
              </div>
            </div>
          </section>
        </div>

        <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2.5 border-t border-border bg-panel px-6 py-2.5">
          <span className="min-w-[240px] flex-1 text-xs text-muted">
            {conn.readOnly ? (
              t("routine.readOnly")
            ) : conn.driver === "mariadb" ? (
              <>
                {t("routine.notePre", { db: "MariaDB" })} <span className="font-mono text-text">CREATE OR REPLACE</span>
                {t("routine.notePost", { kind: t(fn ? "routine.function" : "routine.procedure").toLowerCase() })}
              </>
            ) : null}
          </span>
          <Button variant="ghost" size="lg" onClick={discard} disabled={!dirty}>
            {t("common.discard")}
          </Button>
          <Button variant="primary" size="lg" className="font-semibold" onClick={() => void save()} disabled={!canSave}>
            {t(fn ? "routine.saveFunction" : "routine.saveProcedure")}
            <span className="ml-0.5 font-mono text-[11px] opacity-75">⌘S</span>
          </Button>
        </div>
      </main>

      <aside aria-label={t(savedFn ? "routine.runFunction" : "routine.runProcedure")} className="flex w-[340px] shrink-0 flex-col gap-3.5 overflow-auto border-l border-border bg-panel p-4">
        <div>
          <h2 className="m-0 text-sm font-semibold">{t(savedFn ? "routine.runFunction" : "routine.runProcedure")}</h2>
          <p className="mt-1 mb-0 text-xs text-muted">{t("routine.runHint")}</p>
        </div>
        {inputs.map((p, i) => {
          const a = args[p.name] ?? { value: "", isNull: false };
          return isBool(p.type) ? (
            <div key={i} className="flex items-center justify-between">
              <span className="flex flex-col">
                <span className="font-mono text-[12.5px]">{p.name}</span>
                <span className="font-mono text-[11px] text-muted">{p.type}</span>
              </span>
              <Switch checked={a.value === "1"} onChange={(v) => setArg(p.name, { value: v ? "1" : "0" })} label={p.name} />
            </div>
          ) : (
            <Field key={i} label={<span className="font-mono text-text">{p.name}</span>} hint={<span className="font-mono">{p.type}</span>}>
              <span className="flex items-center gap-2">
                <Input mono value={a.isNull ? "" : a.value} placeholder={a.isNull ? "NULL" : undefined} disabled={a.isNull} onChange={(e) => setArg(p.name, { value: e.target.value })} />
                <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-muted">
                  <Checkbox size={16} state={a.isNull ? "on" : "off"} label={t("routine.nullOf", { name: p.name })} onChange={() => setArg(p.name, { isNull: !a.isNull })} />
                  <span aria-hidden="true">NULL</span>
                </span>
              </span>
            </Field>
          );
        })}
        {outs.map((p, i) => (
          <div key={i} className="flex items-center justify-between rounded-[7px] border border-dashed border-border-strong px-2.5 py-2 text-xs text-muted">
            <span>
              <span className="font-mono text-text">{p.name}</span> · OUT {p.type}
            </span>
            <span>{t("routine.filledAfterRun")}</span>
          </div>
        ))}
        <Button size="lg" onClick={() => void run(false)} disabled={running}>
          <Play size={12} fill="currentColor" aria-hidden="true" />
          {t(running ? "routine.running" : "routine.run")}
        </Button>

        {(results || runError) && (
          <div className={cn("flex flex-col gap-2 rounded-lg p-3", failed ? "bg-prod-bg" : "bg-ok-bg")}>
            <div className="flex items-center justify-between text-xs text-muted">
              <span className={cn("font-medium", failed ? "text-prod" : "text-ok")}>{t(failed ? "routine.lastRunFailed" : "routine.lastRun")}</span>
              {results && <span>{results.reduce((n, s) => n + s.elapsedMs, 0)} ms</span>}
            </div>
            {runError && <p className="m-0 text-xs whitespace-pre-wrap text-prod">{runError}</p>}
            {results?.map((s, i) => <RunOutput key={i} s={s} />)}
          </div>
        )}
      </aside>

      <ReviewDialog
        id={`${tab.id}-review`}
        title={t("routine.reviewTitle", { name: r.name })}
        state={review}
        prod={conn.env === "prod"}
        onApply={() => void apply()}
        onClose={() => setReview(null)}
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
            {confirm?.join("\n\n")}
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
              setConfirm(null);
              void run(true);
            }}
          >
            {t("editor.confirm.run", { n: confirm?.length ?? 0 })}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/** One statement of a run: error, `name = value` for a single row, a small table otherwise. */
function RunOutput({ s }: { s: StatementResult }) {
  const t = useT();
  const body = s.error ? (
    <p className="m-0 text-xs whitespace-pre-wrap text-prod">{s.error.message}</p>
  ) : s.columns.length === 0 ? (
    <p className="m-0 text-xs text-muted">{s.affected !== undefined ? t("routine.affected", { n: s.affected }) : t("routine.noOutput")}</p>
  ) : s.rows.length === 1 ? (
    s.columns.map((c, j) => (
      <div key={j} className="font-mono text-[13px] break-all">
        {c.name} = <span className={c.numeric ? "text-syn-num" : undefined}>{formatCell(s.rows[0][j], c.numeric)}</span>
      </div>
    ))
  ) : (
    <div className="max-h-64 overflow-auto rounded-md border border-border bg-bg">
      <table className="w-full border-collapse font-mono text-[11.5px]">
        <thead>
          <tr>
            {s.columns.map((c) => (
              <th key={c.name} className="border-b border-border px-2 py-1 text-left font-normal text-muted">
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {s.rows.map((row, i) => (
            <tr key={i}>
              {row.map((v, j) => (
                <td key={j} className={cn("border-b border-border px-2 py-1 whitespace-nowrap", s.columns[j]?.numeric && "text-right")}>
                  {formatCell(v, s.columns[j]?.numeric)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <div className="flex flex-col gap-1">
      <code className="truncate font-mono text-[11px] text-faint" title={s.sql}>
        {s.sql}
      </code>
      {body}
      {s.truncated && <p className="m-0 text-xs text-muted">{t("routine.truncated")}</p>}
    </div>
  );
}
