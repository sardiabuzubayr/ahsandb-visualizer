import { useEffect, useReducer, useRef, useState, type MouseEvent } from "react";
import { ArrowUpRight, Copy, RotateCcw, Trash2 } from "lucide-react";
import type { Cell, Column, Connection, ResultSet } from "../../types";
import { Button, IconButton, cn } from "../../components/ui";
import { formatCell } from "./format";
import { visibleRange } from "./results";
import { ResizeHandle, gridKey, useColumnWidths, type Measure } from "./columnWidths";
import { columnForeignKeys, columnSources, editTarget, sourceTables } from "./resultSource";
import { api } from "../../lib/api";
import { useApp, useToast } from "../../state/app";
import { pendingReducer, rowKeyOf } from "../data/pending";
import { defaultSchema, followForeignKey, selectRows } from "../data/table";
import { PendingChangesPanel } from "../data/PendingChangesPanel";
import { RecordView } from "../data/RecordView";
import { CellEditor, parseCell } from "../data/CellEditor";
import { useT } from "../../i18n";

const ROW_H = 28;

/** Header room besides the name: the type label. */
const headRoom = (c: Column, m: Measure) => m(c.type, "small") + 8;

const isBinary = (c: Column) => /bytea|blob|binary/i.test(c.type);

/** Where a SQL tab's results come from, so rows can be edited, duplicated and deleted by primary key. */
export interface ResultSource {
  conn: Connection;
  /** IPC id of the tab (scopedId). */
  sid: string;
  /** Database the tab runs in: the schema of unqualified MySQL/MariaDB tables. */
  database?: string;
}

type Target = NonNullable<ReturnType<typeof editTarget>>;

