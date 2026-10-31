// Progress and summary of an import job, shared by ImportDialog (rows) and ImportSqlDialog (statements).
import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { useI18n } from "../../i18n";
import type { Job } from "../../lib/jobs";
import { Checkbox, EnvDot } from "../../components/ui";
import type { Connection } from "../../types";
import { formatBytes } from "../../components/shell/tree";

/** `unit` picks the strings: "import" counts rows, "importSql" counts statements. */
export function ImportJobView({ job, title, unit, detail }: { job?: Job; title: string; unit: "import" | "importSql"; detail?: boolean }) {
  const { t, lang } = useI18n();
  const n = (x: number) => x.toLocaleString(lang);
  const p = job?.progress;
  const r = job?.result;
  if (!r) {
    const pct = p?.total ? Math.round((p.done / p.total) * 100) : 0;
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <div className="font-medium">{title}</div>
        <div
          role="progressbar"
          aria-label={title}
          aria-valuenow={p?.total ? pct : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-2 w-full max-w-[420px] overflow-hidden rounded-full bg-raised"
        >
          <div className="h-full rounded-full bg-accent transition-[width] duration-100" style={{ width: `${pct}%` }} />
        </div>
        <div className="font-mono text-xs text-muted">
          {/* The import streams the file: progress is bytes read (compressed bytes for .gz). */}
          {p?.total ? t("import.progressBytes", { done: formatBytes(p.done), total: formatBytes(p.total), pct }) : t("import.starting")}
        </div>
        {detail && p?.message && <div className="max-w-full truncate font-mono text-xs text-faint">{p.message}</div>}
      </div>
    );
  }
  const Icon = r.cancelled ? CircleAlert : r.ok ? CircleCheck : CircleX;
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
      <Icon size={28} className={r.cancelled ? "text-stg" : r.ok ? "text-ok" : "text-prod"} aria-hidden="true" />
      <div role="status" className="text-[15px] font-semibold">
        {r.cancelled ? t("import.cancelled") : r.ok ? t(`${unit}.done`, { n: n(r.succeeded) }) : t("import.failed")}
      </div>
      <div className="text-muted">
        {[
          (r.cancelled || !r.ok) && t(`${unit}.succeeded`, { n: n(r.succeeded) }),
          r.failed > 0 && t(`${unit}.failedCount`, { n: n(r.failed) }),
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
      {!r.ok && !r.cancelled && r.message && (
        <p role="alert" className="m-0 max-w-full rounded-lg bg-prod-bg px-3 py-2 text-left text-xs whitespace-pre-wrap text-prod">
          {r.message}
        </p>
      )}
      {r.errors.length > 0 && (
        <section aria-label={t("import.errors")} className="w-full text-left">
          <div className="mb-1.5 text-xs text-muted">{t("import.errors")}</div>
          <ol className="m-0 max-h-[220px] list-none overflow-auto rounded-lg border border-border p-0 text-xs">
            {r.errors.map((e) => (
              <li key={e.index} className="flex gap-3 border-b border-border px-3 py-1.5 last:border-b-0">
                <span className="w-24 shrink-0 font-mono text-muted">{t(`${unit}.errorAt`, { n: e.index })}</span>
                <span className="min-w-0 break-words">{e.message}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

/** Production: explicit confirmation before an import may start (sent as confirmed=true). */
export function ProdConfirm({ conn, checked, onChange }: { conn: Connection; checked: boolean; onChange: (v: boolean) => void }) {
  const { t } = useI18n();
  const label = t("import.prodConfirm", { conn: conn.name });
  return (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-prod bg-prod-bg px-3 py-2.5 text-[12.5px]">
      <Checkbox state={checked ? "on" : "off"} onChange={() => onChange(!checked)} label={label} />
      <EnvDot env={conn.env} />
      <span>{label}</span>
    </label>
  );
}
