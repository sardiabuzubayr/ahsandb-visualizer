import { useEffect, useState } from "react";
import { Check, FileText, FileUp } from "lucide-react";
import { useI18n } from "../../i18n";
import { api } from "../../lib/api";
import { onJobFinished, trackJob, useJob } from "../../lib/jobs";
import { scopedId } from "../../lib/scope";
import { errorText, useConnect } from "../../components/shell/useConnect";
import { useApp } from "../../state/app";
import { Button, Checkbox, Dialog, DialogHeader, EnvDot, Field, Input, Segmented, Switch, cn } from "../../components/ui";
import { Select } from "../../components/ui/Select";
import type { FileFormat, FilePreview, OnError, TableDef } from "../../types";
import { ImportJobView, ProdConfirm } from "./ImportJobView";
import {
  autoMap,
  baseName,
  buildImportOptions,
  canImport,
  checkMapping,
  formatOf,
  landedRows,
  mappingOf,
  newColumns,
  normName,
  pickFile,
  treeTables,
  type NewColumn,
} from "./importData";

const STEPS = ["file", "map", "import"] as const;
const DELIMS = { comma: ",", semicolon: ";", tab: "\t" } as const;
type Delim = keyof typeof DELIMS;
const ENCODINGS = ["UTF-8", "ISO-8859-1"];
const MAP_COLS = "grid grid-cols-[150px_minmax(170px,1fr)_28px_200px_120px_160px] items-center";
const MOCK_PATH = "~/Downloads/customers.csv";


