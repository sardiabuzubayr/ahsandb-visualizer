import type { TFn } from "../../i18n";
import type { Job } from "../../lib/jobs";

/** 0–100 when the backend knows the total; undefined otherwise. */
export const jobPercent = (j: Job): number | undefined => {
  const p = j.progress;
  return p?.total ? Math.min(100, Math.floor((p.done / p.total) * 100)) : undefined;
};

/** "42%" with a total, else the count so far ("1,240"); "" before the first progress event. */
export const jobProgressText = (j: Job, lang: string) => {
  const pct = jobPercent(j);
  return pct !== undefined ? `${pct}%` : j.progress ? j.progress.done.toLocaleString(lang) : "";
};

/** Status bar label for running jobs: one → "Export orders_db · 42%", several → "3 jobs"; none → null. */
export function jobsIndicator(jobs: Job[], t: TFn, lang: string): string | null {
  const running = jobs.filter((j) => !j.result);
  if (running.length > 1) return t("jobs.count", { n: running.length });
  if (!running.length) return null;
  const p = jobProgressText(running[0], lang);
  return p ? `${running[0].title} · ${p}` : running[0].title;
}

/** One-line result of a finished job (toast and popover). */
export function jobSummary(j: Job, t: TFn, lang: string): string {
  const r = j.result;
  if (!r) return "";
  if (r.cancelled) return t("jobs.cancelled", { title: j.title });
  if (!r.ok) return t("jobs.failed", { title: j.title, message: r.message });
  const done = t(j.unit === "statements" ? "jobs.doneStatements" : "jobs.done", { title: j.title, n: r.succeeded.toLocaleString(lang) });
  return r.failed ? `${done} · ${t("jobs.failedCount", { n: r.failed.toLocaleString(lang) })}` : done;
}
