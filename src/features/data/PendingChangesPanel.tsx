import { useEffect, useState, type ReactNode } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { useI18n } from "../../i18n";
import { api } from "../../lib/api";
import { useToast } from "../../state/app";
import type { ApplyReport, Cell, Column, Connection, PendingChange, Preview } from "../../types";
import { Button, SectionLabel, cn } from "../../components/ui";
import { PreviewList, previewErrorText } from "../../components/shell/PreviewList";
import { formatCell } from "../editor/format";
import { RowGone, toRowChanges } from "./pending";

const KIND_STYLE = {
  update: "text-accent bg-accent-bg",
  insert: "text-ok bg-ok-bg",
  delete: "text-prod bg-prod-bg",
};

export function PendingChangesPanel({
  changes,
  schema,
  table,
  columns,
  rows,
  conn,
  sid,
  onDiscard,
  onApplied,
}: {
  changes: PendingChange[];
  schema: string;
  table: string;
  columns: Column[];
  rows: Cell[][];
  conn: Connection;
  /** IPC id the preview is made and applied with (scopedId of the tab). */
  sid: string;
  onDiscard: () => void;
  /** Apply succeeded: the caller clears the edits and reloads the grid. */
  onApplied: () => void;
}) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const pkIdx = Math.max(0, columns.findIndex((c) => c.pk));
  const pk = columns[pkIdx]?.name ?? "id";
  const fmt = (name: string, v: Cell) => formatCell(v, columns.find((c) => c.name === name)?.numeric);
  const prod = conn.env === "prod";
  const [preview, setPreview] = useState<Preview | null>(null);
  const [report, setReport] = useState<ApplyReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Any edit makes the reviewed SQL stale.
  useEffect(() => {
    setPreview(null);
    setReport(null);
    setError("");
  }, [changes]);
  const canApply = !!preview && !report;

  const review = async () => {
    setBusy(true);
    setReport(null);
    setError("");
    try {
      setPreview(await api.previewRowChanges(sid, schema, table, toRowChanges(changes, columns, rows)));
    } catch (e) {
      setPreview(null);
      setError(e instanceof RowGone ? t("data.rowGone", { key: e.rowKey }) : previewErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.applyPreview(sid, preview.id, true);
      if (r.failed) setReport(r);
      else onApplied();
    } catch (e) {
      setPreview(null);
      setError(previewErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  const [warnPre, warnPost] = t("data.prodWarning").split("{name}");

  // mock: one-line summaries tuned to the orders fixture, with a generic fallback.
  const detail = (c: PendingChange): ReactNode => {
    if (c.kind === "update")
      return (
        <>
          {c.column}: <s>{fmt(c.column, c.from)}</s> → {fmt(c.column, c.to)}
        </>
      );
    if (c.kind === "insert") {
      const { customer_id, total } = c.values;
      if (customer_id != null && total != null)
        return t("data.insertDetail", { customer: String(customer_id), total: fmt("total", total) });
      return Object.entries(c.values)
        .map(([k, v]) => fmt(k, v))
        .join(" · ") || t("data.allDefaults");
    }
    const row = rows.find((r) => String(r[pkIdx]) === c.rowKey);
    const at = (name: string) => row?.[columns.findIndex((col) => col.name === name)];
    const status = at("status");
    const created = at("created_at");
    if (row && status != null && created != null) {
      const date = new Date(String(created).replace(" ", "T")).toLocaleDateString(lang === "id" ? "id-ID" : "en-GB", {
        day: "numeric",
        month: "short",
      });
      return t("data.deleteDetail", { status: String(status), date });
    }
    return row?.map((v, i) => (i === pkIdx ? null : fmt(columns[i].name, v))).filter(Boolean).join(" · ");
  };

  return (
    <aside
      aria-label={t("data.pending")}
      className="flex h-full max-w-[380px] min-w-[300px] flex-[1_1_340px] flex-col border-l border-border bg-panel"
    >
      <div className="border-b border-border px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-sm font-semibold">{t("data.pending")}</h2>
          <span className="rounded-[10px] bg-accent-bg px-1.5 font-mono text-[11px] leading-[18px] text-accent">
            {changes.length}
          </span>
        </div>
        <p className="mt-1 mb-0 text-xs text-muted">{t("data.pendingHint")}</p>
      </div>

      <ul className="m-0 flex max-h-64 shrink-0 list-none flex-col gap-1.5 overflow-y-auto px-3 pt-3 pb-1">
        {changes.map((c) => (
          <li
            key={c.kind === "insert" ? c.tempId : `${c.kind}-${c.rowKey}-${c.kind === "update" ? c.column : ""}`}
            className="flex items-start gap-2.5 rounded-lg border border-border bg-surface p-2.5"
          >
            <span className={cn("mt-px rounded px-[5px] py-px font-mono text-[10px] font-medium", KIND_STYLE[c.kind])}>
              {c.kind.toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 text-[12.5px]">
              <span className="font-medium">{c.kind === "insert" ? t("data.newRow") : `${pk} ${c.rowKey}`}</span>
              <span className="block truncate text-muted">{detail(c)}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between px-4 pt-2.5 pb-1.5">
        <SectionLabel>{t("data.sqlPreview")}</SectionLabel>
        {preview && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(preview.statements.map((x) => x.replace(/;?\s*$/, ";")).join("\n"));
              toast(t("data.copied"));
            }}
          >
            {t("common.copy")}
          </Button>
        )}
      </div>
      <div className="mx-3 min-h-[120px] flex-1 overflow-auto">
        {preview ? (
          <PreviewList preview={preview} report={report} />
        ) : (
          <div className="grid h-full min-h-[120px] place-items-center rounded-lg border border-dashed border-border-strong px-4 text-center text-xs text-muted">
            {busy ? (
              <span role="status" className="flex items-center gap-2">
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                {t("data.reviewing")}
              </span>
            ) : (
              t("data.reviewHint")
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 mb-0 text-xs break-words text-prod">
            {error}
          </p>
        )}
      </div>
      <p className="mx-4 mt-2 mb-0 text-xs text-muted">{t(conn.readOnly ? "data.readOnlyConn" : "data.txnNote")}</p>

      {prod && (
        <div className="mx-3 mt-3 flex items-start gap-2.5 rounded-lg bg-prod-bg px-3 py-2.5 text-xs text-prod">
          <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
          <span>
            {warnPre}
            <b>{conn.name}</b>
            {warnPost}
          </span>
        </div>
      )}
      <div className="flex justify-end gap-2 p-3">
        <Button variant="outline" size="lg" onClick={onDiscard}>
          {t("data.discardAll")}
        </Button>
        {canApply ? (
          <Button variant={prod ? "danger" : "primary"} size="lg" disabled={busy} onClick={() => void apply()}>
            {t("data.apply", { n: changes.length })}
          </Button>
        ) : (
          <Button variant="primary" size="lg" disabled={busy || conn.readOnly} onClick={() => void review()}>
            {t(report ? "data.reviewAgain" : "data.review")}
          </Button>
        )}
      </div>
    </aside>
  );
}