export function ImportDialog() {
  const { t, lang } = useI18n();
  const { state, dispatch } = useApp();
  const { loadTree } = useConnect();
  const ctx = state.dialogContext ?? {};
  const conn = state.connections.find((c) => c.id === (state.editingConnectionId ?? state.activeConnectionId)) ?? state.connections[0];
  const sid = scopedId(conn.id, ctx.database);
  const prod = conn.env === "prod";

  const [step, setStep] = useState<1 | 2 | 3>(1);
  // Step 1: file + read options; every change re-inspects the file.
  const [path, setPath] = useState<string | null>(null);
  const [format, setFormat] = useState<FileFormat>("csv");
  const [delim, setDelim] = useState<Delim>("comma");
  const [header, setHeader] = useState(true);
  const [encoding, setEncoding] = useState("UTF-8");
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [inspectErr, setInspectErr] = useState<string | null>(null);
  // Step 2: target table (existing or new) + mapping.
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [picked, setPicked] = useState(ctx.table ? { schema: ctx.schema ?? "", table: ctx.table } : null);
  const [def, setDef] = useState<TableDef | null>(null);
  const [defErr, setDefErr] = useState<string | null>(null);
  const [targets, setTargets] = useState<(string | null)[]>([]);
  const [newTable, setNewTable] = useState<NewColumn[]>([]);
  const [newName, setNewName] = useState("");
  const [onError, setOnError] = useState<OnError>("stop");
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Step 3: the background job.
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const close = () => dispatch({ type: "closeDialog" });

  const file = { path: path ?? "", format, delimiter: DELIMS[delim], header, encoding };
  const fileName = path ? baseName(path) : "";
  const stem = fileName.replace(/\.[^.]*$/, "");

  useEffect(() => {
    if (!path) return;
    let live = true;
    setInspectErr(null);
    api
      .inspectImportFile(sid, file)
      .then((p) => {
        if (!live) return;
        setPreview(p);
        setNewTable(newColumns(p.columns, p.types));
      })
      .catch((e) => live && (setPreview(null), setInspectErr(errorText(e))));
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `file` is rebuilt from these each render
  }, [sid, path, format, delim, header, encoding]);

  const tree = state.trees[conn.id];
  const tables = tree?.status === "ready" ? treeTables(tree.nodes, ctx.database).filter((x) => !ctx.schema || x.schema === ctx.schema) : [];
  if (picked && !tables.some((x) => x.schema === picked.schema && x.table === picked.table)) tables.unshift(picked);
  // No table given: guess the one named like the file (customers.csv → customers).
  const target = picked ?? tables.find((x) => normName(x.table) === normName(stem)) ?? null;
  const schema = target?.schema ?? ctx.schema ?? tables[0]?.schema ?? "";
  const newMode = mode === "new";

  useEffect(() => {
    if (!target) return setDef(null);
    let live = true;
    setDef(null);
    setDefErr(null);
    api
      .loadTable(sid, target.schema, target.table)
      .then((d) => live && setDef(d))
      .catch((e) => live && setDefErr(errorText(e)));
    return () => void (live = false);
  }, [sid, target?.schema, target?.table]);

  useEffect(() => {
    if (preview && def) setTargets(autoMap(preview.columns, def.columns.map((c) => c.name)));
  }, [preview, def]);

  useEffect(() => {
    if (preview) setNewName((n) => n || stem.toLowerCase().replace(/[^a-z0-9_]+/g, "_"));
  }, [preview, stem]);

  const mapping = mappingOf(targets, newMode ? newTable : undefined);
  const check = checkMapping(mapping, newMode ? undefined : def?.columns, newMode ? { table: newName, columns: newTable } : undefined);
  const tableLabel = [schema, newMode ? newName.trim() : target?.table].filter(Boolean).join(".");
  const rows = (preview?.totalRows ?? 0).toLocaleString(lang);
  const ready = canImport(mapping, check) && (newMode || !!def) && (!prod || confirmed) && !conn.readOnly && !busy;

  const choose = async () => {
    try {
      const p = await pickFile("CSV / JSON", ["csv", "json", "txt"], MOCK_PATH);
      if (!p) return;
      setPath(p);
      setFormat(formatOf(p));
      setPreview(null);
      setNewName("");
    } catch (e) {
      setInspectErr(errorText(e));
    }
  };

  const start = async () => {
    setBusy(true);
    setStartErr(null);
    const options = buildImportOptions({ file, schema, table: newMode ? newName : (target?.table ?? ""), targets, newTable: newMode ? newTable : undefined, onError, emptyAsNull });
    try {
      const id = await api.importData(sid, options, prod && confirmed);
      trackJob(id, `Import ${fileName} → ${tableLabel}`, conn.id);
      // Registered here (not in an effect) so the tree still refreshes after the dialog is closed.
      if (newMode) {
        const off = onJobFinished((j) => {
          if (j.id !== id) return;
          off();
          if (j.result?.ok || j.result?.succeeded) void loadTree(conn.id);
        });
      }
      setJobId(id);
      setStep(3);
    } catch (e) {
      setStartErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const fileMeta = preview
    ? [
        t("import.rows", { n: rows }),
        encoding,
        ...(format === "csv" ? [t(`import.delim.${delim}`).toLowerCase(), ...(header ? [t("import.headerYes")] : [])] : ["JSON"]),
      ].join(" · ")
    : inspectErr
      ? null
      : t("import.inspecting");

  const fileCard = (onChange: () => void) => (
    <div className="flex flex-[1_1_360px] items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5">
      <FileText size={16} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[12.5px]" title={path ?? ""}>
          {fileName}
        </span>
        {fileMeta && <span className="block text-xs text-muted">{fileMeta}</span>}
        {inspectErr && (
          <span role="alert" className="block text-xs text-prod">
            {inspectErr}
          </span>
        )}
      </span>
      <Button variant="outline" size="sm" className="h-7" onClick={onChange}>
        {t("common.change")}
      </Button>
    </div>
  );

  const errors = [
    defErr && !newMode && defErr,
    check.duplicates.length > 0 && t("import.err.twice", { cols: check.duplicates.join(", ") }),
    check.blank && t("import.err.blank"),
    conn.readOnly && t("import.readOnly", { conn: conn.name }),
    startErr,
  ].filter((x): x is string => !!x);
  const dup = new Set(check.duplicates.map(normName));
  const mappedTargets = new Set(mapping.map((m) => normName(m.target)));
  const unmapped = newMode || !def ? [] : def.columns.filter((c) => !mappedTargets.has(normName(c.name)));
  const landed = preview ? landedRows(preview.rows, mapping, emptyAsNull) : [];
  const result = job?.result;

  return (
    <Dialog open onClose={close} labelledBy="imp-title" className="max-h-[min(820px,calc(100vh-60px))] max-w-[900px] open:flex open:flex-col">
      <DialogHeader id="imp-title" title={t("import.title")} onClose={close}>
        <ol aria-label={t("import.steps")} className="m-0 ml-1 flex list-none gap-1.5 p-0 text-[12.5px]">
          {STEPS.map((s, i) => {
            const n = i + 1;
            const done = n < step || (n === 3 && !!result?.ok);
            const current = n === step && !done;
            return (
              <li key={s} aria-current={current ? "step" : undefined} className={cn("flex items-center gap-1.5", current ? "font-medium" : "text-muted")}>
                <span
                  className={cn(
                    "grid size-[18px] place-items-center rounded-full text-[11px]",
                    done ? "bg-ok-bg text-ok" : current ? "bg-accent text-on-accent" : "border border-border-strong",
                  )}
                >
                  {done ? <Check size={10} strokeWidth={3} aria-hidden="true" /> : n}
                </span>
                {t(`import.step.${s}`)}
                {n < 3 && (
                  <span aria-hidden="true" className="mx-1 font-normal text-faint">
                    —
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </DialogHeader>

      <div className="flex min-h-0 flex-auto flex-col *:shrink-0 gap-4 overflow-auto px-5 py-[18px]">
        {step === 1 && (
          <>
            {path ? (
              <div className="flex">{fileCard(choose)}</div>
            ) : (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-10 text-center">
                <FileUp size={22} strokeWidth={1.8} className="text-muted" aria-hidden="true" />
                <div>
                  <div className="font-medium">{t("import.pickTitle")}</div>
                  <div className="mt-0.5 text-xs text-muted">{t("import.pickHint")}</div>
                </div>
                <Button variant="primary" size="lg" onClick={choose}>
                  {t("import.chooseFile")}
                </Button>
                {inspectErr && (
                  <span role="alert" className="text-xs text-prod">
                    {inspectErr}
                  </span>
                )}
              </div>
            )}
            <div className="grid grid-cols-[auto_1fr_1fr_1fr] items-end gap-3">
              <div>
                <div className="mb-1.5 text-xs text-muted">{t("import.format")}</div>
                <Segmented
                  label={t("import.format")}
                  value={format}
                  onChange={setFormat}
                  options={[
                    { value: "csv", label: "CSV" },
                    { value: "json", label: "JSON" },
                  ]}
                />
              </div>
              <Field label={t("import.delimiter")}>
                <Select value={delim} disabled={format === "json"} onChange={(e) => setDelim(e.target.value as Delim)}>
                  {Object.keys(DELIMS).map((d) => (
                    <option key={d} value={d}>
                      {t(`import.delim.${d}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("import.encoding")}>
                <Select value={encoding} onChange={(e) => setEncoding(e.target.value)}>
                  {ENCODINGS.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </Select>
              </Field>
              <div className={cn("flex h-[34px] items-center justify-between gap-2 rounded-[7px] border border-border bg-surface px-3", format === "json" && "opacity-50")}>
                <span className="truncate">{t("import.header")}</span>
                <Switch checked={header} onChange={(v) => format === "csv" && setHeader(v)} label={t("import.header")} />
              </div>
            </div>
          </>
        )}

        {step === 2 && !preview && <div className="flex">{fileCard(() => setStep(1))}</div>}
        {step === 2 && preview && (
          <>
            <div className="flex flex-wrap gap-2.5">
              {fileCard(() => setStep(1))}
              <div className="flex flex-[1_1_380px] flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="text-xs text-muted">{t("import.into")}</span>
                  <EnvDot env={conn.env} />
                  <span className="min-w-0 flex-1">
                    {newMode ? (
                      <Input
                        mono
                        className="h-[30px]"
                        aria-label={t("import.tableName")}
                        placeholder={t("import.tableName")}
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                      />
                    ) : (
                      <Select
                        compact
                        mono
                        aria-label={t("import.into")}
                        value={target ? tables.findIndex((x) => x.schema === target.schema && x.table === target.table) : ""}
                        onChange={(e) => setPicked(tables[Number(e.target.value)] ?? null)}
                      >
                        {!target && <option value="">{t(tables.length ? "import.chooseTable" : "import.noTables")}</option>}
                        {tables.map((x, i) => (
                          <option key={`${x.schema}.${x.table}`} value={i}>
                            {[x.schema, x.table].filter(Boolean).join(".")}
                          </option>
                        ))}
                      </Select>
                    )}
                  </span>
                  <span className="truncate text-xs text-muted">{conn.name}</span>
                </div>
                <Segmented
                  size="sm"
                  label={t("import.mode")}
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "existing", label: t("import.mode.existing") },
                    { value: "new", label: t("import.mode.new") },
                  ]}
                />
              </div>
            </div>

            <section aria-label={t("import.mapping")} className="overflow-x-auto rounded-lg border border-border">
              <div className="min-w-[770px]">
                <div className={cn(MAP_COLS, "h-8 border-b border-border-strong bg-panel text-xs text-muted [&>span]:px-3")}>
                  <span>{t("import.col.file")}</span>
                  <span>{t("import.col.sample")}</span>
                  <span />
                  <span>{t(newMode ? "import.col.newName" : "import.col.target")}</span>
                  <span>{t("import.col.type")}</span>
                  <span>{t("import.col.check")}</span>
                </div>
                {preview.columns.map((src, i) => {
                  const sample = preview.rows.map((r) => r[i]).find((v) => v !== null && v !== "");
                  const nc = newTable[i];
                  const tgt = newMode ? (nc?.include ? nc.name : null) : targets[i];
                  const twice = !!tgt && dup.has(normName(tgt));
                  const setNc = (p: Partial<NewColumn>) => setNewTable((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)));
                  return (
                    <div key={i} className={cn(MAP_COLS, "h-[42px] border-b border-border")}>
                      <span className="truncate px-3 font-medium" title={src}>
                        {src}
                      </span>
                      <span className="truncate px-3 font-mono text-xs text-muted" title={sample == null ? "" : String(sample)}>
                        {sample ?? "—"}
                      </span>
                      <span aria-hidden="true" className="text-center text-faint">
                        →
                      </span>
                      <span className="px-2">
                        {newMode ? (
                          <Input
                            mono
                            className="h-[30px]"
                            disabled={!nc?.include}
                            aria-label={t("import.targetFor", { col: src })}
                            value={nc?.name ?? ""}
                            onChange={(e) => setNc({ name: e.target.value })}
                          />
                        ) : (
                          <Select
                            compact
                            mono
                            aria-label={t("import.targetFor", { col: src })}
                            value={tgt ?? ""}
                            style={tgt ? undefined : { color: "var(--muted)" }}
                            onChange={(e) => setTargets((ts) => ts.map((x, j) => (j === i ? e.target.value || null : x)))}
                          >
                            {def?.columns.map((c) => (
                              <option key={c.name} value={c.name}>
                                {c.name}
                              </option>
                            ))}
                            <option value="">{t("import.skip")}</option>
                          </Select>
                        )}
                      </span>
                      <span className="min-w-0 px-2 font-mono text-[11.5px] text-faint">
                        {newMode ? (
                          <Input
                            mono
                            className="h-[30px] text-[11.5px]!"
                            disabled={!nc?.include}
                            aria-label={t("import.typeFor", { col: src })}
                            value={nc?.type ?? ""}
                            onChange={(e) => setNc({ type: e.target.value })}
                          />
                        ) : (
                          <span className="block truncate px-1">{(tgt && def?.columns.find((c) => c.name === tgt)?.type) || "—"}</span>
                        )}
                      </span>
                      <span className={cn("flex min-w-0 items-center gap-2 px-3 text-xs", twice ? "text-prod" : tgt ? "text-ok" : "text-faint")}>
                        {newMode && <Checkbox state={nc?.include ? "on" : "off"} size={16} onChange={() => setNc({ include: !nc?.include })} label={t("import.includeCol", { col: src })} />}
                        <span className="truncate">
                          {twice ? t("import.check.twice") : tgt ? `✓ ${t(newMode ? "import.check.new" : "import.check.matches")}` : t("import.check.skipped")}
                        </span>
                      </span>
                    </div>
                  );
                })}
                {unmapped.map((c) => {
                  const required = check.missingRequired.includes(c.name);
                  return (
                    <div key={c.name} className={cn("flex min-h-[38px] items-center gap-2 border-b border-border px-3 text-xs last:border-b-0", required ? "text-stg" : "text-muted")}>
                      <span className={cn("font-mono", !required && "text-text")}>{c.name}</span>
                      {required
                        ? t("import.unmapped.required")
                        : c.default != null || c.autoIncrement
                          ? t("import.unmapped.default")
                          : t("import.unmapped.null")}
                      {!required && (c.default != null || c.autoIncrement) && <span className="font-mono">{c.default ?? "auto-increment"}</span>}
                    </div>
                  );
                })}
              </div>
            </section>

            {errors.map((e) => (
              <p key={e} role="alert" className="m-0 rounded-lg bg-prod-bg px-3 py-2 text-xs whitespace-pre-wrap text-prod">
                {e}
              </p>
            ))}

            <div className="flex flex-wrap gap-4">
              <div className="flex flex-[1_1_360px] flex-col gap-3">
                <fieldset className="m-0 rounded-lg border border-border px-3.5 pt-1 pb-3">
                  <legend className="px-1.5 text-xs text-muted">{t("import.onError")}</legend>
                  {(["stop", "skip"] as const).map((p) => (
                    <label key={p} className="flex cursor-pointer items-start gap-2.5 py-1.5">
                      <input type="radio" name="onerror" checked={onError === p} onChange={() => setOnError(p)} className="mt-[3px] accent-accent" />
                      <span>
                        <span className="block font-medium">{t(`import.policy.${p}`)}</span>
                        <span className="block text-xs text-muted">{t(`import.policy.${p}.hint`)}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div className="flex h-[34px] items-center justify-between rounded-[7px] border border-border bg-surface px-3">
                  <span>{t("import.emptyNull")}</span>
                  <Switch checked={emptyAsNull} onChange={setEmptyAsNull} label={t("import.emptyNull")} />
                </div>
              </div>
              <section aria-label={t("import.previewLabel")} className="min-w-0 flex-[1_1_360px]">
                <div className="mb-1.5 text-xs text-muted">{t("import.preview", { n: landed.length })}</div>
                <div className="max-h-[188px] overflow-auto rounded-lg border border-border font-mono text-[11.5px]">
                  {mapping.length > 0 &&
                    [null, ...landed].map((row, r) => (
                      <div
                        key={r}
                        style={{ gridTemplateColumns: `repeat(${mapping.length}, minmax(90px, 1fr))` }}
                        className={cn(
                          "grid h-7 min-w-[420px] items-center [&>span]:truncate [&>span]:px-2.5",
                          r === 0 ? "sticky top-0 bg-panel text-muted" : "",
                          r < landed.length && "border-b border-border",
                        )}
                      >
                        {mapping.map((m, c) => {
                          if (!row) return <span key={c}>{m.target}</span>;
                          const v = row[c];
                          return v === null ? (
                            <span key={c} className="text-faint italic">
                              NULL
                            </span>
                          ) : (
                            <span key={c} title={String(v)}>
                              {v}
                            </span>
                          );
                        })}
                      </div>
                    ))}
                </div>
              </section>
            </div>
            {prod && <ProdConfirm conn={conn} checked={confirmed} onChange={setConfirmed} />}
          </>
        )}

        {step === 3 && (
          <ImportJobView job={job} unit="import" title={t("import.running", { file: fileName, table: tableLabel })} />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-border px-5 py-3.5">
        <span className="min-w-[220px] flex-1 text-[12.5px] text-muted">
          {step === 1 && t("import.background")}
          {step === 2 && t("import.summary", { mapped: mapping.length, skipped: (preview?.columns.length ?? 0) - mapping.length })}
          {step === 3 && !result && t("import.closeHint")}
        </span>
        {step === 1 && (
          <>
            <Button variant="ghost" size="lg" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="lg" className="font-semibold" disabled={!preview} onClick={() => setStep(2)}>
              {t("import.next")}
            </Button>
          </>
        )}
        {step === 2 && (
          <>
            <Button variant="outline" size="lg" onClick={() => setStep(1)}>
              {t("common.back")}
            </Button>
            <Button variant={prod ? "danger" : "primary"} size="lg" className="font-semibold" disabled={!ready} onClick={start}>
              {t("import.run", { n: rows })}
            </Button>
          </>
        )}
        {step === 3 &&
          (result ? (
            <Button variant="primary" size="lg" className="font-semibold" onClick={close}>
              {t("import.doneButton")}
            </Button>
          ) : (
            <>
              <Button variant="outline" size="lg" onClick={() => jobId && void api.cancelJob(jobId)}>
                {t("import.cancel")}
              </Button>
              <Button variant="ghost" size="lg" onClick={close}>
                {t("common.close")}
              </Button>
            </>
          ))}
      </div>
    </Dialog>
  );
}
