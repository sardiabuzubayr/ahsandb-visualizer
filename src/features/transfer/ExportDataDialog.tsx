import { useState } from "react";
import { Download } from "lucide-react";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import { trackJob, useJob } from "../../lib/jobs";
import { scopedId } from "../../lib/scope";
import { useApp, useToast } from "../../state/app";
import type { DataFormat, DataSource } from "../../types";
import { Button, Dialog, DialogHeader, EnvDot, Field, Input, Switch } from "../../components/ui";
import { Select } from "../../components/ui/Select";
import { errorText } from "../../components/shell/useConnect";
import { defaultSchema } from "../data/table";
import { dataFileName, exportDataOptions, pickSavePath, withExt } from "./exportPlan";
import { JobFooter, JobView, OptionInput, OptionRow, RadioCards } from "./parts";

const FORMATS: DataFormat[] = ["csv", "json", "sql"];
const DELIMS = [
  ["comma", ","],
  ["semicolon", ";"],
  ["tab", "\t"],
  ["pipe", "|"],
] as const;

/** Export a table (data viewer, navigator) or a query (result grid) to CSV / JSON / SQL INSERT. */
export function ExportDataDialog() {
  const t = useT();
  const toast = useToast();
  const { state, dispatch } = useApp();
  const ctx = state.dialogContext ?? {};
  const conn = state.connections.find((c) => c.id === (state.editingConnectionId ?? state.activeConnectionId)) ?? state.connections[0];
  const sid = scopedId(conn.id, ctx.database);
  const schema = ctx.schema ?? defaultSchema(conn);
  const source: DataSource | null = ctx.sql ? { kind: "query", sql: ctx.sql } : ctx.table ? { kind: "table", schema, table: ctx.table } : null;
  const name = source?.kind === "table" ? source.table : "query";

  const [format, setFormat] = useState<DataFormat>("csv");
  const [delimiter, setDelimiter] = useState(",");
  const [header, setHeader] = useState(true);
  const [batch, setBatch] = useState("500");
  const [tableName, setTableName] = useState(ctx.table ?? "");
  const [path, setPath] = useState(() => `~/Downloads/${dataFileName(name, "csv")}`);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const close = () => dispatch({ type: "closeDialog" });

  const pickFormat = (f: DataFormat) => {
    setFormat(f);
    setPath((p) => withExt(p, f));
  };
  const choose = async () => {
    try {
      const p = await pickSavePath(path, { name: format.toUpperCase(), extensions: [format] });
      if (p) setPath(p);
    } catch (e) {
      toast(errorText(e));
    }
  };
  const start = async () => {
    if (!source) return;
    try {
      const id = await api.exportData(sid, exportDataOptions(source, format, path.trim(), { delimiter, header, batch, tableName }));
      trackJob(id, t("export.jobTitle", { name }), conn.id);
      setJobId(id);
    } catch (e) {
      toast(errorText(e));
    }
  };

  const where = [conn.name, ctx.database, source?.kind === "table" ? `${schema}.${source.table}` : t("exportData.query")];
  return (
    <Dialog open onClose={close} labelledBy="expdata-title" className="max-h-[min(720px,calc(100vh-60px))] max-w-[620px] open:flex open:flex-col">
      <DialogHeader id="expdata-title" title={t("exportData.title")} onClose={close}>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <EnvDot env={conn.env} />
          <span className="truncate">{where.filter(Boolean).join(" · ")}</span>
        </span>
      </DialogHeader>

      {job ? (
        <>
          <div className="px-5 py-[18px]">
            <JobView job={job} name={name} path={path} />
          </div>
          <JobFooter job={job} onClose={close} />
        </>
      ) : (
        <>
          <div className="flex min-h-0 flex-auto flex-col *:shrink-0 gap-[18px] overflow-auto px-5 py-[18px]">
            {source?.kind === "query" && (
              <Field label={t("exportData.query")} hint={t("exportData.queryHint")}>
                <pre className="m-0 max-h-24 overflow-auto rounded-[7px] border border-border bg-surface px-2.5 py-2 font-mono text-[12px] whitespace-pre-wrap">
                  {source.sql}
                </pre>
              </Field>
            )}
            {!source && (
              <p role="alert" className="m-0 text-muted">
                {t("exportData.noSource")}
              </p>
            )}

            <RadioCards
              label={t("exportData.format")}
              value={format}
              onChange={pickFormat}
              options={FORMATS.map((f) => ({ value: f, title: t(`exportData.format.${f}`), hint: t(`exportData.format.${f}.hint`) }))}
            />

            <section aria-label={t("export.options")} className="grid grid-cols-2 gap-2">
              {format === "csv" && (
                <>
                  <OptionRow label={t("exportData.delimiter")}>
                    <Select compact aria-label={t("exportData.delimiter")} value={delimiter} onChange={(e) => setDelimiter(e.target.value)} className="w-36">
                      {DELIMS.map(([k, v]) => (
                        <option key={k} value={v}>
                          {t(`exportData.delim.${k}`)}
                        </option>
                      ))}
                    </Select>
                  </OptionRow>
                  <OptionRow label={t("exportData.header")}>
                    <Switch checked={header} onChange={setHeader} label={t("exportData.header")} />
                  </OptionRow>
                </>
              )}
              {format === "sql" && (
                <>
                  <OptionInput label={t("export.batch")} value={batch} onChange={setBatch} numeric />
                  <OptionInput label={t("exportData.tableName")} value={tableName} onChange={setTableName} wide />
                </>
              )}
              {format === "json" && <p className="col-span-2 m-0 text-[12.5px] text-muted">{t("exportData.jsonHint")}</p>}
            </section>

            <Field label={t("export.saveTo")}>
              <span className="flex gap-2">
                <Input mono value={path} onChange={(e) => setPath(e.target.value)} />
                <Button size="lg" className="h-[34px]" onClick={() => void choose()}>
                  {t("common.choose")}
                </Button>
              </span>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 border-t border-border px-5 py-3.5">
            <span className="min-w-[200px] flex-1 text-[12.5px] text-muted">{t("exportData.background")}</span>
            <Button variant="ghost" size="lg" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="lg" className="font-semibold" disabled={!source || !path.trim()} onClick={() => void start()}>
              <Download size={13} aria-hidden="true" />
              {t("export.export")}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
