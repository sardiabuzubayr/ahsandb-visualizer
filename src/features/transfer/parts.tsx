// Building blocks shared by the export dialogs.
import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleSlash, Loader2 } from "lucide-react";
import { useI18n } from "../../i18n";
import { api } from "../../lib/api";
import type { Job } from "../../lib/jobs";
import { useToast } from "../../state/app";
import { Button, cn } from "../../components/ui";
import { JobBar } from "../../components/shell/JobsPopover";
import { jobProgressText } from "../../components/shell/jobsFormat";
import { errorText } from "../../components/shell/useConnect";

export function OptionRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-10 items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3">
      <span>{label}</span>
      {children}
    </div>
  );
}

/** Small right-aligned text input inside an OptionRow (rows per INSERT, table name). */
export function OptionInput({ label, value, onChange, numeric, wide }: { label: string; value: string; onChange: (v: string) => void; numeric?: boolean; wide?: boolean }) {
  return (
    <label className="flex h-10 items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3">
      <span>{label}</span>
      <input
        inputMode={numeric ? "numeric" : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "h-[26px] min-w-0 rounded-md border border-border-strong bg-bg px-2 text-right font-mono text-xs text-text outline-none focus:border-accent",
          wide ? "w-40" : "w-16",
        )}
      />
    </label>
  );
}

export function RadioCards<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; title: string; hint: string }[];
}) {
  return (
    <div>
      <div className="mb-1.5 text-xs text-muted">{label}</div>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-3 gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left",
              value === o.value ? "border-accent bg-accent-bg" : "border-border bg-surface hover:border-border-strong",
            )}
          >
            <span className="font-medium">{o.title}</span>
            <span className="text-xs text-muted">{o.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Dialog body while an export job runs, then its summary. */
export function JobView({ job, name, path }: { job: Job; name: string; path: string }) {
  const { t, lang } = useI18n();
  const r = job.result;
  const [Icon, color, title] = !r
    ? [Loader2, "animate-spin text-accent", t("export.running", { name })]
    : r.ok
      ? [CircleCheck, "text-ok", t("export.done")]
      : r.cancelled
        ? [CircleSlash, "text-muted", t("export.cancelled")]
        : [CircleAlert, "text-prod", t("export.failed")];
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <Icon size={16} className={cn("shrink-0", color)} aria-hidden="true" />
        <span className="flex-1 font-medium">{title}</span>
        {!r && <span className="font-mono text-xs text-muted">{jobProgressText(job, lang)}</span>}
      </div>
      <JobBar job={job} />
      <p className={cn("m-0 text-[12.5px] break-words", r && !r.ok && !r.cancelled ? "text-prod" : "text-muted")}>
        {!r
          ? (job.progress?.message ?? t("jobs.waiting"))
          : r.ok
            ? t("export.doneBody", { n: r.succeeded.toLocaleString(lang) })
            : r.cancelled
              ? t("export.cancelledBody")
              : r.message}
      </p>
      {r?.ok && <code className="block rounded-md bg-surface px-3 py-2 font-mono text-[12.5px] break-all">{path}</code>}
      {!r && <p className="m-0 text-xs text-faint">{t("export.background")}</p>}
    </div>
  );
}

/** Footer while a job runs (Cancel job / keep it running and close) or after it ended (Done). */
export function JobFooter({ job, onClose }: { job: Job; onClose: () => void }) {
  const t = useI18n().t;
  const toast = useToast();
  return (
    <div className="flex items-center justify-end gap-2.5 border-t border-border px-5 py-3.5">
      {!job.result && (
        <Button variant="ghost" size="lg" onClick={() => api.cancelJob(job.id).catch((e: unknown) => toast(errorText(e)))}>
          {t("export.cancelJob")}
        </Button>
      )}
      <Button variant="primary" size="lg" onClick={onClose}>
        {t(job.result ? "export.doneButton" : "export.hide")}
      </Button>
    </div>
  );
}
