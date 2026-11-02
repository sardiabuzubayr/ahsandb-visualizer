import { useState } from "react";
import { Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { useI18n } from "../../i18n";
import { api } from "../../lib/api";
import { providerName, useAiChoice, useAiKeys, useAiModels } from "../../lib/aiPrefs";
import { errorText } from "../../components/shell/useConnect";
import type { Connection } from "../../types";
import { Button, Checkbox, Dialog, DialogHeader } from "../../components/ui";
import { incompleteTables, type TableCoverage } from "./dictionary";

type Scope = "all" | "incomplete" | "pick";

/** Options for one "Learn schema" run: which tables, and whether sample rows may be read. */
export function LearnDialog(p: { conn: Connection; sid: string; schema: string; coverage: TableCoverage[]; onClose: () => void; onStarted: () => void }) {
  const { t, lang } = useI18n();
  const incomplete = incompleteTables(p.coverage);
  const [scope, setScope] = useState<Scope>(incomplete.length ? "incomplete" : "all");
  const [picked, setPicked] = useState<string[]>([]);
  const dataAccess = p.conn.aiAccess === "data";
  const [samples, setSamples] = useState(dataAccess);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const choice = useAiChoice();
  const keys = useAiKeys();
  const { models } = useAiModels(choice.provider, !!keys?.includes(choice.provider));
  const model = choice.model || models?.[0]?.id || "";

  const tables = scope === "all" ? p.coverage.map((c) => c.name) : scope === "incomplete" ? incomplete.map((c) => c.name) : picked;
  const count = (cs: TableCoverage[]) => t("learn.scopeCount", { tables: cs.length });

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      // "All" sends an empty list: the backend then also covers tables created since this tab loaded.
      await api.dictLearn(p.sid, p.schema, { tables: scope === "all" ? [] : tables, samples: samples && dataAccess, provider: choice.provider, model, language: lang });
      p.onStarted();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const radio = (value: Scope, label: string, extra?: string) => (
    <label className="flex h-[26px] items-center gap-2.5">
      <input type="radio" name="learn-scope" checked={scope === value} onChange={() => setScope(value)} className="m-0 accent-accent" />
      {label}
      {extra && <span className="text-faint">{extra}</span>}
    </label>
  );

  return (
    <Dialog open onClose={p.onClose} labelledBy="learn-title" className="max-w-[580px]">
      <DialogHeader id="learn-title" title={t("learn.title", { schema: p.schema })} onClose={p.onClose} />
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-auto px-5 py-4">
        <p className="m-0 leading-[19px] text-muted">{t("learn.body")}</p>

        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
          <legend className="mb-1.5 p-0 text-xs font-medium text-muted">{t("learn.scope")}</legend>
          {radio("all", t("learn.scope.all"), count(p.coverage))}
          {radio("incomplete", t("learn.scope.incomplete"), count(incomplete))}
          {radio("pick", t("learn.scope.pick"))}
          {scope === "pick" && (
            <div role="group" aria-label={t("learn.pickTables")} className="mt-1 ml-6 grid max-h-44 grid-cols-2 gap-x-4 gap-y-1 overflow-auto rounded-md border border-border p-2">
              {p.coverage.map((c) => (
                <span key={c.name} className="flex min-w-0 items-center gap-2">
                  <Checkbox
                    size={15}
                    label={c.name}
                    state={picked.includes(c.name) ? "on" : "off"}
                    onChange={() => setPicked((x) => (x.includes(c.name) ? x.filter((n) => n !== c.name) : [...x, c.name]))}
                  />
                  <span className="truncate font-mono text-xs">{c.name}</span>
                </span>
              ))}
            </div>
          )}
        </fieldset>

        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1.5 p-0 text-xs font-medium text-muted">{t("learn.reads")}</legend>
          <label className="flex items-start gap-2.5 text-muted">
            <input type="checkbox" checked disabled className="m-0 mt-[3px] accent-accent" />
            {t("learn.structure")}
          </label>
          <label className="flex items-start gap-2.5">
            <input type="checkbox" checked={samples && dataAccess} disabled={!dataAccess} onChange={() => setSamples((v) => !v)} className="m-0 mt-[3px] accent-accent" />
            <span className={dataAccess ? "" : "text-faint"}>
              {t("learn.samples")}
              {!dataAccess && <span className="block text-xs">{t("learn.samplesOff")}</span>}
            </span>
          </label>
          {samples && dataAccess && (
            <p className="m-0 mt-1 ml-6 flex gap-2 rounded-md bg-stg-bg px-2.5 py-2 text-xs leading-[18px] text-stg">
              <TriangleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span>
                {t("learn.samplesWarn")}
                {p.conn.env === "prod" && ` ${t("learn.samplesProd")}`}
              </span>
            </p>
          )}
        </fieldset>

        <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface px-3 py-2.5 text-xs leading-[18px] text-muted">
          <span>{t("learn.drafts")}</span>
          <span>{model ? t("learn.uses", { provider: providerName(choice.provider), model }) : t("learn.noModel")}</span>
        </div>
        {error && (
          <p role="alert" className="m-0 text-xs break-words text-prod">
            {error}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button variant="outline" size="lg" onClick={p.onClose}>
          {t("dict.cancel")}
        </Button>
        <Button variant="primary" size="lg" disabled={busy || !model || !tables.length} onClick={() => void start()}>
          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
          {t("learn.start")}
        </Button>
      </div>
    </Dialog>
  );
}
