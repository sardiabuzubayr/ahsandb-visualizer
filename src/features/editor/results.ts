import type { ResultSet, StatementError, StatementResult } from "../../types";

/** A result tab: a ResultSet plus what the backend says about errors and truncation. */
export type RunResult = ResultSet & { error?: StatementError; truncated?: boolean; /** Statement behind it (exported again by the Export button). */ sql?: string };

export function toResultSets(results: StatementResult[], runId: string): RunResult[] {
  return results.map((r, i) => ({
    id: `${runId}-${i}`,
    label: `Result ${i + 1}`,
    columns: r.columns,
    rows: r.rows,
    elapsedMs: r.elapsedMs,
    affected: r.affected,
    truncated: r.truncated,
    error: r.error,
    sql: r.sql,
  }));
}

/** Rows [start, end) to render for a windowed list of fixed-height rows. */
export function visibleRange(scrollTop: number, viewportHeight: number, rowHeight: number, total: number, overscan: number) {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { start, end: Math.max(start, end) };
}
