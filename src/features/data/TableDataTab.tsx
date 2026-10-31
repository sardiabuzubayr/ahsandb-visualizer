import { useEffect, useReducer, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpRight, Download, ListFilter, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useT } from "../../i18n";
import { api, isApiError } from "../../lib/api";
import { useApp, useConnection, useTabDirty, useToast } from "../../state/app";
import type { Cell, Column, ForeignKeyDef, OrderBy, Tab, TablePage } from "../../types";
import { Button, IconButton, cn } from "../../components/ui";
import { colWidth } from "../editor/ResultGrid";
import { ResizeHandle, gridKey, useColumnWidths } from "../editor/columnWidths";
import { formatCell } from "../editor/format";
import { useConnectionError } from "../../components/shell/connectionError";
import { scopedId } from "../../lib/scope";
import { firstDatabase } from "../editor/treeScope";
import { PendingChangesPanel } from "./PendingChangesPanel";
import { pendingReducer, rowKeyOf } from "./pending";
import { followForeignKey, nextSort, splitTarget } from "./table";

const PAGE = 200;
const isBinary = (c: Column) => /bytea|blob|binary/i.test(c.type);
const errText = (e: unknown) => (isApiError(e) ? e.message : String(e));

const parse = (text: string, prev: Cell, col: Column): Cell =>
  (typeof prev === "number" || (prev === null && col.numeric)) && /^-?\d+$/.test(text) ? Number(text) : text;


