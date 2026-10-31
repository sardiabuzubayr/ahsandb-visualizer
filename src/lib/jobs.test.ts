import { describe, expect, it, vi } from "vitest";
import type { JobDone, JobProgress } from "../types";

const handlers: { progress?: (p: JobProgress) => void; done?: (d: JobDone) => void } = {};
vi.mock("./api", () => ({
  api: {
    onJobProgress: async (cb: (p: JobProgress) => void) => ((handlers.progress = cb), () => {}),
    onJobDone: async (cb: (d: JobDone) => void) => ((handlers.done = cb), () => {}),
  },
}));

const { onJobFinished, trackJob } = await import("./jobs");

describe("jobs store", () => {
  it("applies a result that arrived before trackJob and still reports it finished", async () => {
    const seen: string[] = [];
    onJobFinished((j) => seen.push(`${j.id}:${j.result?.succeeded}`));
    await Promise.resolve();
    handlers.progress!({ jobId: "fast", done: 3, total: 3, message: "" });
    handlers.done!({ jobId: "fast", ok: true, cancelled: false, succeeded: 3, failed: 0, errors: [], message: "" });
    expect(seen).toEqual([]);
    trackJob("fast", "Export", "c1");
    expect(seen).toEqual(["fast:3"]);
  });
});
