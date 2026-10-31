import { Suspense, lazy, useState, type ReactNode } from "react";
import { ChartColumn, CircleAlert, Download, LoaderCircle, Table2 } from "lucide-react";
import { useT } from "../../i18n";
import { getEditorPrefs } from "../../lib/editorPrefs";
import { useApp } from "../../state/app";
import { Loading, Segmented, cn } from "../../components/ui";
import { ResultGrid } from "./ResultGrid";
import type { RunResult } from "./results";

// ECharts is heavy: load the chart only when it is first shown.
const ChartView = lazy(() => import("../chart/ChartView").then((m) => ({ default: m.ChartView })));

export type ResultView = "grid" | "chart";

/** A run that failed before producing results (not connected, blocked on read-only, …). */
export interface RunError {
  message: string;
  hint?: string;
  statements?: string[];
}

function ErrorPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="alert" className="min-h-0 flex-1 overflow-auto p-4">
      <div className="flex items-start gap-2.5 rounded-lg bg-prod-bg px-3 py-2.5 text-prod">
        <CircleAlert size={15} className="mt-px shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="m-0 font-medium">{title}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

export function ResultsPanel({
  results,
  error,
  running,
  view,
  onView,
  onLoadMore,
}: {
  results: RunResult[] | null;
  error?: RunError | null;
  running: boolean;
  view: ResultView;
  onView: (v: ResultView) => void;
  /** Fetch the next batch of rows for a truncated result (re-runs that read statement). */
  onLoadMore?: (result: RunResult) => Promise<void>;
}) {
  const [loadingMore, setLoadingMore] = useState(false);
  const t = useT();
  const { state, dispatch } = useApp();
  const [active, setActive] = useState(0);
  const result = results?.[active] ?? results?.[0];
  const meta = (r: RunResult) =>
    r.error
      ? t("results.failed")
      : r.affected !== undefined
      ? t("results.affected", { n: r.affected, ms: r.elapsedMs })
      : t("results.rows", { n: r.rows.length, ms: r.elapsedMs });

  return (
    <section aria-label={t("results.label")} className="flex min-h-0 flex-1 flex-col border-t border-border">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border bg-panel px-2">
        {results?.map((r, i) => (
          <button
            key={r.id}
            type="button"
            aria-pressed={r === result}
            onClick={() => setActive(i)}
            className={cn(
              "inline-flex h-7 items-center gap-2 rounded-md px-2.5",
              r === result ? "bg-raised" : "text-muted hover:text-text",
            )}
          >
            {r.error && <span aria-hidden="true" className="size-1.5 rounded-full bg-prod" />}
            {t("results.tab", { n: i + 1 })}
            <span className={cn("text-[11.5px]", r.error ? "text-prod" : r === result ? "text-muted" : "text-faint")}>{meta(r)}</span>
          </button>
        ))}
        {running && (
          <span role="status" className="inline-flex h-7 items-center gap-2 px-2.5 text-muted">
            <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
            {t("results.running")}
          </span>
        )}
        <span className="flex-1" />
        <Segmented
          label={t("results.view")}
          size="sm"
          value={view}
          onChange={onView}
          options={[
            { value: "grid", label: <><Table2 size={13} aria-hidden="true" />{t("results.grid")}</> },
            { value: "chart", label: <><ChartColumn size={13} aria-hidden="true" />{t("results.chart")}</> },
          ]}
        />
        {view === "grid" && (
          <button
            type="button"
            // The panel lives in the active tab: its connection and database scope the re-run export.
            disabled={!result?.sql || !!result.error || result.affected !== undefined}
            onClick={() => {
              const tab = state.tabs.find((x) => x.id === state.activeTabId);
              if (!tab || !result?.sql) return;
              dispatch({ type: "openDialog", dialog: "exportData", connectionId: tab.connectionId, context: { database: tab.database, sql: result.sql } });
            }}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-muted hover:bg-raised hover:text-text disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <Download size={14} aria-hidden="true" />
            {t("results.export")}
          </button>
        )}
      </div>
      {error ? (
        <ErrorPanel title={error.message}>
          {error.hint && <p className="mt-1 mb-0 text-muted">{error.hint}</p>}
          {error.statements && error.statements.length > 0 && (
            <pre className="mt-2 mb-0 max-h-48 overflow-auto rounded-md bg-bg px-3 py-2 font-mono text-[11.5px] leading-[19px] whitespace-pre-wrap text-text">
              {error.statements.join("\n\n")}
            </pre>
          )}
        </ErrorPanel>
      ) : !result ? (
        <p className="m-0 grid flex-1 place-items-center text-muted">{running ? "" : t("results.empty")}</p>
      ) : result.error ? (
        <ErrorPanel title={t("results.errorTitle")}>
          <p className="mt-1 mb-0 font-mono text-[12px] whitespace-pre-wrap text-text">{result.error.message}</p>
          {result.error.position !== undefined && (
            <p className="mt-1 mb-0 text-xs text-muted">{t("results.position", { n: result.error.position })}</p>
          )}
        </ErrorPanel>
      ) : result.affected !== undefined && result.columns.length === 0 ? (
        <p className="m-0 grid flex-1 place-items-center text-muted">{meta(result)}</p>
      ) : (
        <>
          {result.truncated && (
            <p role="status" className="m-0 flex shrink-0 items-center gap-2 border-b border-border bg-stg-bg px-3 py-1 text-xs text-stg">
              <span className="flex-1">{t("results.truncated", { n: result.rows.length.toLocaleString("en-US") })}</span>
              {onLoadMore && result.sql && (
                <button
                  type="button"
                  disabled={loadingMore || running}
                  onClick={() => {
                    setLoadingMore(true);
                    void onLoadMore(result).finally(() => setLoadingMore(false));
                  }}
                  className="rounded px-1.5 font-medium underline underline-offset-2 hover:text-text disabled:opacity-60"
                >
                  {t(loadingMore ? "results.loadingMore" : "results.loadMore", { n: getEditorPrefs().pageSize })}
                </button>
              )}
            </p>
          )}
          {view === "chart" ? (
            <Suspense fallback={<Loading className="flex-1" />}>
              <ChartView key={result.id} result={result} />
            </Suspense>
          ) : (
            <ResultGrid key={result.id} result={result} label={t("results.tab", { n: results!.indexOf(result) + 1 })} />
          )}
        </>
      )}
    </section>
  );
}
