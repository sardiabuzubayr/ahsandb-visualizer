import { useEffect, useState, type ReactNode } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import { useApp, useConnection, useTabDirty, useToast } from "../../state/app";
import type { ApplyReport, ColumnDef, ForeignKeyDef, IndexDef, Preview, SchemaNode, Tab, TableDef } from "../../types";
import { Button, Checkbox, Field, IconButton, Input, cn } from "../../components/ui";
import { PreviewList, partiallyApplied, previewErrorText } from "../../components/shell/PreviewList";
import { useConnect } from "../../components/shell/useConnect";
import { splitTarget } from "../data/table";
import { databaseNodes } from "../editor/treeScope";
import { scopedId } from "../../lib/scope";
import {
  NEW_PREFIX,
  ON_DELETE,
  TYPE_SUGGESTIONS,
  newColumn,
  newTableDef,
  normalize,
  parseList,
  removeColumn,
  renameColumn,
  sameDef,
  schemaChange,
  togglePk,
  validate,
} from "./form";

const CELL_INPUT =
  "h-7 w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 font-mono text-[12.5px] outline-none hover:border-border focus:border-accent";
const SELECT = "h-7 w-full rounded-md border border-border bg-surface px-1.5 font-mono text-xs outline-none focus:border-accent";
const COLS = "grid-cols-[minmax(140px,1.2fr)_minmax(130px,1fr)_52px_minmax(110px,1fr)_70px_44px_40px]";
const FKS = "grid-cols-[minmax(120px,1fr)_minmax(130px,1fr)_minmax(120px,1fr)_130px_40px]";
const IDXS = "grid-cols-[minmax(140px,1fr)_minmax(160px,1.4fr)_64px_40px]";

const tablesOf = (nodes: SchemaNode[]): string[] =>
  nodes.flatMap((n) => [...(n.kind === "table" ? [n.label] : []), ...tablesOf(n.children ?? [])]);

/** Comma list committed on blur (re-mounts when the value changes elsewhere, e.g. a column rename). */
function ListInput({ value, onChange, label }: { value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <input
      key={value.join(",")}
      defaultValue={value.join(", ")}
      aria-label={label}
      title={label}
      onBlur={(e) => onChange(parseList(e.currentTarget.value))}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className={CELL_INPUT}
    />
  );
}

function Section({ title, hint, head, onAdd, addLabel, empty, children }: {
  title: string;
  hint?: string;
  head: ReactNode;
  onAdd: () => void;
  addLabel: string;
  empty?: string;
  children: ReactNode[];
}) {
  return (
    <section aria-label={title}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="m-0 text-[13px] font-semibold">{title}</h2>
        {hint && <span className="text-xs text-faint">{hint}</span>}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <div className="min-w-[640px]">
          {head}
          {children.length ? children : <p className="m-0 border-b border-border px-3 py-2 text-xs text-faint">{empty}</p>}
          <button type="button" onClick={onAdd} className="flex h-[34px] w-full items-center gap-1.5 px-3 text-left text-muted hover:text-text">
            <Plus size={12} aria-hidden="true" />
            {addLabel}
          </button>
        </div>
      </div>
    </section>
  );
}

const Head = ({ grid, labels }: { grid: string; labels: string[] }) => (
  <div className={cn("grid h-[30px] items-center border-b border-border bg-panel text-xs text-muted", grid)}>
    {labels.map((l, i) => (
      <span key={i} className="truncate px-3">
        {l}
      </span>
    ))}
  </div>
);

