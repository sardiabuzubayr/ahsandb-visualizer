import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useI18n } from "../../i18n";
import { api } from "../../lib/api";
import { clearFinishedJobs, useJobs, type Job } from "../../lib/jobs";
import { useToast } from "../../state/app";
import { Button, cn } from "../ui";
import { errorText } from "./useConnect";
import { jobPercent, jobProgressText, jobSummary, jobsIndicator } from "./jobsFormat";

/** Thin progress bar; without a known total it pulses at full width. */
export function JobBar({ job }: { job: Job }) {
  const pct = jobPercent(job);
  const r = job.result;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-raised">
      <div
        className={cn(
          "h-full rounded-full",
          r ? (r.ok ? "bg-ok" : r.cancelled ? "bg-faint" : "bg-prod") : "bg-accent",
          !r && pct === undefined && "animate-pulse",
        )}
        style={{ width: `${r || pct === undefined ? 100 : pct}%` }}
      />
    </div>
  );
}

/** Status bar entry for background jobs: compact indicator, click → list with Cancel / Clear finished. */
export function JobsPopover() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const jobs = useJobs();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!jobs.length) return null;

  const running = jobs.some((j) => !j.result);
  const cancel = (j: Job) => api.cancelJob(j.id).catch((e: unknown) => toast(errorText(e)));
  return (
    <div ref={box}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className="flex h-5 max-w-[320px] items-center gap-1.5 rounded px-1.5 hover:bg-raised hover:text-text"
      >
        {running ? <Loader2 size={11} className="shrink-0 animate-spin" aria-hidden="true" /> : <Check size={11} className="shrink-0 text-ok" aria-hidden="true" />}
        <span className="truncate">{jobsIndicator(jobs, t, lang) ?? t("jobs.finishedCount", { n: jobs.length })}</span>
      </button>
      {open && (
        // fixed: the status bar clips overflow.
        <div
          role="dialog"
          aria-label={t("jobs.title")}
          className="fixed right-3 bottom-[32px] z-50 w-[360px] rounded-lg border border-border-strong bg-panel text-[12.5px] whitespace-normal text-text shadow-[0_12px_32px_rgba(0,0,0,.45)]"
        >
          <div className="flex items-center justify-between border-b border-border py-2 pr-2 pl-3">
            <span className="font-semibold">{t("jobs.title")}</span>
            <Button variant="ghost" size="sm" disabled={!jobs.some((j) => j.result)} onClick={clearFinishedJobs}>
              {t("jobs.clear")}
            </Button>
          </div>
          <ul className="m-0 max-h-[320px] list-none divide-y divide-border overflow-auto p-0">
            {jobs.map((j) => (
              <li key={j.id} className="flex flex-col gap-1.5 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium" title={j.title}>
                    {j.title}
                  </span>
                  {!j.result && (
                    <>
                      <span className="font-mono text-[11.5px] text-muted">{jobProgressText(j, lang)}</span>
                      <Button variant="ghost" size="sm" aria-label={t("jobs.cancelLabel", { title: j.title })} onClick={() => void cancel(j)}>
                        {t("jobs.cancel")}
                      </Button>
                    </>
                  )}
                </div>
                <JobBar job={j} />
                <span className={cn("break-words text-xs", j.result && !j.result.ok && !j.result.cancelled ? "text-prod" : "text-muted")}>
                  {j.result ? jobSummary(j, t, lang) : (j.progress?.message ?? t("jobs.waiting"))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
