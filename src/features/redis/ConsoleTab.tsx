import { useEffect, useRef, useState } from "react";
import { Eraser } from "lucide-react";
import { useT } from "../../i18n";
import { api, isApiError } from "../../lib/api";
import { scopedId } from "../../lib/scope";
import { useConnection } from "../../state/app";
import type { Tab } from "../../types";
import { IconButton, cn } from "../../components/ui";
import { useConnectionError } from "../../components/shell/connectionError";
import { Cancelled, useProdConfirm } from "./useProdConfirm";

interface Line {
  id: number;
  command: string;
  text: string;
  error: boolean;
  ms?: number;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** redis-cli style console on one database: Enter runs, ↑/↓ walk the history. */
export function ConsoleTab({ tab }: { tab: Tab }) {
  const t = useT();
  const conn = useConnection(tab.connectionId);
  const db = tab.database ?? "0";
  const sid = scopedId(conn.id, db);
  const markLost = useConnectionError();
  const { run, dialog } = useProdConfirm(conn);
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const history = useRef<string[]>([]);
  const at = useRef(-1);
  const seq = useRef(0);
  const out = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  // Earlier commands of this connection (the console records them in the query history).
  useEffect(() => {
    api.history(conn.id, 100).then(
      (h) => void (history.current = [...new Set(h.map((x) => x.sql))]),
      () => {},
    );
  }, [conn.id]);
  useEffect(() => {
    out.current?.scrollTo({ top: out.current.scrollHeight });
  }, [lines]);

  const submit = async () => {
    const command = input.trim();
    if (!command || busy) return;
    if (command.toLowerCase() === "clear") return (setLines([]), setInput(""));
    history.current = [command, ...history.current.filter((h) => h !== command)];
    at.current = -1;
    setInput("");
    setBusy(true);
    const id = ++seq.current;
    try {
      const r = await run((confirmed) => api.kvCommand(sid, command, confirmed));
      setLines((l) => [...l, { id, command, text: r.text, error: r.error, ms: r.elapsedMs }]);
    } catch (e) {
      if (!(e instanceof Cancelled)) {
        markLost(conn.id, e);
        const text = isApiError(e, "readOnly") ? t("kv.readOnlyConn") : isApiError(e, "notFound") ? t("kv.notConnected") : errText(e);
        setLines((l) => [...l, { id, command, text: `(error) ${text}`, error: true }]);
      }
    } finally {
      setBusy(false);
      field.current?.focus();
    }
  };

  const walk = (dir: 1 | -1) => {
    const next = Math.max(-1, Math.min(history.current.length - 1, at.current + dir));
    at.current = next;
    setInput(next < 0 ? "" : history.current[next]);
  };

  const prompt = `db${db}>`;
  return (
    <div className="flex min-h-0 flex-1 flex-col" onClick={() => window.getSelection()?.isCollapsed && field.current?.focus()}>
      <div className="flex min-h-[46px] shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-[12.5px] text-faint">
          {conn.name}
          <span>›</span>
          <span className="font-medium text-text">db{db}</span>
        </span>
        <span className="truncate text-xs text-muted">{t("kv.consoleHint")}</span>
        <span className="flex-1" />
        <IconButton label={t("kv.clear")} onClick={() => setLines([])}>
          <Eraser size={14} />
        </IconButton>
      </div>
      <div ref={out} role="log" aria-label={t("kv.console")} className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[12.5px] leading-[19px] select-text">
        {lines.length === 0 && <p className="m-0 text-faint">{t("kv.consoleEmpty")}</p>}
        {lines.map((l) => (
          <div key={l.id} className="mb-2">
            <div className="text-muted">
              <span className="text-faint">{prompt}</span> {l.command}
              {l.ms !== undefined && <span className="ml-2 text-[11px] text-faint">{l.ms} ms</span>}
            </div>
            <pre className={cn("m-0 font-mono whitespace-pre-wrap break-all", l.error ? "text-prod" : "text-text")}>{l.text}</pre>
          </div>
        ))}
      </div>
      <label className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-3 py-2 font-mono text-[12.5px]">
        <span className="text-faint">{prompt}</span>
        <input
          ref={field}
          autoFocus
          aria-label={t("kv.command")}
          placeholder={busy ? t("kv.running") : t("kv.commandPlaceholder")}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={input}
          disabled={!conn.connected}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "ArrowUp") (e.preventDefault(), walk(1));
            if (e.key === "ArrowDown") (e.preventDefault(), walk(-1));
          }}
          className="min-w-0 flex-1 border-0 bg-transparent text-text outline-none"
        />
      </label>
      {dialog}
    </div>
  );
}
