import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Checkbox, Field, Input, Segmented, Switch } from "../../components/ui";
import { Select } from "../../components/ui/Select";
import { useConnectionError } from "../../components/shell/connectionError";
import { previewErrorText } from "../../components/shell/PreviewList";
import { errorText, useConnect } from "../../components/shell/useConnect";
import { CodeEditor } from "../editor/CodeEditor";
import { defaultSchema } from "../data/table";
import { ReviewDialog, type ReviewState } from "../routine/ReviewDialog";
import { useT } from "../../i18n";
import { api, isApiError } from "../../lib/api";
import { scopedId } from "../../lib/scope";
import { databaseNodes } from "../editor/treeScope";
import { useApp, useConnection, useTabDirty, useToast } from "../../state/app";
import type { AppErrorKind, Tab, Trigger } from "../../types";
import { EVENTS, PG_EVENTS, emptyTrigger, isDirty, noInsteadOf, normalize, objectsIn, triggerTarget, validate } from "./trigger";

const LABEL = "mb-1.5 text-xs text-muted";

export function TriggerEditorTab({ tab }: { tab: Tab }) {
  const t = useT();
  const toast = useToast();
  const conn = useConnection(tab.connectionId);
  const sid = scopedId(conn.id, tab.database);
  const { state, dispatch } = useApp();
  const markLost = useConnectionError();
  const { loadTree } = useConnect();
  const [key] = useState(() => triggerTarget(tab.target ?? tab.title));
  const schema = key.schema || defaultSchema(conn);
  const pg = conn.driver === "postgres";
  const [original, setOriginal] = useState<Trigger | null>(() => (key.isNew ? emptyTrigger(conn.driver, schema, key.table) : null));
  const [tr, setTr] = useState<Trigger | null>(original);
  const [loadError, setLoadError] = useState<{ kind?: AppErrorKind; message: string } | null>(null);
  const [nonce, setNonce] = useState(0); // Retry and reload after a save
  const [bodyKey, setBodyKey] = useState(0);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [deleting, setDeleting] = useState(false);
  const dirty = !!original && !!tr && isDirty(original, tr);
  useTabDirty(tab.id, dirty);

  useEffect(() => {
    if (key.isNew) return;
    let live = true;
    api.loadTrigger(sid, schema, key.name).then(
      (x) => {
        if (!live) return;
        setOriginal(x);
        setTr(x);
        setLoadError(null);
        setBodyKey((k) => k + 1); // CodeEditor only reads `value` on mount
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
  }, [key, schema, nonce, sid, markLost]);

  if (!tr || !original || loadError) {
    const notFound = loadError?.kind === "notFound" && loadError.message !== "Not connected";
    return (
      <div className="grid flex-1 place-items-center p-6 text-center">
        {loadError ? (
          <div role="alert" className="max-w-md">
            <p className="m-0 font-medium">
              {loadError.kind === "notSupported"
                ? t("trigger.notSupported")
                : notFound
                  ? t("trigger.notFound", { name: key.name, schema })
                  : loadError.message}
            </p>
            {(notFound || loadError.kind === "notSupported") && <p className="mt-1 mb-0 text-xs text-muted">{loadError.message}</p>}
            {loadError.kind !== "notSupported" && (
              <Button className="mt-3" onClick={() => (setLoadError(null), setNonce((n) => n + 1))}>
                {t("trigger.retry")}
              </Button>
            )}
          </div>
        ) : (
          <p className="m-0 text-muted">{t("trigger.loading")}</p>
        )}
      </div>
    );
  }

  const set = (patch: Partial<Trigger>) => setTr((x) => x && { ...x, ...patch });
  const toggleEvent = (e: string) => set({ events: tr.events.includes(e) ? tr.events.filter((x) => x !== e) : [...tr.events, e] });
  const discard = () => {
    setTr(original);
    setBodyKey((k) => k + 1);
  };
  const tree = state.trees[conn.id];
  const nodes = tree?.status === "ready" ? databaseNodes(tree.nodes, tab.database) : null;
  const tables = nodes ? objectsIn(nodes, schema, ["table", "view"]) : null;
  const functions = pg && nodes ? objectsIn(nodes, schema, ["function"]) : [];
  const error = validate(conn.driver, tr);
  const canSave = dirty && !error && !conn.readOnly;

  const preview = async (target: Trigger | null) => {
    setDeleting(!target);
    setReview({ busy: true });
    try {
      setReview({ preview: await api.previewTrigger(sid, key.isNew ? null : original, target) });
    } catch (e) {
      markLost(conn.id, e);
      setReview({ error: previewErrorText(t, e) });
    }
  };
  const save = () => void (canSave && preview(normalize(tr)));
  const apply = async () => {
    const p = review?.preview;
    if (!p) return;
    setReview({ preview: p, busy: true });
    try {
      const report = await api.applyPreview(sid, p.id, true);
      if (report.failed) {
        setReview({ preview: p, report });
        if (report.executed > 0) void loadTree(conn.id);
        return;
      }
      setReview(null);
      void loadTree(conn.id);
      if (deleting) {
        toast(t("trigger.deleted", { name: original.name }));
        dispatch({ type: "closeTab", id: tab.id, force: true });
        return;
      }
      const name = tr.name.trim();
      toast(t("trigger.saved", { name }));
      if (key.isNew || name !== original.name) {
        // The tab's target names the old (or no) trigger: reopen it on the trigger as it now exists.
        dispatch({ type: "closeTab", id: tab.id, force: true });
        dispatch({ type: "openTab", kind: "trigger", connectionId: conn.id, title: name, target: `${schema}.${name}`, database: tab.database });
      } else setNonce((n) => n + 1);
    } catch (e) {
      markLost(conn.id, e);
      setReview({ preview: p, error: previewErrorText(t, e) });
    }
  };

  return (
    <div
      className="flex min-h-0 flex-1"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          save();
        }
      }}
    >
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto px-6 py-5">
          <div className="flex flex-wrap items-end gap-4">
            <Field label={t("trigger.name")} className="flex-[1_1_240px]">
              <Input mono value={tr.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label={t("trigger.table")} hint={t("trigger.tableHint")} className="flex-[1_1_220px]">
              {tables ? (
                <Select mono value={tr.table} onChange={(e) => set({ table: e.target.value })}>
                  {!tr.table && (
                    <option value="" disabled>
                      {t("common.choose")}
                    </option>
                  )}
                  {[...new Set([...tables, ...(tr.table ? [tr.table] : [])])].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </Select>
              ) : (
                <Input mono value={tr.table} onChange={(e) => set({ table: e.target.value })} />
              )}
            </Field>
          </div>

          <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
            <div>
              <div className={LABEL}>{t("trigger.timing")}</div>
              <Segmented
                label={t("trigger.timing")}
                value={tr.timing}
                onChange={(timing) => set({ timing })}
                options={(["BEFORE", "AFTER", "INSTEAD OF"] as const)
                  .filter((x) => x !== "INSTEAD OF" || !noInsteadOf(conn.driver))
                  .map((x) => ({ value: x, label: <span className="font-mono text-[12px]">{x}</span> }))}
              />
            </div>
            {pg ? (
              <div role="group" aria-labelledby={`${tab.id}-events`}>
                <div id={`${tab.id}-events`} className={LABEL}>
                  {t("trigger.events")}
                </div>
                <div className="flex h-[34px] items-center gap-4">
                  {PG_EVENTS.map((e) => (
                    <label key={e} className="flex cursor-pointer items-center gap-1.5 font-mono text-[12px]">
                      <Checkbox size={16} state={tr.events.includes(e) ? "on" : "off"} label={e} onChange={() => toggleEvent(e)} />
                      <span aria-hidden="true">{e}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <div>
                <div className={LABEL}>{t("trigger.event")}</div>
                <Segmented
                  label={t("trigger.event")}
                  value={tr.events[0] ?? ""}
                  onChange={(e) => set({ events: [e] })}
                  options={EVENTS.map((x) => ({ value: x, label: <span className="font-mono text-[12px]">{x}</span> }))}
                />
              </div>
            )}
            <div>
              <div className={LABEL}>{t("trigger.level")}</div>
              <div className="flex h-[34px] items-center gap-2 font-mono text-[12px]">
                {pg && <Switch checked={tr.forEachRow} onChange={(forEachRow) => set({ forEachRow })} label={t("trigger.forEachRow")} />}
                <span className={pg ? undefined : "text-muted"}>{t(tr.forEachRow ? "trigger.levelRow" : "trigger.levelStatement")}</span>
              </div>
            </div>
          </div>

          {(pg || conn.driver === "sqlite") && (
            <Field label={t("trigger.when")} hint={t("trigger.whenHint")}>
              <Input mono value={tr.condition ?? ""} placeholder="NEW.status IS DISTINCT FROM OLD.status" onChange={(e) => set({ condition: e.target.value })} />
            </Field>
          )}

          {pg ? (
            <Field label={t("trigger.function")} hint={t("trigger.functionHint")}>
              <Input mono list={`${tab.id}-fns`} value={tr.body} placeholder={`${schema}.trg_touch()`} onChange={(e) => set({ body: e.target.value })} />
              <datalist id={`${tab.id}-fns`}>
                {functions.map((f) => (
                  <option key={f} value={`${schema}.${f}()`} />
                ))}
              </datalist>
            </Field>
          ) : (
            <section aria-label={t("trigger.body")} className="flex min-h-[300px] flex-1 flex-col">
              <h2 className="mt-0 mb-2 text-[13px] font-semibold">{t("trigger.body")}</h2>
              <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-panel">
                <div className="absolute inset-0">
                  <CodeEditor key={bodyKey} value={tr.body} onChange={(body) => set({ body })} driver={conn.driver} label={t("trigger.bodyEditor")} />
                </div>
              </div>
            </section>
          )}
        </div>

        <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2.5 border-t border-border bg-panel px-6 py-2.5">
          <span className="min-w-[240px] flex-1 text-xs text-muted">
            {conn.readOnly ? (
              t("trigger.readOnly")
            ) : dirty && error ? (
              <span role="alert" className="text-prod">
                {t(error)}
              </span>
            ) : null}
          </span>
          {!key.isNew && (
            <Button variant="ghost" size="lg" className="text-prod hover:text-prod" onClick={() => void preview(null)} disabled={conn.readOnly}>
              <Trash2 size={13} aria-hidden="true" />
              {t("trigger.delete")}
            </Button>
          )}
          <Button variant="ghost" size="lg" onClick={discard} disabled={!dirty}>
            {t("common.discard")}
          </Button>
          <Button variant="primary" size="lg" className="font-semibold" onClick={save} disabled={!canSave}>
            {t("trigger.save")}
            <span className="ml-0.5 font-mono text-[11px] opacity-75">⌘S</span>
          </Button>
        </div>
      </main>

      <ReviewDialog
        id={`${tab.id}-review`}
        title={t(deleting ? "trigger.deleteTitle" : "trigger.reviewTitle", { name: deleting ? original.name : tr.name.trim() || original.name })}
        state={review}
        prod={conn.env === "prod"}
        onApply={() => void apply()}
        onClose={() => setReview(null)}
      />
    </div>
  );
}