export function ResultGrid({
  result,
  label,
  record,
  source,
  onRefresh,
}: {
  result: ResultSet & { sql?: string };
  label: string;
  record?: boolean;
  source?: ResultSource;
  /** Re-run the query after changes are applied. */
  onRefresh?: () => Promise<void>;
}) {
  const t = useT();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [fkCols, setFkCols] = useState<ReturnType<typeof columnForeignKeys>>([]);
  const app = useApp();
  const [changes, dispatch] = useReducer(pendingReducer, []);
  const [gone, setGone] = useState<Set<string>>(new Set()); // keys of rows deleted from the database
  useEffect(() => setGone(new Set()), [result.rows]); // fresh rows after a refresh
  const [editing, setEditing] = useState<{ key: string; j: number } | null>(null);
  const seq = useRef(1);
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

  // The table the rows can be edited in: one whose whole primary key is in the result.
  const conn = source?.conn;
  useEffect(() => {
    if (!source || !conn?.connected) return;
    const schema = conn.driver === "mysql" || conn.driver === "mariadb" ? (source.database ?? defaultSchema(conn)) : defaultSchema(conn);
    const sources = columnSources(result.columns, result.sql, schema);
    let live = true;
    Promise.all(
      sourceTables(sources).map(async (tb) => {
        const [columns, foreignKeys] = await Promise.all([
          api.tableColumns(source.sid, tb.schema, tb.table).catch(() => []),
          api.loadTable(source.sid, tb.schema, tb.table).then((d) => d.foreignKeys, () => []),
        ]);
        return { ...tb, columns, foreignKeys };
      }),
    ).then((tables) => {
      if (!live) return;
      setTarget(editTarget(sources, tables));
      setFkCols(columnForeignKeys(sources, tables));
    });
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
  const edited = new Map<string, Cell>(changes.flatMap((c) => (c.kind === "update" ? [[`${c.rowKey}/${c.column}`, c.to] as const] : [])));
  const inserts = changes.flatMap((c) => (c.kind === "insert" ? [c] : []));
  // Copies of the selected rows as pending inserts. Key columns (often generated) and binary cells are left to
  // their default; the user can still type them in the green row before applying.
  const duplicateSelected = () => {
    if (!target?.complete) return;
    for (const i of pick) {
      const values: Record<string, Cell> = {};
      target.tableCols.forEach((tc, j) => {
        if (tc && !target.keyIdxs.includes(j) && !isBinary(tc)) values[tc.name] = rows[i][j];
      });
      dispatch({ type: "add", tempId: `new-${seq.current++}`, values });
    }
  };
  // The pending panel works in table column names; the key columns flag the row identity.
  const editColumns = target
    ? result.columns.map((c, j) => {
        const tc = target.tableCols[j];
        return { ...c, ...(tc && { name: tc.name, enumValues: tc.enumValues }), pk: target.keyIdxs.includes(j) };
      })
    : [];

  const onRowClick = (e: MouseEvent, i: number) => {
    if ((e.target as HTMLElement).closest("input, select, button")) return;
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
  // Opens the referenced table filtered to the row this foreign key points at.
  const openReferenced = (j: number, row: Cell[]) => {
    const f = fkCols[j];
    const to = f && source && followForeignKey(source.conn.driver, f.fk, f.schema, f.columns, row);
    if (to)
      app.dispatch({ type: "openTab", kind: "table", connectionId: source.conn.id, title: to.table, target: to.target, database: source.database, filter: to.filter, from: app.state.activeTabId ?? undefined });
  };
  /** `values` set = a pending insert's cell (absent = column default). */
  const valueCell = (
    key: string,
    j: number,
    original: Cell,
    opts: { isDeleted?: boolean; vertical?: boolean; values?: Record<string, Cell>; row?: Cell[] } = {},
  ) => {
    const col = editColumns[j] ?? result.columns[j];
    const tc = target?.tableCols[j];
    const isNew = !!opts.values;
    if (isNew && !tc) return <td key={j} />;
    const editKey = tc && `${key}/${tc.name}`;
    const isEdited = !isNew && !!editKey && edited.has(editKey);
    const value: Cell | undefined = isNew ? opts.values![tc!.name] : isEdited ? edited.get(editKey!)! : original;
    const editable = !!tc && !opts.isDeleted && !isBinary(tc);
    if (editable && editing?.key === key && editing.j === j)
      return (
        <CellEditor
          key={j}
          col={col}
          value={value}
          vertical={opts.vertical}
          onCommit={(text, shown) => {
            setEditing(null);
            // Leaving the editor untouched is not an edit (keeps NULL as NULL and DEFAULT as DEFAULT).
            if (text !== shown) dispatch({ type: "edit", key, column: tc.name, from: original, to: parseCell(text, original, col) });
          }}
          onNull={() => (setEditing(null), dispatch({ type: "edit", key, column: tc.name, from: original, to: null }))}
          onCancel={() => setEditing(null)}
        />
      );
    const text = value === undefined ? "DEFAULT" : formatCell(value, col.numeric);
    const fk = !isNew && original !== null && opts.row ? fkCols[j] : undefined;
    return (
      <td
        key={j}
        title={text}
        tabIndex={editable ? 0 : undefined}
        onDoubleClick={() => editable && setEditing({ key, j })}
        onKeyDown={(e) => editable && (e.key === "Enter" || e.key === "F2") && setEditing({ key, j })}
        className={cn(
          "truncate px-3",
          col.numeric && (opts.vertical ? "font-mono" : "text-right font-mono"),
          value === undefined ? "font-mono text-faint" : value === null && "text-faint italic",
          isEdited && "bg-accent-bg shadow-[inset_0_0_0_1.5px_var(--accent)]",
          fk && "group/fk relative pr-7",
        )}
      >
        {text}
        {fk && (
          <IconButton
            label={t("data.followFk", { table: fk.fk.refTable })}
            size={20}
            onClick={() => openReferenced(j, opts.row!)}
            className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover/fk:opacity-100 focus:opacity-100"
          >
            <ArrowUpRight size={12} />
          </IconButton>
        )}
      </td>
    );
  };

  // Windowed: only rows in view (+ overscan) are in the DOM; spacer rows keep the scroll height.
  const { start, end } = visibleRange(scroll.top, scroll.height, ROW_H, rows.length, 10);
  const grid = record ? (
    <RecordView
      table={target?.table ?? label}
      columns={target ? editColumns.map((c, j) => ({ ...c, name: result.columns[j].name })) : result.columns}
      // Selected rows, else the first one (a one-row result needs no click).
      records={(pick.length ? pick : rows.length ? [0] : []).map((i) => ({ row: rows[i], i, key: rowKey(rows[i], i) }))}
      isDeleted={(k) => deleted.has(k)}
      renderCell={(k, _c, j, row) => valueCell(k, j, row[j], { isDeleted: deleted.has(k), vertical: true, row })}
    />
  ) : (
    <div
      ref={box}
      tabIndex={-1}
      onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      onKeyDown={(e) => {
        if ((e.key === "Delete" || e.key === "Backspace") && !(e.target as HTMLElement).closest("input, select")) deleteSelected();
      }}
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
                {row.map((v, j) => valueCell(key, j, v, { isDeleted, row }))}
              </tr>
            );
          })}
          {end < rows.length && <tr aria-hidden="true" style={{ height: (rows.length - end) * ROW_H }} />}
          {inserts.map((ins) => (
            <tr key={ins.tempId} className="group h-7 bg-ok-bg shadow-[inset_0_-1px_0_var(--border)]">
              <td className="px-2 text-right font-mono text-[11px] text-ok">
                {rowButton(ins.tempId, false)} +
              </td>
              {result.columns.map((_, j) => valueCell(ins.tempId, j, null, { values: ins.values }))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col">
        {target && pick.length > 0 && (
          <p className="m-0 flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted">
            <span className="flex-1">{t("results.selected", { n: pick.length })}</span>
            {target.complete && (
              <Button variant="ghost" title={t("results.duplicateHint")} onClick={duplicateSelected} className="h-6 px-2">
                <Copy size={13} aria-hidden="true" />
                {t("results.duplicate", { n: pick.length })}
              </Button>
            )}
            {toDelete.length > 0 && (
              <Button variant="ghost" title={t("data.deleteSelectedHint")} onClick={deleteSelected} className="h-6 px-2">
                <Trash2 size={13} aria-hidden="true" />
                {t("results.deleteFrom", { n: toDelete.length, table: target.table })}
              </Button>
            )}
          </p>
        )}
        {grid}
      </div>
      {target && source && changes.length > 0 && (
        <PendingChangesPanel
          changes={changes}
          schema={target.schema}
          table={target.table}
          columns={editColumns}
          rows={rows}
          conn={source.conn}
          sid={source.sid}
          onDiscard={() => dispatch({ type: "discard" })}
          onApplied={() => {
            setGone((g) => new Set([...g, ...deleted]));
            setSelected(new Set());
            dispatch({ type: "discard" });
            toast(t("data.applied", { table: target.table }));
            void onRefresh?.();
          }}
        />
      )}
    </div>
  );
}
