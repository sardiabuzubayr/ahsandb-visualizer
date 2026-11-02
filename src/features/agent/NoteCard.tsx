import { useState } from "react";
import { Ban, BookOpen, Check, CircleX, Loader2 } from "lucide-react";
import { useT } from "../../i18n";
import { errorText } from "../../components/shell/useConnect";
import type { AgentDecision, AgentMessage, NoteItem } from "../../types";
import { Button, Checkbox, cn } from "../../components/ui";

type NoteMessage = Extract<AgentMessage, { role: "note" }>;

const label = (it: NoteItem) => (it.term ? it.term : it.column ? `${it.table}.${it.column}` : it.table);

/** Picks for the approve decision: the checked entries with their (possibly edited) text. */
export function notePicks(items: NoteItem[], keep: boolean[], texts: string[]): AgentDecision["picks"] {
  return items.flatMap((_, index) => (keep[index] && texts[index].trim() ? [{ index, text: texts[index].trim() }] : []));
}

/** Data-dictionary entries the agent proposes: before → after per entry; nothing is saved until Save. */
export function NoteCard({ msg, onDecide }: { msg: NoteMessage; onDecide: (d: AgentDecision) => Promise<void> }) {
  const t = useT();
  const [keep, setKeep] = useState(() => msg.items.map(() => true));
  const [texts, setTexts] = useState(() => msg.items.map((i) => i.after));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = msg.status === "pending";
  const picks = notePicks(msg.items, keep, texts);

  const decide = async (d: AgentDecision) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onDecide(d);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="group" aria-label={t("agent.note.card", { title: msg.title })} className="overflow-hidden rounded-[10px] border border-border-strong bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <BookOpen size={14} aria-hidden="true" className="shrink-0 text-accent" />
        <span className="shrink-0 font-semibold text-text">{t("agent.note.title")}</span>
        <span className="min-w-0 flex-1 truncate text-muted" title={msg.title}>
          {msg.title}
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-3 p-3">
        {msg.items.map((it, i) => (
          <li key={i} className={cn("flex flex-col gap-1.5", !keep[i] && "opacity-55")}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {pending && msg.items.length > 1 && (
                <Checkbox state={keep[i] ? "on" : "off"} size={15} label={t("agent.note.include")} onChange={() => setKeep((k) => k.map((v, j) => (j === i ? !v : v)))} />
              )}
              {it.term && <span className="text-[11px] text-faint">{t("agent.note.term")}</span>}
              <code className="min-w-0 font-mono text-[12px] break-words text-accent-strong">{label(it)}</code>
              {it.mapsTo && <code className="min-w-0 font-mono text-[11.5px] break-all text-muted">→ {it.mapsTo}</code>}
            </div>
            <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[12.5px] leading-[18px]">
              {it.before && (
                <>
                  <span className="text-faint">{t("agent.note.before")}</span>
                  <span className="text-muted line-through">{it.before}</span>
                </>
              )}
              <span className="text-faint">{t("agent.note.after")}</span>
              {editing && pending ? (
                <textarea
                  aria-label={t("agent.note.editText", { label: label(it) })}
                  value={texts[i]}
                  onChange={(e) => setTexts((x) => x.map((v, j) => (j === i ? e.target.value : v)))}
                  rows={Math.min(5, Math.max(2, Math.ceil(texts[i].length / 48)))}
                  className="w-full resize-y rounded-md border border-accent bg-bg px-2 py-1.5 text-[12.5px] leading-[18px] text-text outline-none"
                />
              ) : (
                <span className="text-text">{texts[i]}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 border-t border-border px-3 py-2.5">
        {pending && (
          <>
            <p className="m-0 text-[11.5px] text-faint">{t("agent.note.footer")}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" size="lg" disabled={busy} onClick={() => void decide({ kind: "reject" })}>
                {t("agent.reject")}
              </Button>
              {!editing && (
                <Button variant="outline" size="lg" disabled={busy} onClick={() => setEditing(true)}>
                  {t("agent.note.edit")}
                </Button>
              )}
              <Button variant="primary" size="lg" disabled={busy || !picks?.length} onClick={() => void decide({ kind: "approve", picks })}>
                {busy && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                {t("agent.note.save")}
              </Button>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="m-0 text-xs break-words text-prod">
            {error}
          </p>
        )}
        <NoteStatus msg={msg} />
      </div>
    </div>
  );
}

function NoteStatus({ msg }: { msg: NoteMessage }) {
  const t = useT();
  if (msg.status === "pending") return null;
  if (msg.status === "approved")
    return (
      <p role="status" className="m-0 flex items-center gap-1.5 text-xs text-muted">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        {t("agent.status.running")}
      </p>
    );
  if (msg.status === "done")
    return (
      <p role="status" className="m-0 flex items-center gap-1.5 text-xs text-ok">
        <Check size={12} strokeWidth={2.4} aria-hidden="true" />
        {t("agent.note.saved", { outcome: msg.outcome ?? "" })}
      </p>
    );
  if (msg.status === "failed")
    return (
      <p role="alert" className="m-0 flex items-center gap-1.5 text-xs break-words text-prod">
        <CircleX size={12} aria-hidden="true" />
        {t("agent.status.failed", { error: msg.outcome ?? "" })}
      </p>
    );
  return (
    <p role="status" className="m-0 flex items-center gap-1.5 text-xs text-muted">
      <Ban size={12} aria-hidden="true" />
      {t("agent.status.rejected")}
    </p>
  );
}
