import { describe, expect, test, vi } from "vitest";
import { ApiError } from "../../lib/api";
import type { HostKeyInfo, SchemaNode } from "../../types";
import { clampMenu, stepIndex } from "../ui/ContextMenu";
import { isConnectionError } from "./connectionError";
import { hostKeyStep, withHostKey } from "./hostKey";
import { nodeActions, quoteIdent, selectSql } from "./tree";

const key: HostKeyInfo = { host: "bastion", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:abc", key: "ssh-ed25519 AAAA" };
const unknown = new ApiError("hostKeyUnknown", "Unknown host key", undefined, key);
const mismatch = new ApiError("hostKeyMismatch", "Host key changed", undefined, key);

describe("host key flow", () => {
  test("hostKeyStep classifies errors", () => {
    expect(hostKeyStep(unknown)).toBe("trust");
    expect(hostKeyStep(mismatch)).toBe("mismatch");
    expect(hostKeyStep(new ApiError("hostKeyUnknown", "no key attached"))).toBeNull();
    expect(hostKeyStep(new ApiError("connection", "down"))).toBeNull();
    expect(hostKeyStep(new Error("x"))).toBeNull();
  });

  test("unknown → trust → stores the key and retries exactly once", async () => {
    const call = vi.fn().mockRejectedValueOnce(unknown).mockResolvedValueOnce("ok");
    const ask = vi.fn().mockResolvedValue(true);
    const trust = vi.fn().mockResolvedValue(undefined);
    await expect(withHostKey(call, { ask, trust })).resolves.toBe("ok");
    expect(ask).toHaveBeenCalledWith("trust", key);
    expect(trust).toHaveBeenCalledWith(key);
    expect(call).toHaveBeenCalledTimes(2);
  });

  test("a retry that fails again is not retried a second time", async () => {
    const call = vi.fn().mockRejectedValue(unknown);
    const ask = vi.fn().mockResolvedValue(true);
    await expect(withHostKey(call, { ask, trust: async () => {} })).rejects.toBe(unknown);
    expect(call).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  test("cancel → nothing trusted, no retry", async () => {
    const call = vi.fn().mockRejectedValue(unknown);
    const trust = vi.fn();
    await expect(withHostKey(call, { ask: async () => false, trust })).rejects.toBe(unknown);
    expect(trust).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
  });

  test("mismatch → warning only, never retried or trusted", async () => {
    const call = vi.fn().mockRejectedValue(mismatch);
    const ask = vi.fn().mockResolvedValue(true);
    const trust = vi.fn();
    await expect(withHostKey(call, { ask, trust })).rejects.toBe(mismatch);
    expect(ask).toHaveBeenCalledWith("mismatch", key);
    expect(trust).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
  });

  test("other errors pass straight through without asking", async () => {
    const err = new ApiError("auth", "SSH authentication failed");
    const ask = vi.fn();
    await expect(withHostKey(() => Promise.reject(err), { ask, trust: async () => {} })).rejects.toBe(err);
    expect(ask).not.toHaveBeenCalled();
  });
});

test("connection errors mark disconnected; query errors don't", () => {
  expect(isConnectionError(new ApiError("connection", "SSH tunnel closed"))).toBe(true);
  expect(isConnectionError(new ApiError("notFound", "Not connected"))).toBe(true);
  expect(isConnectionError(new ApiError("notFound", "Table not found"))).toBe(false);
  expect(isConnectionError(new ApiError("query", "syntax error"))).toBe(false);
  expect(isConnectionError(new Error("connection"))).toBe(false);
});

describe("navigator context menu", () => {
  const node = (kind: SchemaNode["kind"], extra: Partial<SchemaNode> = {}): SchemaNode => ({ id: kind, label: kind, kind, ...extra });

  test("items per node kind", () => {
    expect(nodeActions(node("table"))).toEqual(["openData", "newSql", "copyName", "openEr", "openDictionary", "editTable", "newTrigger", "exportData", "importData", "dropTable"]);
    expect(nodeActions(node("view"))).toEqual(["openData", "editView", "newSql", "copyName", "openEr", "dropView"]);
    expect(nodeActions(node("schema"))).toEqual(["openEr", "openDictionary", "newTable", "newView", "export", "importSql", "refresh"]);
    // PostgreSQL's database node holds schemas (no ER of its own); MySQL/SQLite database nodes are the schema.
    expect(nodeActions(node("database"))).toEqual(["export", "importSql", "refresh"]);
    expect(nodeActions(node("database", { schema: "shop" }))).toEqual(["openEr", "openDictionary", "newTable", "newView", "export", "importSql", "refresh"]);
    expect(nodeActions(node("group"))).toEqual(["refresh"]);
    expect(nodeActions(node("function"))).toEqual(["open", "copyName"]);
    expect(nodeActions(node("procedure"))).toEqual(["open", "copyName"]);
    for (const k of ["role", "more"] as const) expect(nodeActions(node(k))).toEqual([]);
  });

  test("SELECT quotes identifiers per driver", () => {
    expect(selectSql("postgres", "orders", "public")).toBe('SELECT * FROM "public"."orders" LIMIT 100;');
    expect(selectSql("sqlite", "orders", "main")).toBe('SELECT * FROM "main"."orders" LIMIT 100;');
    expect(selectSql("mysql", "orders", "shop")).toBe("SELECT * FROM `shop`.`orders` LIMIT 100;");
    expect(selectSql("mariadb", "orders")).toBe("SELECT * FROM `orders` LIMIT 100;");
    expect(quoteIdent("postgres", 'we"ird')).toBe('"we""ird"');
    expect(quoteIdent("mysql", "we`ird")).toBe("`we``ird`");
  });

  test("menu stays inside the viewport", () => {
    expect(clampMenu(100, 100, 200, 150, 1440, 900)).toEqual({ left: 100, top: 100 });
    expect(clampMenu(1400, 880, 200, 150, 1440, 900)).toEqual({ left: 1236, top: 746 });
    expect(clampMenu(-5, -5, 200, 150, 1440, 900)).toEqual({ left: 4, top: 4 });
  });

  test("↑/↓ skip disabled items and wrap", () => {
    const enabled = [false, true, true, false];
    expect(stepIndex(enabled, -1, 1)).toBe(1);
    expect(stepIndex(enabled, -1, -1)).toBe(2);
    expect(stepIndex(enabled, 2, 1)).toBe(1);
    expect(stepIndex(enabled, 1, -1)).toBe(2);
    expect(stepIndex([false, false], -1, 1)).toBe(-1);
  });
});
