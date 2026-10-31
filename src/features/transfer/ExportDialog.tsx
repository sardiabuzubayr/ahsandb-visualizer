import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Download, Loader2 } from "lucide-react";
import { useI18n } from "../../i18n";
import { api } from "../../lib/api";
import { trackJob, useJob } from "../../lib/jobs";
import { scopedId } from "../../lib/scope";
import { useApp, useToast } from "../../state/app";
import { Button, Checkbox, Dialog, DialogHeader, EnvDot, Field, Input, Switch } from "../../components/ui";
import { Select } from "../../components/ui/Select";
import { errorText } from "../../components/shell/useConnect";
import { defaultSchema } from "../data/table";
import { databaseNodes } from "../editor/treeScope";
import { batchOf, dumpDbName, dumpFileName, dumpObjects, dumpSchemas, exportGroups, pickSavePath, schemaName, treeDatabase, withGz } from "./exportPlan";
import { JobFooter, JobView, OptionInput, OptionRow, RadioCards } from "./parts";
import { allKeys, estimate, groupState, itemKey, selectedIn, toggleGroup, toggleItem } from "./selection";

const CONTENT = ["both", "structure", "data"] as const;

export function ExportDialog() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const { state, dispatch } = useApp();
  const ctx = state.dialogContext ?? {};
  const conn = state.connections.find((c) => c.id === (state.editingConnectionId ?? state.activeConnectionId)) ?? state.connections[0];
  const sid = scopedId(conn.id, ctx.database);
  const treeDb = treeDatabase(conn, ctx.database);

  // Schemas (PG) / databases (MySQL) / main (SQLite) of the navigator tree; a lazy PG database loads here.
  const tree = state.trees[conn.id];
  const nodes = tree?.status === "ready" ? tree.nodes : [];
  const lazy = nodes.find((n) => n.kind === "database" && n.label === treeDb && n.lazy);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    if (!lazy) return;
    api.schemaTree(scopedId(conn.id, lazy.label)).then(
      ([node]) => dispatch({ type: "setDatabaseNode", id: conn.id, node }),
      (e: unknown) => setLoadError(errorText(e)),
    );
  }, [lazy?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const schemas = dumpSchemas(databaseNodes(nodes, treeDb));
  const [picked, setPicked] = useState(ctx.schema ?? defaultSchema(conn));
  const current = schemas.find((s) => schemaName(s) === picked) ?? schemas[0];
  const schema = current ? schemaName(current) : picked;

  const [rows, setRows] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!conn.connected || !schema) return;
    let live = true;
    api.erModel(sid, schema).then((m) => live && setRows(Object.fromEntries(m.tables.map((x) => [x.name, x.rows]))), () => {});
    return () => void (live = false);
  }, [sid, schema, conn.connected]);
  const groups = useMemo(() => exportGroups(current, rows), [current, rows]);

  const [content, setContent] = useState<(typeof CONTENT)[number]>("both");
  // null = everything (also once the tree arrives or the schema changes).
  const [picks, setSel] = useState<Set<string> | null>(null);
  const sel = picks ?? allKeys(groups);
  const [open, setOpen] = useState<Set<string>>(new Set(["tables"]));
  const [txn, setTxn] = useState(true);
  const [drop, setDrop] = useState(false);
  const [batch, setBatch] = useState("500");
  const [gz, setGz] = useState(false);
  // null = default name, following the schema until the user types or picks a path.
  const [typed, setPath] = useState<string | null>(null);
  const path = typed ?? `~/Downloads/${dumpFileName(dumpDbName(conn, treeDb), schema, new Date(), gz)}`;
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const close = () => dispatch({ type: "closeDialog" });

  const est = estimate(groups, sel);
  const rowText = est.rows >= 1000 ? `${(Math.floor(est.rows / 100) / 10).toLocaleString(lang)}k` : String(est.rows);
  const objects = t("export.objects", { tables: est.tables, others: est.others });
  const toggleOpen = (key: string) =>
    setOpen((s) => {
      const x = new Set(s);
      if (!x.delete(key)) x.add(key);
      return x;
    });
  const choose = async () => {
    try {
      const p = await pickSavePath(path, { name: "SQL", extensions: gz ? ["gz"] : ["sql"] });
      if (p) setPath(p);
    } catch (e) {
      toast(errorText(e));
    }
  };
  const start = async () => {
    try {
      const id = await api.exportDatabase(sid, {
        schema,
        objects: dumpObjects(groups, sel),
        content,
        transaction: txn,
        dropExisting: drop,
        batchSize: batchOf(batch),
        gzip: gz,
        path: path.trim(),
      });
      trackJob(id, t("export.jobTitle", { name: schema }), conn.id);
      setJobId(id);
    } catch (e) {
      toast(errorText(e));
    }
  };

  const loading = !loadError && (!!lazy || tree?.status === "loading");
  return (
    <Dialog open onClose={close} labelledBy="exp-title" className="max-h-[min(800px,calc(100vh-60px))] max-w-[760px] open:flex open:flex-col">
      <DialogHeader id="exp-title" title={t("export.title")} onClose={close}>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <EnvDot env={conn.env} />
          <span className="truncate">{[conn.name, treeDb].filter(Boolean).join(" · ")} ·</span>
          {schemas.length > 1 && !job ? (
            <Select
              compact
              mono
              aria-label={t("export.schema")}
              value={schema}
              onChange={(e) => (setPicked(e.target.value), setSel(null), setRows({}))}
            >
              {schemas.map((s) => (
                <option key={s.id} value={schemaName(s)}>
                  {schemaName(s)}
                </option>
              ))}
            </Select>
          ) : (
            <span className="truncate">{schema}</span>
          )}
        </span>
      </DialogHeader>

      {job ? (
        <>
          <div className="px-5 py-[18px]">
            <JobView job={job} name={schema} path={path} />
          </div>
          <JobFooter job={job} onClose={close} />
        </>
      ) : (
        <>
          <div className="flex min-h-0 flex-auto flex-col *:shrink-0 gap-[18px] overflow-auto px-5 py-[18px]">
            <RadioCards
              label={t("export.what")}
              value={content}
              onChange={setContent}
              options={CONTENT.map((c) => ({ value: c, title: t(`export.content.${c}`), hint: t(`export.content.${c}.hint`) }))}
            />

            <section aria-label={t("export.objectsLabel")}>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs text-muted">{t("export.objectsLabel")}</span>
                <span className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setSel(null)}>
                    {t("common.selectAll")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setSel(new Set())}>
                    {t("common.none")}
                  </Button>
                </span>
              </div>
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {loading && (
                  <div className="flex h-[34px] items-center gap-2 px-3 text-muted">
                    <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                    {t("export.loading")}
                  </div>
                )}
                {!loading && !groups.length && (
                  <div role={loadError ? "alert" : undefined} className="px-3 py-2.5 text-muted">
                    {loadError || t(conn.connected ? "export.noObjects" : "export.notConnected", { name: conn.name })}
                  </div>
                )}
                {groups.map((g) => {
                  const name = t(`export.group.${g.key}`);
                  const expanded = open.has(g.key);
                  return (
                    <div key={g.key} className="divide-y divide-border">
                      <div className="flex h-[34px] items-center gap-2.5 bg-surface px-3">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-label={name}
                          onClick={() => toggleOpen(g.key)}
                          className="grid size-4 place-items-center text-faint hover:text-text"
                        >
                          <ChevronDown size={11} aria-hidden="true" className={expanded ? "" : "-rotate-90"} />
                        </button>
                        <Checkbox size={16} label={name} state={groupState(g, sel)} onChange={() => setSel(toggleGroup(g, sel))} />
                        <span className="flex-1 font-medium">{name}</span>
                        <span className="font-mono text-[11.5px] text-muted">
                          {t("export.countOf", { n: selectedIn(g, sel), total: g.items.length })}
                        </span>
                      </div>
                      {expanded &&
                        g.items.map((i) => {
                          const k = itemKey(g.key, i.name);
                          return (
                            <div key={k} className="flex h-[34px] items-center gap-2.5 pr-3 pl-[46px]">
                              <Checkbox size={16} label={i.name} state={sel.has(k) ? "on" : "off"} onChange={() => setSel(toggleItem(k, sel))} />
                              <span className="flex-1 truncate font-mono text-[12.5px]" title={i.name}>
                                {i.name}
                              </span>
                              {i.meta && <span className="font-mono text-[11.5px] text-muted">{t("export.rows", { n: i.meta })}</span>}
                            </div>
                          );
                        })}
                    </div>
                  );
                })}
              </div>
            </section>

            <section aria-label={t("export.options")} className="grid grid-cols-2 gap-2">
              <OptionRow label={t("export.txn")}>
                <Switch checked={txn} onChange={setTxn} label={t("export.txn")} />
              </OptionRow>
              <OptionRow label={t("export.drop")}>
                <Switch checked={drop} onChange={setDrop} label={t("export.dropLabel")} />
              </OptionRow>
              <OptionInput label={t("export.batch")} value={batch} onChange={setBatch} numeric />
              <OptionRow
                label={
                  <>
                    {t("export.compress")} <span className="font-mono text-xs text-muted">.gz</span>
                  </>
                }
              >
                <Switch
                  checked={gz}
                  onChange={(on) => {
                    setGz(on);
                    if (typed !== null) setPath(withGz(typed, on));
                  }}
                  label={t("export.compressLabel")}
                />
              </OptionRow>
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
            <span className="min-w-[220px] flex-1 text-[12.5px] text-muted">
              {content === "structure" ? t("export.estimateNoRows", { objects }) : t("export.estimate", { rows: rowText, objects })}
            </span>
            <Button variant="ghost" size="lg" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="lg" className="font-semibold" disabled={sel.size === 0 || !path.trim() || !schema} onClick={() => void start()}>
              <Download size={13} aria-hidden="true" />
              {t("export.export")}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
