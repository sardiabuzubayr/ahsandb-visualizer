import { expect, test } from "vitest";
import { translate, dictionaries } from "../../i18n";
import type { Job } from "../../lib/jobs";
import { jobPercent, jobProgressText, jobSummary, jobsIndicator } from "./jobsFormat";

const t = (k: string, v?: Record<string, string | number>) => translate(dictionaries.en, k, v);
const job = (p: Partial<Job> = {}): Job => ({ id: "j1", title: "Export orders_db", connectionId: "c", ...p });
const done = (p: Partial<NonNullable<Job["result"]>>) => ({ jobId: "j1", ok: true, cancelled: false, succeeded: 12480, failed: 0, errors: [], message: "", ...p });

test("percent and progress text", () => {
  expect(jobPercent(job())).toBeUndefined();
  expect(jobPercent(job({ progress: { jobId: "j1", done: 21, total: 50, message: "" } }))).toBe(42);
  expect(jobPercent(job({ progress: { jobId: "j1", done: 60, total: 50, message: "" } }))).toBe(100);
  // No total (e.g. a query export): the count so far.
  expect(jobProgressText(job({ progress: { jobId: "j1", done: 1240, message: "" } }), "en")).toBe("1,240");
  expect(jobProgressText(job({ progress: { jobId: "j1", done: 0, total: 0, message: "" } }), "en")).toBe("0");
  expect(jobProgressText(job(), "en")).toBe("");
});

test("status bar indicator: one job with progress, several as a count, none → null", () => {
  const a = job({ progress: { jobId: "j1", done: 1, total: 4, message: "" } });
  expect(jobsIndicator([a], t, "en")).toBe("Export orders_db · 25%");
  expect(jobsIndicator([job()], t, "en")).toBe("Export orders_db");
  expect(jobsIndicator([a, job({ id: "j2" }), job({ id: "j3", result: done({}) })], t, "en")).toBe("2 jobs");
  expect(jobsIndicator([job({ result: done({}) })], t, "en")).toBeNull();
});

test("finished summaries: ok, with failures, cancelled, failed", () => {
  expect(jobSummary(job({ result: done({}) }), t, "en")).toBe("Export orders_db finished · 12,480 rows");
  expect(jobSummary(job({ result: done({ succeeded: 5, failed: 1 }) }), t, "en")).toBe("Export orders_db finished · 5 rows · 1 failed");
  expect(jobSummary(job({ result: done({ ok: false, cancelled: true }) }), t, "en")).toBe("Export orders_db cancelled");
  expect(jobSummary(job({ result: done({ ok: false, message: "permission denied" }) }), t, "en")).toBe("Export orders_db failed: permission denied");
  expect(jobSummary(job(), t, "en")).toBe("");
});
