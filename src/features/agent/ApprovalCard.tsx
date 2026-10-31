import { useState } from "react";
import { Ban, Check, CircleX, Download, Loader2, Repeat, ShieldCheck, TriangleAlert } from "lucide-react";
import { useT } from "../../i18n";
import { errorText } from "../../components/shell/useConnect";
import { useApp } from "../../state/app";
import type { AgentDecision } from "../../types";
import { Button, SectionLabel, cn } from "../../components/ui";
import { actionStatusView, approveDecision, editDecision, type ActionMessage, type StatusTone } from "./messages";

/** Leading SQL keywords (e.g. "DROP TABLE ") get the keyword color. */
function Sql({ sql }: { sql: string }) {
  const [, kw = "", rest = sql] = /^((?:[A-Z]+ )+)(.*)$/s.exec(sql) ?? [];
  return (
    <>
      <span className="text-syn-kw">{kw}</span>
      {rest}
    </>
  );
}

const toneClass: Record<StatusTone, string> = { ok: "text-ok", danger: "text-prod", muted: "text-muted", running: "text-muted" };
const toneIcon = { ok: Check, danger: CircleX, muted: Ban, running: Loader2 };

function Status({ msg }: { msg: ActionMessage }) {
  const t = useT();
  const v = actionStatusView(msg);
  if (!v) return null;
  const Icon = msg.status === "superseded" ? Repeat : toneIcon[v.tone];
  return (
    <p role={v.tone === "danger" ? "alert" : "status"} className={cn("m-0 flex items-start gap-1.5 text-xs break-words", toneClass[v.tone])}>
      <Icon size={12} strokeWidth={2.4} aria-hidden="true" className={cn("mt-[3px] shrink-0", v.tone === "running" && "animate-spin")} />
      <span className="min-w-0">{t(v.key, v.vars)}</span>
    </p>
  );
}

/** Approval card for one proposed statement; the level comes from the app's own SQL check. */
export function ApprovalCard({ msg, onDecide }: { msg: ActionMessage; onDecide: (d: AgentDecision) => Promise<void> }) {
  const t = useT();
  const { dispatch } = useApp();
  const [typed, setTyped] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const critical = msg.level === "critical";
  const pending = msg.status === "pending";
  const approve = approveDecision(msg, typed);
  const edit = editing === null ? null : editDecision(msg, editing);

  const decide = async (d: AgentDecision | null) => {
    if (!d || busy) return;
    setBusy(true);
    setError("");
    try {
      await onDecide(d);
      setEditing(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const [before, after] = t("agent.confirmLabel").split("{name}");
  return (
    <div
      role="group"
      aria-label={t(critical ? "agent.card.critical" : "agent.card.change", { title: msg.title })}
      className={cn(
        "overflow-hidden rounded-[10px] border",
        critical ? "border-prod" : "border-border-strong",
        critical && pending && "shadow-[0_0_0_3px_var(--prod-glow)]",
        msg.status === "superseded" && "opacity-60",
      )}
    >
      <div className={cn("flex items-center gap-2 border-b px-3 py-2 text-xs", critical ? "border-prod/30 bg-prod-bg text-prod" : "border-border bg-surface")}>
        {critical && <TriangleAlert size={14} aria-hidden="true" className="shrink-0" />}
        <span
          className={cn(
            "shrink-0 rounded px-[5px] py-px font-mono text-[10px] font-medium",
            critical ? "bg-prod text-on-danger" : msg.level === "read" ? "bg-raised text-muted" : "bg-accent-bg text-accent",
          )}
        >
          {t(`agent.level.${msg.level}`)}
        </span>
        <span className={cn("min-w-0 truncate font-medium", !critical && "text-text")} title={msg.title}>
          {msg.title}
        </span>
      </div>

      <div className="flex flex-col gap-3 p-3">
        {editing !== null ? (
          <textarea
            aria-label={t("agent.editSql")}
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            rows={Math.min(10, Math.max(3, editing.split("\n").length + 1))}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-accent bg-bg px-2.5 py-2 font-mono text-xs leading-[18px] text-text outline-none"
          />
        ) : (
          <code className="block overflow-x-auto rounded-md border border-border bg-bg px-2.5 py-2 font-mono text-xs leading-[18px] whitespace-pre">
            <Sql sql={msg.sql} />
          </code>
        )}

        {msg.facts.length > 0 && (
          <div>
            <SectionLabel className="mb-1.5 flex items-center gap-1.5">{t("agent.facts")}</SectionLabel>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {msg.facts.map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <ShieldCheck size={13} strokeWidth={2} aria-hidden="true" className={cn("mt-[3px] shrink-0", critical ? "text-prod" : "text-accent")} />
                  <span className="min-w-0">{f}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {msg.impact.length > 0 && (
          <div className="border-l-2 border-border-strong pl-3">
            <SectionLabel className="mb-1.5">{t("agent.impact")}</SectionLabel>
            <ul className="m-0 flex list-disc flex-col gap-1 pl-[18px] text-muted">
              {msg.impact.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}

        {pending && critical && (
          <>
            {/^\s*(DROP\s+TABLE|TRUNCATE|DELETE)\b/i.test(msg.sql) && (
              <Button className="self-start text-xs" onClick={() => dispatch({ type: "openDialog", dialog: "export" })}>
                <Download size={12} aria-hidden="true" />
                {t("agent.exportFirst")}
              </Button>
            )}
            {msg.confirmName && (
              <label className="block">
                <span className="mb-1.5 block text-xs text-muted">
                  {before}
                  <span className="font-mono text-text">{msg.confirmName}</span>
                  {after}
                </span>
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void decide(approve)}
                  spellCheck={false}
                  autoComplete="off"
                  className="h-8 w-full rounded-md border border-prod bg-bg px-2.5 font-mono text-xs text-text outline-none"
                />
              </label>
            )}
          </>
        )}

        {pending && (
          <div className="flex flex-wrap justify-end gap-2">
            {editing !== null ? (
              <>
                <Button variant="ghost" size="lg" disabled={busy} onClick={() => setEditing(null)}>
                  {t("common.cancel")}
                </Button>
                <Button variant="primary" size="lg" disabled={busy || !edit} onClick={() => void decide(edit)}>
                  {t("agent.submitEdit")}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="lg" disabled={busy} onClick={() => void decide({ kind: "reject" })}>
                  {t("agent.reject")}
                </Button>
                {!critical && (
                  <Button variant="outline" size="lg" disabled={busy} onClick={() => setEditing(msg.sql)}>
                    {t("agent.editSql")}
                  </Button>
                )}
                <Button variant={critical ? "danger" : "primary"} size="lg" disabled={busy || !approve} onClick={() => void decide(approve)}>
                  {busy && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                  {t(critical ? "agent.approveCritical" : "agent.approve")}
                </Button>
              </>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="m-0 text-xs break-words text-prod">
            {error}
          </p>
        )}
        <Status msg={msg} />
        {critical && pending && <p className="m-0 text-[11.5px] text-faint">{t("agent.flagNote")}</p>}
      </div>
    </div>
  );
}
