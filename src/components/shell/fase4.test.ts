import { describe, expect, test } from "vitest";
import { ApiError } from "../../lib/api";
import { partiallyApplied, previewBadges, previewErrorText, reportLines } from "./PreviewList";

describe("PreviewList helpers", () => {
  test("badges: transactional or not, plus destructive", () => {
    expect(previewBadges({ transactional: true, destructive: false })).toEqual(["transactional"]);
    expect(previewBadges({ transactional: false, destructive: true })).toEqual(["notTransactional", "destructive"]);
  });

  test("report lines: success, rolled back, partial, nothing applied", () => {
    expect(reportLines({ executed: 3, rolledBack: false })).toEqual([{ tone: "ok", key: "preview.applied", vars: { n: 3 } }]);
    const failed = { index: 1, message: "boom" };
    const fail = { tone: "error", key: "preview.failed", vars: { n: 2, message: "boom" } };
    expect(reportLines({ executed: 2, failed, rolledBack: true })).toEqual([fail, { tone: "warn", key: "preview.rolledBack" }]);
    expect(reportLines({ executed: 1, failed, rolledBack: false })).toEqual([fail, { tone: "warn", key: "preview.partial", vars: { n: 1 } }]);
    expect(reportLines({ executed: 0, failed: { index: 0, message: "boom" }, rolledBack: false })[1].key).toBe("preview.nothingApplied");
    expect(partiallyApplied({ executed: 1, failed, rolledBack: false })).toBe(true);
    expect(partiallyApplied({ executed: 2, failed, rolledBack: true })).toBe(false);
  });

  test("error text: expired preview and read-only get their own message", () => {
    const t = (k: string) => k;
    expect(previewErrorText(t, new ApiError("notFound", "unknown preview"))).toBe("preview.expired");
    expect(previewErrorText(t, new ApiError("readOnly", "ro"))).toBe("preview.readOnly");
    expect(previewErrorText(t, new ApiError("query", "syntax error"))).toBe("syntax error");
  });
});
