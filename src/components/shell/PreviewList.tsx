import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { useT, type TFn } from "../../i18n";
import { isApiError } from "../../lib/api";
import type { ApplyReport, Preview } from "../../types";
import { cn } from "../ui";

export type PreviewBadge = "transactional" | "notTransactional" | "destructive";

/** Badges shown above a preview's statements. */
export function previewBadges(p: Pick<Preview, "transactional" | "destructive">): PreviewBadge[] {
  return [p.transactional ? "transactional" : "notTransactional", ...(p.destructive ? (["destructive"] as const) : [])];
}

export interface ReportLine {
  tone: "ok" | "error" | "warn";
  key: string;
  vars?: Record<string, string | number>;
}

/** Outcome of applyPreview as i18n lines: success, or the failing statement plus what stayed applied. */
export function reportLines(r: ApplyReport): ReportLine[] {
  if (!r.failed) return [{ tone: "ok", key: "preview.applied", vars: { n: r.executed } }];
  const failed: ReportLine = { tone: "error", key: "preview.failed", vars: { n: r.failed.index + 1, message: r.failed.message } };
  if (r.rolledBack) return [failed, { tone: "warn", key: "preview.rolledBack" }];
  return [failed, r.executed > 0 ? { tone: "warn", key: "preview.partial", vars: { n: r.executed } } : { tone: "warn", key: "preview.nothingApplied" }];
}

/** True when part of the change stayed in the database (non-transactional DDL failed mid-way). */
export const partiallyApplied = (r: ApplyReport) => !!r.failed && !r.rolledBack && r.executed > 0;

/** Message for an error thrown by a preview or applyPreview call; an expired preview asks for a new review. */
export function previewErrorText(t: TFn, e: unknown): string {
  if (isApiError(e, "notFound")) return t("preview.expired");
  if (isApiError(e, "readOnly")) return t("preview.readOnly");
  return e instanceof Error ? e.message : String(e);
}

const TOKEN =
  /('(?:[^']|'')*')|\b(ADD|ALTER|AND|AS|AUTO_INCREMENT|AUTOINCREMENT|BEGIN|BY|CHANGE|CHECK|COLUMN|COMMIT|CONSTRAINT|CREATE|DEFAULT|DELETE|DROP|EXISTS|FOREIGN|FROM|GENERATED|IDENTITY|IF|INDEX|INSERT|INTO|KEY|MODIFY|NOT|NULL|ON|PRAGMA|PRIMARY|REFERENCES|RENAME|SET|TABLE|TO|TYPE|UNIQUE|UPDATE|USING|VALUES|VIEW|WHERE|ALWAYS|CASCADE|RESTRICT|ACTION|NO)\b|(\b\d+(?:\.\d+)?\b)/g;

function highlight(sql: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of sql.matchAll(TOKEN)) {
    out.push(sql.slice(last, m.index));
    out.push(
      <span key={m.index} className={m[1] ? "text-syn-str" : m[2] ? "text-syn-kw" : "text-syn-num"}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  out.push(sql.slice(last));
  return out;
}

const BADGE_STYLE: Record<PreviewBadge, string> = {
  transactional: "text-ok bg-ok-bg",
  notTransactional: "text-stg bg-stg-bg",
  destructive: "text-prod bg-prod-bg",
};
const TONE: Record<ReportLine["tone"], string> = { ok: "text-ok", error: "text-prod", warn: "text-stg" };

/** Statements from the backend, exactly as Apply will run them, with badges, warnings and the apply result. */
export function PreviewList({ preview, report }: { preview: Preview; report?: ApplyReport | null }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-1.5">
        {previewBadges(preview).map((b) => (
          <span key={b} className={cn("rounded px-1.5 py-px text-[11px] font-medium", BADGE_STYLE[b])}>
            {t(`preview.badge.${b}`)}
          </span>
        ))}
        <span className="text-[11px] leading-[18px] text-faint">{t("preview.count", { n: preview.statements.length })}</span>
      </div>
      {preview.warnings.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 rounded-lg bg-stg-bg px-3 py-2 text-xs text-stg">
          {preview.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2">
              <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words whitespace-pre-wrap">{w}</span>
            </li>
          ))}
        </ul>
      )}
      <pre
        aria-label={t("preview.statements")}
        className={cn(
          "m-0 overflow-auto rounded-lg border bg-bg px-3 py-2.5 font-mono text-[11.5px] leading-[19px] whitespace-pre-wrap",
          preview.destructive ? "border-prod" : "border-border",
        )}
      >
        {preview.statements.length === 0 && <span className="text-faint">{t("preview.empty")}</span>}
        {preview.statements.map((s, i) => (
          <div key={i} className={cn(i > 0 && "mt-2", report?.failed?.index === i && "-mx-1.5 rounded bg-prod-bg px-1.5")}>
            {highlight(s.trimEnd())}
            {!s.trimEnd().endsWith(";") && ";"}
          </div>
        ))}
      </pre>
      {report && (
        <div role="status" className="flex flex-col gap-1 rounded-lg border border-border bg-surface px-3 py-2 text-xs">
          {reportLines(report).map((l) => (
            <span key={l.key} className={cn("break-words", TONE[l.tone])}>
              {t(l.key, l.vars)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
