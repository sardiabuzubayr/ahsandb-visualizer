import { useEffect, useReducer, useRef, useState, type MouseEvent } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import type { Cell, Column, Connection, ResultSet } from "../../types";
import { Button, IconButton, cn } from "../../components/ui";
import { formatCell } from "./format";
import { visibleRange } from "./results";
import { ResizeHandle, gridKey, useColumnWidths, type Measure } from "./columnWidths";
import { columnSources, deleteTarget, sourceTables } from "./resultSource";
import { api } from "../../lib/api";
import { useToast } from "../../state/app";
import { pendingReducer, rowKeyOf } from "../data/pending";
import { defaultSchema, selectRows } from "../data/table";
import { PendingChangesPanel } from "../data/PendingChangesPanel";
import { RecordView } from "../data/RecordView";
import { useT } from "../../i18n";

const ROW_H = 28;

/** Header room besides the name: the type label. */
const headRoom = (c: Column, m: Measure) => m(c.type, "small") + 8;

/** Where a SQL tab's results come from, so rows can be deleted by primary key. */
export interface ResultSource {
  conn: Connection;
  /** IPC id of the tab (scopedId). */
  sid: string;
  /** Database the tab runs in: the schema of unqualified MySQL/MariaDB tables. */
  database?: string;
}

type Target = NonNullable<ReturnType<typeof deleteTarget>>;

