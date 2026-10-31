import { ExternalLink } from "lucide-react";
import { useT } from "../../i18n";
import { Button, cn } from "../../components/ui";
import { cellText, type ResultMessage } from "./messages";

/** A read query the agent ran: compact table (≈10 rows tall, scrolls through the rest) + "Open in SQL editor". */
export function ResultView({ msg, onOpen }: { msg: ResultMessage; onOpen: (sql: string) => void }) {
  const t = useT();
  return (
    <div className="overflow-hidden rounded-[10px] border border-border-strong">
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 text-xs">
        <span className="shrink-0 rounded bg-raised px-[5px] py-px font-mono text-[10px] font-medium text-muted">{t("agent.level.read")}</span>
        <span className="min-w-0 truncate font-mono text-muted" title={msg.sql}>
          {msg.sql}
        </span>
      </div>
      {msg.columns.length > 0 && (
        // max-h = header (36px) + 10 rows × 25px
        <div className="max-h-[286px] overflow-auto">
          <table className="w-full border-collapse font-mono text-[11.5px]">
            <thead className="sticky top-0 bg-panel">
              <tr>
                {msg.columns.map((c) => (
                  <th key={c.name} scope="col" className="border-b border-border-strong px-2.5 py-1 text-left align-bottom font-medium whitespace-nowrap">
                    <span className="block">{c.name}</span>
                    <span className="block text-[10px] font-normal text-faint">{c.type}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {msg.rows.map((r, i) => (
                <tr key={i} className="border-b border-border last:border-b-0">
                  {r.map((c, j) => (
                    <td
                      key={j}
                      className={cn(
                        "h-6 max-w-[220px] truncate px-2.5 whitespace-nowrap",
                        msg.columns[j]?.numeric && "text-right",
                        c === null && "text-faint italic",
                      )}
                      title={cellText(c)}
                    >
                      {cellText(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-xs text-muted">
        <span>{t("agent.result.rows", { n: msg.rows.length, ms: msg.elapsedMs })}</span>
        {msg.truncated && <span className="text-stg">{t("agent.result.truncated", { n: msg.rows.length })}</span>}
        <span className="flex-1" />
        <Button size="sm" onClick={() => onOpen(msg.sql)}>
          <ExternalLink size={12} aria-hidden="true" />
          {t("agent.openInEditor")}
        </Button>
      </div>
    </div>
  );
}