export function TableDataTab({ tab }: { tab: Tab }) {
  const t = useT();
  const toast = useToast();
  const conn = useConnection(tab.connectionId);
  const app = useApp();
  const sid = scopedId(conn.id, tab.database);
  const { schema, table } = splitTarget(tab.target ?? "", conn);
  const [sort, setSort] = useState<OrderBy | null>(null);
  const [page, setPage] = useState<TablePage>({ columns: [], rows: [], hasMore: false });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [keyColumns, setKeyColumns] = useState<Column[]>([]);
  // Editing waits until we know the PK (table_page may not flag it; table_columns does).
  const [keysKnown, setKeysKnown] = useState(false);
  const req = useRef(0);
  const loadingMore = useRef(false);
  const [changes, dispatch] = useReducer(pendingReducer, []);
  const [filter, setFilter] = useState<string | null>(tab.filter ?? null);
  const [filterDraft, setFilterDraft] = useState<string | null>(null); // non-null = the filter input is open
  const [fks, setFks] = useState<ForeignKeyDef[]>([]);
  const [editing, setEditing] = useState<{ key: string; col: string } | null>(null);
  const seq = useRef(changes.length + 1);
  const nullBtn = useRef<HTMLButtonElement>(null);
  const markLost = useConnectionError();
  useTabDirty(tab.id, changes.length > 0);

  const load = async (orderBy: OrderBy | null, offset: number, where = filter) => {
    const n = ++req.current;
    if (offset === 0) setStatus("loading");
    try {
      const p = await api.tablePage(sid, schema, table, orderBy, where, offset, PAGE);
      if (n !== req.current) return;
      setPage((prev) => (offset === 0 ? p : { ...p, rows: [...prev.rows, ...p.rows] }));
      setStatus("ready");
    } catch (e) {
      if (n !== req.current) return;
      markLost(conn.id, e);
      if (offset > 0) toast(errText(e));
      else (setError(errText(e)), setStatus("error"));
    } finally {
      if (n === req.current) loadingMore.current = false;
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(sort, 0), [sid, conn.connected, schema, table, sort, filter]);
  // Foreign keys, so FK cells can jump to the row they reference.
  useEffect(() => {
    if (!conn.connected) return;
    api.loadTable(sid, schema, table).then((d) => setFks(d.foreignKeys), () => setFks([]));
  }, [sid, conn.connected, schema, table]);
  // table_page may not flag keys; table_columns does, and tells us the PK for row keys.
  useEffect(() => {
    if (!conn.connected) return;
    api.tableColumns(sid, schema, table).then((c) => (setKeyColumns(c), setKeysKnown(true)), () => {});
  }, [sid, conn.connected, schema, table]);

  const columns = page.columns.map((c) => {
    const k = keyColumns.find((x) => x.name === c.name);
    return k ? { ...c, pk: c.pk || k.pk, fk: c.fk || k.fk } : c;
  });
  const colWidths = useColumnWidths(gridKey(conn.id, tab.database ?? "", schema, table), columns, colWidth);
  const rows = page.rows;
  const pkIdxs = columns.flatMap((c, i) => (c.pk ? [i] : []));
  const rowKey = (row: Cell[], i: number) => rowKeyOf(row, pkIdxs, i);
  const canEdit = keysKnown && pkIdxs.length > 0;
  const deleted = new Set(changes.flatMap((c) => (c.kind === "delete" ? [c.rowKey] : [])));
  const edited = new Map<string, Cell>(changes.flatMap((c) => (c.kind === "update" ? [[`${c.rowKey}/${c.column}`, c.to] as const] : [])));
  const inserts = changes.flatMap((c) => (c.kind === "insert" ? [c] : []));
  const db = tab.database ?? firstDatabase(conn.database) ?? conn.file ?? "";
  const onScroll = (el: HTMLDivElement) => {
    if (!page.hasMore || status !== "ready" || loadingMore.current) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 400) return;
    loadingMore.current = true;
    void load(sort, rows.length);
  };
  const fkOf = (column: string) => fks.find((f) => f.columns.includes(column));
  const openReferenced = (fk: ForeignKeyDef, row: Cell[]) => {
    const to = followForeignKey(conn.driver, fk, schema, page.columns.map((c) => c.name), row);
    if (to) app.dispatch({ type: "openTab", kind: "table", connectionId: conn.id, title: to.table, target: to.target, database: tab.database, filter: to.filter });
  };
  const applyFilter = () => {
    const f = filterDraft?.trim() ?? "";
    setFilterDraft(null);
    setFilter(f || null);
  };

  const commit = (key: string, col: Column, original: Cell, text: string, shown: string) => {
    setEditing(null);
    // Leaving the editor untouched is not an edit (keeps NULL as NULL and DEFAULT as DEFAULT).
    if (text !== shown) dispatch({ type: "edit", key, column: col.name, from: original, to: parse(text, original, col) });
  };
  const setNull = (key: string, col: Column, original: Cell) => {
    setEditing(null);
    dispatch({ type: "edit", key, column: col.name, from: original, to: null });
  };

  /** `value` undefined = a new row's untouched cell (column default). */
  const cell = (key: string, col: Column, original: Cell, value: Cell | undefined, opts: { isNew?: boolean; isDeleted?: boolean; row?: Cell[] }) => {
    const isEdited = !opts.isNew && edited.has(`${key}/${col.name}`);
    const binary = isBinary(col);
    const editable = canEdit && !opts.isDeleted && !binary;
    if (editing?.key === key && editing.col === col.name) {
      const shown = value == null ? "" : String(value);
      return (
        <td key={col.name} className="relative p-0">
          <input
            autoFocus
            aria-label={col.name}
            defaultValue={shown}
            onBlur={(e) => {
              if (e.relatedTarget === nullBtn.current) return;
              if (e.currentTarget.dataset.cancel) setEditing(null);
              else commit(key, col, original, e.currentTarget.value, shown);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") e.currentTarget.dataset.cancel = "1";
              if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
            }}
            className={cn(
              "h-7 w-full border-0 bg-surface pr-12 pl-3 text-text shadow-[inset_0_0_0_1.5px_var(--accent)] outline-none",
              col.numeric && "text-right font-mono",
            )}
          />
          <button
            ref={nullBtn}
            type="button"
            title={t("data.setNull")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setNull(key, col, original)}
            onBlur={(e) => !e.currentTarget.parentElement?.contains(e.relatedTarget) && setEditing(null)}
            className="absolute top-1/2 right-1 h-5 -translate-y-1/2 rounded border border-border-strong bg-panel px-1 font-mono text-[10px] text-muted hover:text-text focus-visible:text-text"
          >
            NULL
          </button>
        </td>
      );
    }
    const text = value === undefined ? "DEFAULT" : formatCell(value, col.numeric);
    const fk = !opts.isNew && value !== null && value !== undefined && opts.row ? fkOf(col.name) : undefined;
    return (
      <td
        key={col.name}
        title={binary ? t("data.readOnlyCell") : text}
        tabIndex={editable ? 0 : undefined}
        onDoubleClick={() => editable && setEditing({ key, col: col.name })}
        onKeyDown={(e) => editable && (e.key === "Enter" || e.key === "F2") && setEditing({ key, col: col.name })}
        className={cn(
          "truncate px-3",
          col.numeric && "text-right font-mono",
          value === undefined ? "font-mono text-faint" : value === null && "text-faint italic",
          isEdited && "bg-accent-bg shadow-[inset_0_0_0_1.5px_var(--accent)]",
          fk && "group/fk relative pr-7",
        )}
      >
        {text}
        {fk && (
          <IconButton
            label={t("data.followFk", { table: fk.refTable })}
            size={20}
            onClick={() => openReferenced(fk, opts.row!)}
            className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover/fk:opacity-100 focus:opacity-100"
          >
            <ArrowUpRight size={12} />
          </IconButton>
        )}
        {isEdited && (
          <span role="img" aria-label={t("data.edited")} className="ml-1.5 inline-block size-1.5 rounded-full bg-accent align-middle" />
        )}
      </td>
    );
  };

  const rowButton = (key: string, isDeleted: boolean) => (
    <IconButton
      label={isDeleted ? t("data.restoreRow") : t("data.deleteRow")}
      size={20}
      onClick={() => dispatch({ type: "delete", key })}
      className={cn("inline-grid align-middle", !isDeleted && "opacity-0 group-hover:opacity-100 focus:opacity-100")}
    >
      {isDeleted ? <RotateCcw size={12} /> : <Trash2 size={12} />}
    </IconButton>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col">
        <div className="flex min-h-[46px] shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <span className="flex items-center gap-1.5 text-[12.5px] text-faint">
            {db}
            <span>›</span>
            {schema !== db && (
              <>
                {schema}
                <span>›</span>
              </>
            )}
            <span className="font-medium text-text">{table}</span>
          </span>
          <span aria-hidden="true" className="h-5 w-px bg-border" />
          {filterDraft !== null ? (
            <input
              autoFocus
              aria-label={t("data.filterLabel")}
              placeholder={t("data.filterPlaceholder")}
              value={filterDraft}
              onChange={(e) => setFilterDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyFilter();
                if (e.key === "Escape") setFilterDraft(null);
              }}
              onBlur={() => setFilterDraft(null)}
              className="h-[26px] min-w-[280px] flex-[0_1_420px] rounded-md border border-accent bg-surface px-2.5 font-mono text-xs outline-none"
            />
          ) : (
            <>
              {filter && (
                <span className="inline-flex h-[26px] max-w-[420px] items-center gap-1.5 rounded-md bg-accent-bg pr-1 pl-2.5 font-mono text-xs">
                  <button type="button" title={filter} onClick={() => setFilterDraft(filter)} className="min-w-0 truncate text-left">
                    {filter}
                  </button>
                  <IconButton label={t("data.removeFilter")} size={20} onClick={() => setFilter(null)}>
                    <X size={12} />
                  </IconButton>
                </span>
              )}
              <button
                type="button"
                onClick={() => setFilterDraft(filter ?? "")}
                className="inline-flex h-[26px] items-center gap-1.5 rounded-md border border-dashed border-border-strong px-2.5 text-muted hover:text-text"
              >
                <ListFilter size={13} aria-hidden="true" />
                {t("data.filter")}
              </button>
            </>
          )}
          <span className="flex-1" />
          <span className="text-xs text-muted">{t("data.rowsLoaded", { n: rows.length })}</span>
          <Button disabled={!canEdit} onClick={() => dispatch({ type: "add", tempId: `new-${seq.current++}`, values: {} })}>
            <Plus size={14} aria-hidden="true" />
            {t("data.row")}
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              app.dispatch({ type: "openDialog", dialog: "exportData", connectionId: conn.id, context: { database: tab.database, schema, table } })
            }
            className="px-2"
          >
            <Download size={14} aria-hidden="true" />
            {t("data.export")}
          </Button>
        </div>

        {keysKnown && !canEdit && status === "ready" && (
          <p role="note" className="m-0 shrink-0 border-b border-border bg-stg-bg px-3 py-1.5 text-xs text-stg">
            {t("data.noPk")}
          </p>
        )}
        <div onScroll={(e) => onScroll(e.currentTarget)} className="min-h-0 flex-1 overflow-auto text-[12.5px] select-text">
          <table
            aria-label={table}
            style={colWidths.tableWidth ? { width: colWidths.tableWidth + 64 } : undefined}
            className={cn("table-fixed border-collapse", !colWidths.tableWidth && "w-full min-w-[860px]", status === "loading" && "opacity-60")}
          >
            <colgroup>
              <col style={{ width: 64 }} />
              {columns.map((c) => (
                <col key={c.name} style={{ width: colWidths.widthOf(c) }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-[1] bg-panel text-xs">
              <tr className="h-8 shadow-[inset_0_-1px_0_var(--border-strong)]">
                <th scope="col" className="px-3 text-right font-normal text-faint">
                  #
                </th>
                {columns.map((c) => {
                  const sorted = sort?.column === c.name ? sort : null;
                  return (
                    <th
                      key={c.name}
                      scope="col"
                      aria-sort={sorted ? (sorted.desc ? "descending" : "ascending") : undefined}
                      className="relative p-0 font-medium"
                    >
                      <button
                        type="button"
                        title={`${c.name} · ${c.type}`}
                        onClick={() => setSort((s) => nextSort(s, c.name))}
                        className={cn(
                          "flex h-8 w-full items-center gap-1 px-3 hover:text-text",
                          c.numeric && !c.pk && !c.fk && "flex-row-reverse",
                        )}
                      >
                        {(c.pk || c.fk) && (
                          <span
                            className={cn(
                              "mr-0.5 shrink-0 rounded-[3px] border px-[3px] font-mono text-[9.5px] leading-[13px] font-normal",
                              c.pk ? "border-stg text-stg" : "border-dev text-dev",
                            )}
                          >
                            {c.pk ? "PK" : "FK"}
                          </span>
                        )}
                        <span className="truncate">{c.name}</span>
                        {sorted && (sorted.desc ? <ArrowDown size={12} className="shrink-0 text-accent" aria-hidden="true" /> : <ArrowUp size={12} className="shrink-0 text-accent" aria-hidden="true" />)}
                      </button>
                      <ResizeHandle
                        label={t("grid.resize", { name: c.name })}
                        onPointerDown={(e) => colWidths.startResize(c.name, e)}
                        onReset={() => colWidths.reset(c.name)}
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const key = rowKey(row, i);
                const isDeleted = deleted.has(key);
                return (
                  <tr
                    key={key}
                    className={cn("group h-[29px] border-b border-border", isDeleted ? "bg-prod-bg text-muted line-through" : "hover:bg-surface")}
                  >
                    <td className={cn("px-2 text-right font-mono text-[11px]", isDeleted ? "text-prod" : "text-faint")}>
                      {canEdit && rowButton(key, isDeleted)} {i + 1}
                    </td>
                    {columns.map((c, j) => {
                      const k = `${key}/${c.name}`;
                      return cell(key, c, row[j], edited.has(k) ? edited.get(k)! : row[j], { isDeleted, row });
                    })}
                  </tr>
                );
              })}
              {inserts.map((ins) => (
                <tr key={ins.tempId} className="group h-[29px] border-b border-border bg-ok-bg">
                  <td className="px-2 text-right font-mono text-[11px] text-ok">
                    {rowButton(ins.tempId, false)} +
                  </td>
                  {columns.map((c) => cell(ins.tempId, c, null, ins.values[c.name], { isNew: true }))}
                </tr>
              ))}
            </tbody>
          </table>
          {status === "error" ? (
            <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="m-0 max-w-[520px] text-prod">{error}</p>
              <Button onClick={() => void load(sort, 0)}>{t("data.retry")}</Button>
            </div>
          ) : status === "loading" && rows.length === 0 ? (
            <p role="status" className="m-0 py-10 text-center text-muted">{t("data.loading")}</p>
          ) : (
            rows.length === 0 && inserts.length === 0 && <p className="m-0 py-10 text-center text-muted">{t("data.noRows")}</p>
          )}
          {page.hasMore && status === "ready" && <p className="m-0 py-3 text-center text-xs text-muted">{t("data.loadingMore")}</p>}
        </div>
      </div>
      {changes.length > 0 && (
        <PendingChangesPanel
          changes={changes}
          schema={schema}
          table={table}
          columns={columns}
          rows={rows}
          conn={conn}
          sid={sid}
          onDiscard={() => dispatch({ type: "discard" })}
          onApplied={() => {
            dispatch({ type: "discard" });
            toast(t("data.applied", { table }));
            void load(sort, 0);
          }}
        />
      )}
    </div>
  );
}