export function TableDesignerTab({ tab }: { tab: Tab }) {
  const t = useT();
  const toast = useToast();
  const { state, dispatch } = useApp();
  const { loadTree } = useConnect();
  const conn = useConnection(tab.connectionId);
  const sid = scopedId(conn.id, tab.database);
  const { schema, table } = splitTarget(tab.target ?? "", conn);
  const isNew = table.startsWith(NEW_PREFIX);
  /** The table as it is in the database; null until a new table exists. */
  const [original, setOriginal] = useState<TableDef | null>(null);
  const [form, setForm] = useState<TableDef>(() => newTableDef(schema, conn.driver));
  const [status, setStatus] = useState<"loading" | "ready" | "error">(isNew ? "ready" : "loading");
  const [loadError, setLoadError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [report, setReport] = useState<ApplyReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const base = original ?? newTableDef(schema, conn.driver);
  const dirty = !sameDef(form, base);
  useTabDirty(tab.id, dirty);

  const load = async () => {
    setStatus("loading");
    try {
      const def = await api.loadTable(sid, schema, table);
      setOriginal(def);
      setForm(def);
      setStatus("ready");
    } catch (e) {
      setLoadError(previewErrorText(t, e));
      setStatus("error");
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void (!isNew && load()), [sid, conn.connected, schema, table]);
  // Any edit makes the reviewed SQL stale.
  useEffect(() => {
    setPreview(null);
    setReport(null);
    setError("");
  }, [form]);

  const tree = state.trees[conn.id];
  const refTables = tree?.status === "ready" ? [...new Set(tablesOf(databaseNodes(tree.nodes, tab.database)))] : [];
  const problems = validate(form);
  const prod = conn.env === "prod";
  const unchanged = !dirty && !!original;
  // Action-bar note and whether it is an alert (red).
  const [note, alert] = conn.readOnly
    ? [t("designer.readOnly"), false]
    : problems.length
      ? [t(problems[0].key, problems[0].vars), true]
      : unchanged
        ? [t("designer.noChanges"), false]
        : [prod ? t("designer.prodNote") : "", prod];
  const canApply = !!preview && !report;
  const listId = `${tab.id}-types`;
  const tablesId = `${tab.id}-tables`;

  const set = (patch: Partial<TableDef>) => setForm((f) => ({ ...f, ...patch }));
  const setCol = (i: number, patch: Partial<ColumnDef>) => set({ columns: form.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const setFk = (i: number, patch: Partial<ForeignKeyDef>) => set({ foreignKeys: form.foreignKeys.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const setIdx = (i: number, patch: Partial<IndexDef>) => set({ indexes: form.indexes.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  const review = async () => {
    setBusy(true);
    setReport(null);
    setError("");
    try {
      setPreview(await api.previewSchemaChanges(sid, [schemaChange(original, form)]));
    } catch (e) {
      setError(previewErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    const target = normalize(form);
    try {
      const r = await api.applyPreview(sid, preview.id, true);
      if (r.failed) {
        setReport(r);
        if (partiallyApplied(r)) {
          // Part of the DDL committed (MySQL/MariaDB): refresh metadata and diff the rest against what exists now.
          void loadTree(conn.id);
          api.loadTable(sid, schema, target.name).then(setOriginal, () => {});
        }
        return;
      }
      toast(t("designer.applied", { name: target.name }));
      void loadTree(conn.id);
      if (isNew || target.name !== table) {
        // The tab's target names the old (or no) table: reopen the designer on the table as it now exists.
        dispatch({ type: "closeTab", id: tab.id, force: true });
        dispatch({ type: "openTab", kind: "designer", connectionId: conn.id, title: `${target.name} · design`, target: `${schema}.${target.name}`, database: tab.database });
      } else void load();
    } catch (e) {
      setPreview(null);
      setError(previewErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  if (status !== "ready")
    return (
      <div className="grid flex-1 place-items-center p-6 text-center">
        {status === "loading" ? (
          <p role="status" className="m-0 flex items-center gap-2 text-muted">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            {t("designer.loading")}
          </p>
        ) : (
          <div role="alert" className="flex flex-col items-center gap-3">
            <p className="m-0 max-w-[520px] break-words text-prod">{loadError}</p>
            <Button onClick={() => void load()}>{t("designer.retry")}</Button>
          </div>
        )}
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1">
      <main aria-label={t("designer.label")} className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto px-6 py-5">
          <div className="flex flex-wrap items-end gap-4">
            <Field label={t("designer.schema")} className="flex-[0_1_200px]">
              <Input mono value={schema} disabled className="text-muted" />
            </Field>
            <Field label={t("designer.tableName")} className="flex-[1_1_260px]">
              <Input mono value={form.name} placeholder="new_table" onChange={(e) => set({ name: e.target.value })} />
            </Field>
            {!original && (
              <span className="mb-2 rounded bg-ok-bg px-1.5 py-px text-[11px] font-medium text-ok">{t("designer.newBadge")}</span>
            )}
          </div>

          <datalist id={listId}>
            {TYPE_SUGGESTIONS[conn.driver].map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
          <datalist id={tablesId}>
            {refTables.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>

          <Section
            title={t("designer.columns")}
            hint={t("designer.columnsHint")}
            head={<Head grid={COLS} labels={["designer.col.name", "designer.col.type", "designer.col.nullable", "designer.col.default", "designer.col.autoInc", "designer.col.pk", ""].map((k) => (k ? t(k) : ""))} />}
            onAdd={() => set({ columns: [...form.columns, newColumn(form.columns.length + 1, conn.driver)] })}
            addLabel={t("designer.addColumn")}
          >
            {form.columns.map((c, i) => {
              const name = c.name || String(i + 1);
              const pk = form.primaryKey.includes(c.name);
              return (
                <div key={i} className={cn("grid h-[38px] items-center border-b border-border", COLS)}>
                  <span className="px-1.5">
                    <input value={c.name} aria-label={t("designer.nameOf", { n: i + 1 })} onChange={(e) => setForm(renameColumn(form, i, e.target.value))} className={CELL_INPUT} />
                  </span>
                  <span className="px-1.5">
                    <input value={c.type} list={listId} aria-label={t("designer.typeOf", { name })} onChange={(e) => setCol(i, { type: e.target.value })} className={cn(CELL_INPUT, "text-muted")} />
                  </span>
                  <span className="grid place-items-center">
                    <Checkbox state={c.nullable ? "on" : "off"} label={t("designer.nullableOf", { name })} onChange={() => !pk && setCol(i, { nullable: !c.nullable })} />
                  </span>
                  <span className="px-1.5">
                    <input value={c.default ?? ""} placeholder="—" aria-label={t("designer.defaultOf", { name })} onChange={(e) => setCol(i, { default: e.target.value })} className={CELL_INPUT} />
                  </span>
                  <span className="grid place-items-center">
                    <Checkbox state={c.autoIncrement ? "on" : "off"} label={t("designer.autoIncOf", { name })} onChange={() => setCol(i, { autoIncrement: !c.autoIncrement })} />
                  </span>
                  <span className="grid place-items-center">
                    <Checkbox state={pk ? "on" : "off"} label={t("designer.pkOf", { name })} onChange={() => setForm(togglePk(form, c.name))} />
                  </span>
                  <IconButton label={t("designer.removeColumn", { name })} size={28} onClick={() => setForm(removeColumn(form, i))} className="text-faint">
                    <X size={12} />
                  </IconButton>
                </div>
              );
            })}
          </Section>

          <Section
            title={t("designer.fks")}
            hint={t("designer.listHint")}
            head={<Head grid={FKS} labels={[t("designer.fk.columns"), t("designer.fk.refTable"), t("designer.fk.refColumns"), t("designer.fk.onDelete"), ""]} />}
            onAdd={() => set({ foreignKeys: [...form.foreignKeys, { columns: [], refTable: "", refColumns: [] }] })}
            addLabel={t("designer.addFk")}
            empty={t("designer.noFks")}
          >
            {form.foreignKeys.map((f, i) => (
              <div key={i} className={cn("grid h-[38px] items-center border-b border-border", FKS)}>
                <span className="px-1.5">
                  <ListInput value={f.columns} label={`${t("designer.fk.columns")} ${i + 1}`} onChange={(columns) => setFk(i, { columns })} />
                </span>
                <span className="px-1.5">
                  <input value={f.refTable} list={tablesId} aria-label={`${t("designer.fk.refTable")} ${i + 1}`} onChange={(e) => setFk(i, { refTable: e.target.value })} className={CELL_INPUT} />
                </span>
                <span className="px-1.5">
                  <ListInput value={f.refColumns} label={`${t("designer.fk.refColumns")} ${i + 1}`} onChange={(refColumns) => setFk(i, { refColumns })} />
                </span>
                <span className="px-1.5">
                  <select value={f.onDelete ?? ""} aria-label={`${t("designer.fk.onDelete")} ${i + 1}`} onChange={(e) => setFk(i, { onDelete: e.target.value || undefined })} className={SELECT}>
                    <option value="">—</option>
                    {ON_DELETE.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </span>
                <IconButton label={t("designer.removeFk", { n: i + 1 })} size={28} onClick={() => set({ foreignKeys: form.foreignKeys.filter((_, j) => j !== i) })} className="text-faint">
                  <X size={12} />
                </IconButton>
              </div>
            ))}
          </Section>

          <Section
            title={t("designer.indexes")}
            hint={t("designer.listHint")}
            head={<Head grid={IDXS} labels={[t("designer.idx.name"), t("designer.idx.columns"), t("designer.idx.unique"), ""]} />}
            onAdd={() => set({ indexes: [...form.indexes, { name: `${form.name.trim() || "table"}_idx_${form.indexes.length + 1}`, columns: [], unique: false }] })}
            addLabel={t("designer.addIndex")}
            empty={t("designer.noIndexes")}
          >
            {form.indexes.map((x, i) => (
              <div key={i} className={cn("grid h-[38px] items-center border-b border-border", IDXS)}>
                <span className="px-1.5">
                  <input value={x.name} aria-label={`${t("designer.idx.name")} ${i + 1}`} onChange={(e) => setIdx(i, { name: e.target.value })} className={CELL_INPUT} />
                </span>
                <span className="px-1.5">
                  <ListInput value={x.columns} label={`${t("designer.idx.columns")} ${x.name}`} onChange={(columns) => setIdx(i, { columns })} />
                </span>
                <span className="grid place-items-center">
                  <Checkbox state={x.unique ? "on" : "off"} label={`${t("designer.idx.unique")} ${x.name}`} onChange={() => setIdx(i, { unique: !x.unique })} />
                </span>
                <IconButton label={t("designer.removeIndex", { name: x.name })} size={28} onClick={() => set({ indexes: form.indexes.filter((_, j) => j !== i) })} className="text-faint">
                  <X size={12} />
                </IconButton>
              </div>
            ))}
          </Section>

          <Section
            title={t("designer.checks")}
            head={<Head grid="grid-cols-[1fr_40px]" labels={[t("designer.check.expression"), ""]} />}
            onAdd={() => set({ checks: [...form.checks, { expression: "" }] })}
            addLabel={t("designer.addCheck")}
            empty={t("designer.noChecks")}
          >
            {form.checks.map((c, i) => (
              <div key={i} className="grid h-[38px] grid-cols-[1fr_40px] items-center border-b border-border">
                <span className="px-1.5">
                  <input
                    value={c.expression}
                    placeholder="total >= 0"
                    aria-label={`${t("designer.check.expression")} ${i + 1}`}
                    onChange={(e) => set({ checks: form.checks.map((x, j) => (j === i ? { ...x, expression: e.target.value } : x)) })}
                    className={CELL_INPUT}
                  />
                </span>
                <IconButton label={t("designer.removeCheck", { n: i + 1 })} size={28} onClick={() => set({ checks: form.checks.filter((_, j) => j !== i) })} className="text-faint">
                  <X size={12} />
                </IconButton>
              </div>
            ))}
          </Section>
        </div>

        <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2.5 border-t border-border bg-panel px-6 py-2.5">
          <span className={cn("min-w-[240px] flex-1 text-xs", alert ? "text-prod" : "text-muted")}>{note}</span>
          <Button variant="ghost" size="lg" disabled={busy} onClick={() => (original ? void load() : setForm(base))}>
            {t("common.discard")}
          </Button>
          <Button size="lg" disabled={busy || conn.readOnly || problems.length > 0 || unchanged} onClick={() => void review()}>
            {busy && !preview ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : null}
            {t(report ? "designer.reviewAgain" : "designer.review")}
          </Button>
          <Button variant={prod ? "danger" : "primary"} size="lg" className="font-semibold" disabled={busy || !canApply || conn.readOnly} onClick={() => void apply()}>
            {t("designer.apply")}
          </Button>
        </div>
      </main>

      {(preview || error) && (
        <aside aria-label={t("designer.sqlPreview")} className="flex w-[400px] shrink-0 flex-col gap-3 overflow-auto border-l border-border bg-panel p-4">
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-sm font-semibold">{t("designer.sqlPreview")}</h2>
            <IconButton label={t("designer.closePreview")} onClick={() => (setPreview(null), setReport(null), setError(""))}>
              <X size={14} />
            </IconButton>
          </div>
          {preview && <PreviewList preview={preview} report={report} />}
          {error && (
            <p role="alert" className="m-0 text-xs break-words text-prod">
              {error}
            </p>
          )}
        </aside>
      )}
    </div>
  );
}
