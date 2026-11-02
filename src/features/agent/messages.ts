import type { AgentDecision, AgentEvent, AgentMessage } from "../../types";
import { confirmMatches } from "./confirm";

export type ActionMessage = Extract<AgentMessage, { role: "action" }>;
export type ResultMessage = Extract<AgentMessage, { role: "result" }>;

/** Chat list after one agent event: `message` events of this connection upsert by id; everything else leaves it as is. */
export function applyAgentEvent(messages: AgentMessage[], e: AgentEvent, connId: string): AgentMessage[] {
  return e.type === "message" && bareId(e.connId) === connId ? upsertMessage(messages, e.message) : messages;
}

/** Replaces the entry with the same id in place, or appends it. */
export function upsertMessage(messages: AgentMessage[], m: AgentMessage): AgentMessage[] {
  const i = messages.findIndex((x) => x.id === m.id);
  if (i < 0) return [...messages, m];
  const next = messages.slice();
  next[i] = m;
  return next;
}

/** "<connId>@<db>" → "<connId>" (history and events belong to the bare connection). */
export const bareId = (id: string) => id.split("@")[0];

export type StatusTone = "ok" | "danger" | "muted" | "running";

/** How a decided card reports its state; null while it waits for the user. */
export function actionStatusView(m: ActionMessage): { tone: StatusTone; key: string; vars?: Record<string, string | number> } | null {
  switch (m.status) {
    case "pending":
      return null;
    case "approved":
      return { tone: "running", key: "agent.status.running" };
    case "done":
      return m.outcome
        ? { tone: "ok", key: "agent.status.doneOutcome", vars: { ms: m.elapsedMs ?? 0, outcome: m.outcome } }
        : { tone: "ok", key: "agent.status.done", vars: { ms: m.elapsedMs ?? 0 } };
    case "failed":
      return { tone: "danger", key: "agent.status.failed", vars: { error: m.outcome ?? "" } };
    case "rejected":
      return { tone: "muted", key: "agent.status.rejected" };
    case "superseded":
      return { tone: "muted", key: "agent.status.superseded" };
  }
}

/** Approve decision for a card, or null while a production name still has to be typed. */
export function approveDecision(m: ActionMessage, typed: string): AgentDecision | null {
  if (m.status !== "pending") return null;
  if (!m.confirmName) return { kind: "approve" };
  return confirmMatches(typed, m.confirmName) ? { kind: "approve", typedName: typed.trim() } : null;
}

/** Edit decision, or null when the SQL is empty or unchanged (nothing to re-approve). */
export function editDecision(m: ActionMessage, sql: string): AgentDecision | null {
  const s = sql.trim();
  return s && s !== m.sql.trim() ? { kind: "edit", sql: s } : null;
}

export const cellText = (c: unknown) => (c === null || c === undefined ? "NULL" : String(c));

/** What "Copy" puts on the clipboard for a chat entry ("" = nothing worth copying). */
export function messageText(m: AgentMessage): string {
  switch (m.role) {
    case "user":
    case "agent":
      return m.text.trim();
    case "action":
      return m.sql;
    case "result":
      return [m.columns.map((c) => c.name), ...m.rows.map((r) => r.map(cellText))].map((r) => r.join("\t")).join("\n");
    case "note":
      return m.items.map((i) => `${i.term || (i.column ? `${i.table}.${i.column}` : i.table)}: ${i.after}`).join("\n");
  }
}
