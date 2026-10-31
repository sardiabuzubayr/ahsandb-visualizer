import { expect, test } from "vitest";
import { confirmMatches } from "./confirm";
import type { AgentEvent, AgentMessage } from "../../types";
import { actionStatusView, applyAgentEvent, approveDecision, cellText, editDecision, type ActionMessage } from "./messages";

test("type-to-confirm is exact, case-sensitive and trims the typed text", () => {
  expect(confirmMatches("order_items_backup_2024", "order_items_backup_2024")).toBe(true);
  expect(confirmMatches("  order_items_backup_2024 ", "order_items_backup_2024")).toBe(true);
  expect(confirmMatches("Order_items_backup_2024", "order_items_backup_2024")).toBe(false);
  expect(confirmMatches("order_items", "order_items_backup_2024")).toBe(false);
  expect(confirmMatches("", "order_items_backup_2024")).toBe(false);
  expect(confirmMatches("   ", "")).toBe(false);
});

const user: AgentMessage = { id: "u1", role: "user", text: "hapus sesi" };
const card: ActionMessage = {
  id: "act1",
  role: "action",
  level: "critical",
  title: "Delete expired sessions",
  sql: "DELETE FROM sessions WHERE expires_at < now()",
  status: "pending",
  impact: [],
  facts: [],
};
const msg = (message: AgentMessage, connId = "c1"): AgentEvent => ({ connId, type: "message", message });

test("applyAgentEvent appends new ids and replaces existing ones in place", () => {
  const a = applyAgentEvent([], msg(user), "c1");
  expect(a).toEqual([user]);
  const b = applyAgentEvent(a, msg(card), "c1");
  expect(b.map((m) => m.id)).toEqual(["u1", "act1"]);
  const done = { ...card, status: "done" as const, elapsedMs: 14, outcome: "412 rows affected" };
  const c = applyAgentEvent(b, msg(done), "c1");
  expect(c).toEqual([user, done]);
  expect(b[1]).toBe(card); // input not mutated
});

test("applyAgentEvent ignores other connections and non-message events", () => {
  const ms = [user];
  expect(applyAgentEvent(ms, msg(card, "c2"), "c1")).toBe(ms);
  expect(applyAgentEvent(ms, { connId: "c1", type: "status", running: true }, "c1")).toBe(ms);
  expect(applyAgentEvent(ms, { connId: "c1", type: "error", message: "x" }, "c1")).toBe(ms);
  // A scoped id ("<conn>@<db>") still belongs to the bare connection.
  expect(applyAgentEvent(ms, msg(card, "c1@shop"), "c1")).toHaveLength(2);
});

test("actionStatusView per status", () => {
  expect(actionStatusView(card)).toBeNull();
  expect(actionStatusView({ ...card, status: "approved" })?.tone).toBe("running");
  expect(actionStatusView({ ...card, status: "done", elapsedMs: 14, outcome: "3 rows" })).toEqual({
    tone: "ok",
    key: "agent.status.doneOutcome",
    vars: { ms: 14, outcome: "3 rows" },
  });
  expect(actionStatusView({ ...card, status: "done" })).toMatchObject({ key: "agent.status.done", vars: { ms: 0 } });
  expect(actionStatusView({ ...card, status: "failed", outcome: "boom" })).toMatchObject({ tone: "danger", vars: { error: "boom" } });
  expect(actionStatusView({ ...card, status: "rejected" })?.key).toBe("agent.status.rejected");
  expect(actionStatusView({ ...card, status: "superseded" })?.key).toBe("agent.status.superseded");
});

test("approveDecision needs the typed production name and sends it trimmed", () => {
  expect(approveDecision(card, "")).toEqual({ kind: "approve" });
  const prod = { ...card, confirmName: "sessions" };
  expect(approveDecision(prod, "")).toBeNull();
  expect(approveDecision(prod, "Sessions")).toBeNull();
  expect(approveDecision(prod, " sessions ")).toEqual({ kind: "approve", typedName: "sessions" });
  expect(approveDecision({ ...prod, status: "done" }, "sessions")).toBeNull();
});

test("editDecision only for changed, non-empty SQL", () => {
  expect(editDecision(card, card.sql)).toBeNull();
  expect(editDecision(card, "   ")).toBeNull();
  expect(editDecision(card, " DELETE FROM sessions WHERE id = 1 ")).toEqual({ kind: "edit", sql: "DELETE FROM sessions WHERE id = 1" });
});

test("cellText shows NULL for missing values", () => {
  expect(cellText(null)).toBe("NULL");
  expect(cellText(0)).toBe("0");
  expect(cellText("x")).toBe("x");
});
