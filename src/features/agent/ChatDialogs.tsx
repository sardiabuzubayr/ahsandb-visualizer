import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import { providerName } from "../../lib/aiPrefs";
import { errorText } from "../../components/shell/useConnect";
import type { AiProvider, AuditEntry } from "../../types";
import { Button, Dialog, DialogHeader, cn } from "../../components/ui";

/** "Clear chat?" — deletes this connection's conversation; the audit log stays. */
export function ClearChatDialog({ name, onConfirm, onClose }: { name: string; onConfirm: () => Promise<void>; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const clear = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} labelledBy="agent-clear-title" className="top-[18%] max-w-[420px]">
      <DialogHeader id="agent-clear-title" title={t("agent.clear.title")} onClose={onClose} />
      <div className="flex flex-col gap-3 px-5 py-4">
        <p className="m-0 text-muted">{t("agent.clear.body", { name })}</p>
        {error && (
          <p role="alert" className="m-0 break-words text-prod">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="lg" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" size="lg" disabled={busy} onClick={() => void clear()}>
            {t("agent.clear.confirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

const levelClass = { read: "bg-raised text-muted", change: "bg-accent-bg text-accent", critical: "bg-prod text-on-danger" };
const decisionClass: Record<string, string> = { approved: "text-ok", rejected: "text-muted", blocked: "text-prod" };
const cell = "border-b border-border px-3 py-2 align-top";

/** Every statement the agent ran or proposed on this connection, newest first (as the backend returns it). */
export function AuditDialog({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api.agentAudit(id, 200).then(
      (r) => live && setRows(r),
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => void (live = false);
  }, [id]);

  return (
    <Dialog open onClose={onClose} labelledBy="agent-audit-title" className="top-[8%] max-w-[980px]">
      <DialogHeader id="agent-audit-title" title={t("agent.audit.title")} onClose={onClose}>
        <span className="truncate text-muted">{name}</span>
      </DialogHeader>
      <div className="max-h-[70vh] overflow-auto">
        {error ? (
          <p role="alert" className="m-0 px-5 py-4 break-words text-prod">
            {error}
          </p>
        ) : !rows ? (
          <p role="status" className="m-0 flex items-center gap-2 px-5 py-4 text-muted">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            {t("agent.audit.loading")}
          </p>
        ) : rows.length === 0 ? (
          <p className="m-0 px-5 py-4 text-muted">{t("agent.audit.empty")}</p>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-panel text-left text-muted">
              <tr>
                {["time", "level", "decision", "sql", "outcome", "model"].map((k) => (
                  <th key={k} scope="col" className="border-b border-border-strong px-3 py-2 font-medium whitespace-nowrap">
                    {t(`agent.audit.${k}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td className={cn(cell, "whitespace-nowrap text-muted")}>{new Date(r.at).toLocaleString()}</td>
                  <td className={cell}>
                    <span className={cn("rounded px-[5px] py-px font-mono text-[10px] font-medium", levelClass[r.level])}>{t(`agent.level.${r.level}`)}</span>
                  </td>
                  <td className={cn(cell, "whitespace-nowrap", decisionClass[r.decision])}>{r.decision in decisionClass || r.decision === "auto" ? t(`agent.decision.${r.decision}`) : r.decision}</td>
                  <td className={cn(cell, "max-w-[360px] font-mono text-[11.5px] break-words whitespace-pre-wrap")}>{r.sql}</td>
                  <td className={cn(cell, "max-w-[200px] break-words")}>{r.outcome}</td>
                  <td className={cn(cell, "whitespace-nowrap text-muted")}>
                    <span className="block">{providerName(r.provider as AiProvider)}</span>
                    <span className="block font-mono text-[11px] text-faint">{r.model}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Dialog>
  );
}