export function ResultGrid({ result, label, record, source }: { result: ResultSet & { sql?: string }; label: string; record?: boolean; source?: ResultSource }) {
  const t = useT();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [changes, dispatch] = useReducer(pendingReducer, []);
  const [gone, setGone] = useState<Set<string>>(new Set()); // keys of rows deleted from the database
  // Widths follow the column set, so re-running the same query keeps them.
  const cols = useColumnWidths(gridKey("result", ...result.columns.map((c) => c.name)), result.columns, result.rows, headRoom);
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [record]);

  // The table the rows can be deleted from: one whose whole primary key is in the result.
  const conn = source?.conn;
  useEffect(() => {
    if (!source || !conn?.connected) return;
    const schema = conn.driver === "mysql" || conn.driver === "mariadb" ? (source.database ?? defaultSchema(conn)) : defaultSchema(conn);
    const sources = columnSources(result.columns, result.sql, schema);
    let live = true;
    Promise.all(sourceTables(sources).map(async (tb) => ({ ...tb, columns: await api.tableColumns(source.sid, tb.schema, tb.table).catch(() => []) })))
      .then((tables) => live && setTarget(deleteTarget(sources, tables)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.sid, conn?.connected, result.columns, result.sql]);

  const rowKey = (row: Cell[], i: number) => (target ? rowKeyOf(row, target.keyIdxs, i) : String(i));
  const rows = gone.size ? result.rows.filter((r, i) => !gone.has(rowKey(r, i))) : result.rows;
  const deleted = new Set(changes.flatMap((c) => (c.kind === "delete" ? [c.rowKey] : [])));
  const pick = [...selected].map(Number).filter((i) => i < rows.length).sort((a, b) => a - b);
  const toDelete = target ? [...new Set(pick.map((i) => rowKey(rows[i], i)))].filter((k) => !deleted.has(k)) : [];
  const deleteSelected = () => toDelete.length && dispatch({ type: "deleteRows", keys: toDelete });
  // The pending panel matches rows by the target's key columns, named as in the table.
  const keyColumns = target
    ? result.columns.map((c, j) => {
        const k = target.keyIdxs.indexOf(j);
        return k < 0 ? { ...c, pk: false } : { ...c, name: target.keyNames[k], pk: true };
      })
    : [];

  const onRowClick = (e: MouseEvent, i: number) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const keys = rows.map((_, j) => String(j));
    setSelected((sel) => selectRows(keys, sel, anchor.current, i, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey }));
    if (!e.shiftKey || anchor.current === null) anchor.current = i;
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
  const valueCell = (v: Cell, j: number, vertical = false) => {
    const col = result.columns[j];
    const text = formatCell(v, col?.numeric);
    return (
      <td key={j} title={text} className={cn("truncate px-3", col?.numeric && (vertical ? "font-mono" : "text-right font-mono"), v === null && "text-faint italic")}>
        {text}
      </td>
    );
  };

  // Windowed: only rows in view (+ overscan) are in the DOM; spacer rows keep the scroll height.
  const { start, end } = visibleRange(scroll.top, scroll.height, ROW_H, rows.length, 10);
  const grid = record ? (
    <RecordView
      table={target?.table ?? label}
      columns={target ? keyColumns.map((c, j) => ({ ...c, name: result.columns[j].name })) : result.columns}
      // Selected rows, else the first one (a one-row result needs no click).
      records={(pick.length ? pick : rows.length ? [0] : []).map((i) => ({ row: rows[i], i, key: String(i) }))}
      isDeleted={(k) => deleted.has(rowKey(rows[Number(k)], Number(k)))}
      renderCell={(_k, _c, j, row) => valueCell(row[j], j, true)}
    />
  ) : (
    <div
      ref={box}
      tabIndex={-1}
      onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      onKeyDown={(e) => (e.key === "Delete" || e.key === "Backspace") && deleteSelected()}
      className="min-h-0 flex-1 overflow-auto text-[12.5px] outline-none select-text"
    >
      <table aria-label={label} style={{ width: cols.tableWidth + 52 }} className="table-fixed border-collapse">
        <colgroup>
          <col style={{ width: 52 }} />
          {result.columns.map((c, j) => (
            <col key={j} style={{ width: cols.widthOf(c) }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-[1] bg-panel text-xs">
          <tr className="h-[30px] shadow-[inset_0_-1px_0_var(--border-strong)]">
            <th scope="col" className="px-3 text-right font-normal text-faint">
              #
            </th>
            {result.columns.map((c, j) => (
              <th key={j} scope="col" className="relative px-3 font-medium">
                <span className="flex justify-between gap-2">
                  <span className="truncate" title={c.name}>
                    {c.name}
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] font-normal text-faint">{c.type}</span>
                </span>
                <ResizeHandle
                  label={t("grid.resize", { name: c.name })}
                  onPointerDown={(e) => cols.startResize(c.name, e)}
                  onReset={() => cols.reset(c.name)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {start > 0 && <tr aria-hidden="true" style={{ height: start * ROW_H }} />}
          {rows.slice(start, end).map((row, k) => {
            const i = start + k;
            const key = rowKey(row, i);
            const isDeleted = deleted.has(key);
            const isSelected = selected.has(String(i));
            return (
              <tr
                key={i}
                aria-selected={isSelected}
                onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                onClick={(e) => onRowClick(e, i)}
                className={cn(
                  "group h-7 shadow-[inset_0_-1px_0_var(--border)]",
                  isDeleted ? "bg-prod-bg text-muted line-through" : isSelected ? "bg-[var(--accent-sel)]" : "hover:bg-surface",
                )}
              >
                <td className={cn("px-2 text-right font-mono text-[11px]", isDeleted ? "text-prod" : "text-faint")}>
                  {target && rowButton(key, isDeleted)} {i + 1}
                </td>
                {row.map((v, j) => valueCell(v, j))}
              </tr>
            );
          })}
          {end < rows.length && <tr aria-hidden="true" style={{ height: (rows.length - end) * ROW_H }} />}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col">
        {toDelete.length > 0 && (
          <p className="m-0 flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted">
            <span className="flex-1">{t("results.selected", { n: pick.length })}</span>
            <Button variant="ghost" title={t("data.deleteSelectedHint")} onClick={deleteSelected} className="h-6 px-2">
              <Trash2 size={13} aria-hidden="true" />
              {t("results.deleteFrom", { n: toDelete.length, table: target!.table })}
            </Button>
          </p>
        )}
        {grid}
      </div>
      {target && source && changes.length > 0 && (
        <PendingChangesPanel
          changes={changes}
          schema={target.schema}
          table={target.table}
          columns={keyColumns}
          rows={rows}
          conn={source.conn}
          sid={source.sid}
          onDiscard={() => dispatch({ type: "discard" })}
          onApplied={() => {
            setGone((g) => new Set([...g, ...deleted]));
            setSelected(new Set());
            dispatch({ type: "discard" });
            toast(t("data.applied", { table: target.table }));
          }}
        />
      )}
    </div>
  );
}
