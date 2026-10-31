// Background import/export jobs: one store fed by the backend's job-progress / job-done events.
import { useSyncExternalStore } from "react";
import { api } from "./api";
import type { JobDone, JobProgress } from "../types";

export interface Job {
  id: string;
  /** Shown in the status bar and toasts, e.g. "Export orders_db". */
  title: string;
  connectionId: string;
  /** What `succeeded` counts. */
  unit?: "rows" | "statements";
  progress?: JobProgress;
  result?: JobDone;
}

let jobs: Job[] = [];
const subs = new Set<() => void>();
const doneSubs = new Set<(job: Job) => void>();
const set = (next: Job[]) => {
  jobs = next;
  subs.forEach((f) => f());
};
const patch = (id: string, p: Partial<Job>) => set(jobs.map((j) => (j.id === id ? { ...j, ...p } : j)));

// Events for ids not tracked yet: a fast job can finish before its start call returns to trackJob.
const early = new Map<string, Pick<Job, "progress" | "result">>();

function finished(job: Job) {
  doneSubs.forEach((f) => f(job));
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  void api.onJobProgress((p) => {
    if (jobs.some((j) => j.id === p.jobId)) patch(p.jobId, { progress: p });
    else early.set(p.jobId, { ...early.get(p.jobId), progress: p });
  });
  void api.onJobDone((d) => {
    if (!jobs.some((j) => j.id === d.jobId)) return void early.set(d.jobId, { ...early.get(d.jobId), result: d });
    patch(d.jobId, { result: d });
    finished(jobs.find((j) => j.id === d.jobId)!);
  });
}

/** Starts tracking a job right after its api call returned the id. */
export function trackJob(id: string, title: string, connectionId: string, unit: Job["unit"] = "rows") {
  listen();
  if (jobs.some((j) => j.id === id)) return;
  const job: Job = { id, title, connectionId, unit, ...early.get(id) };
  early.delete(id);
  set([...jobs, job]);
  if (job.result) finished(job);
}

/** Removes finished jobs from the list (running ones stay). */
export const clearFinishedJobs = () => set(jobs.filter((j) => !j.result));

/** Called once per finished job (for toasts). Returns an unsubscribe function. */
export function onJobFinished(cb: (job: Job) => void): () => void {
  listen();
  doneSubs.add(cb);
  return () => void doneSubs.delete(cb);
}

const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const useJobs = () => useSyncExternalStore(subscribe, () => jobs);
export const useJob = (id: string | null) => useJobs().find((j) => j.id === id);

// test hook
export const resetJobsForTest = () => (early.clear(), set([]));
