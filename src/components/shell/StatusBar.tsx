import { useEffect } from "react";
import { Lock } from "lucide-react";
import { useI18n } from "../../i18n";
import { onJobFinished } from "../../lib/jobs";
import { useApp, useToast } from "../../state/app";
import { cn } from "../ui";
import { JobsPopover } from "./JobsPopover";
import { jobSummary } from "./jobsFormat";

export function StatusBar() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const { state } = useApp();
  // StatusBar is always mounted: the one place that toasts finished jobs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onJobFinished((job) => toast(jobSummary(job, t, lang))), [lang]);
  const tab = state.tabs.find((x) => x.id === state.activeTabId);
  const conn = state.connections.find((c) => c.id === (tab?.connectionId ?? state.activeConnectionId));
  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-4 overflow-hidden border-t border-border bg-panel px-3 text-[11.5px] whitespace-nowrap text-muted">
      {conn ? (
        <>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("size-[7px] rounded-full", conn.connected ? "bg-ok" : "bg-faint")} />
            {conn.connected ? t("status.connected") : t("status.disconnected")}
          </span>
          {conn.ssh && (
            <span className="flex items-center gap-1.5">
              <Lock size={11} aria-hidden="true" />
              {t("status.ssh", { host: `${conn.ssh.host.split(".")[0]}:${conn.ssh.port}` })}
            </span>
          )}
          <span>
            {conn.name}
            {conn.serverVersion && ` · ${conn.serverVersion}`}
          </span>
        </>
      ) : (
        <span>{t("status.noConnection")}</span>
      )}
      <span className="flex-1" />
      {tab?.dirty && <span className="text-accent">{t("status.unsaved")}</span>}
      <JobsPopover />
      <span>UTF-8</span>
    </footer>
  );
}
