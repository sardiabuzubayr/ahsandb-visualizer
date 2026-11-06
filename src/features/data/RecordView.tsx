import type { ReactNode } from "react";
import { useT } from "../../i18n";
import type { Cell, Column } from "../../types";
import { cn } from "../../components/ui";
import { ResizeHandle, gridKey, useColumnWidths } from "../editor/columnWidths";
import { formatCell } from "../editor/format";

const NAME = "\u0000column"; // the column-name column's width key (can't clash with "#n")

export function KeyBadge({ col }: { col: Column }) {
  if (!col.pk && !col.fk) return null;
  return (
    <span
      className={cn(
        "mr-0.5 shrink-0 rounded-[3px] border px-[3px] font-mono text-[9.5px] leading-[13px] font-normal",
        col.pk ? "border-stg text-stg" : "border-dev text-dev",
      )}
    >
      {col.pk ? "PK" : "FK"}
    </span>
  );
}

/** Selected rows turned sideways: one line per column, one value column per row (like DBeaver's record mode). */
export function RecordView({
  table,
  columns,
  records,
  isDeleted,
  renderCell,
}: {
  table: string;
  columns: Column[];
  records: { row: Cell[]; i: number; key: string }[];
  isDeleted: (key: string) => boolean;
  renderCell: (key: string, col: Column, j: number, row: Cell[]) => ReactNode;
}) {
  const t = useT();
  // Sideways grid: fitted like the normal grid (names + types on the left, values per record), resizable.
  // Values are measured as shown (numbers grouped, in the mono font when any column is numeric).
  const mono = columns.some((c) => c.numeric);
  const side: Column[] = [{ name: NAME, type: "" }, ...records.map((r) => ({ name: `#${r.i + 1}`, type: "", numeric: mono }))];
  const lines = columns.map((c, j) => [`${c.name}   ${c.type}`, ...records.map((r) => formatCell(r.row[j], c.numeric))]);
  const widths = useColumnWidths(gridKey("record", table), side, lines, (c) => (c.name === NAME ? 40 : 0));
  if (records.length === 0) return <p className="m-0 flex-1 py-10 text-center text-muted">{t("data.recordViewEmpty")}</p>;
  const handle = (c: Column) => (
    <ResizeHandle
      label={t("grid.resize", { name: c.name === NAME ? t("data.column") : c.name })}
      onPointerDown={(e) => widths.startResize(c.name, e)}
      onReset={() => widths.reset(c.name)}
    />
  );
  return (
    <div className="min-h-0 flex-1 overflow-auto text-[12.5px] select-text">
      <table aria-label={t("data.recordViewOf", { table })} style={{ width: widths.tableWidth }} className="table-fixed border-collapse">
        <colgroup>
          {side.map((c) => (
            <col key={c.name} style={{ width: widths.widthOf(c) }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-[2] bg-panel text-xs">
          <tr className="h-8 shadow-[inset_0_-1px_0_var(--border-strong)]">
            <th scope="col" className="sticky left-0 z-[1] bg-panel px-3 text-left font-normal text-faint">
              {t("data.column")}
              {handle(side[0])}
            </th>
            {records.map((r, k) => (
              <th
                key={r.key}
                scope="col"
                className={cn("relative px-3 text-left font-mono font-normal", isDeleted(r.key) ? "text-prod line-through" : "text-faint")}
              >
                #{r.i + 1}
                {handle(side[k + 1])}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {columns.map((c, j) => (
            <tr key={j} className="h-[29px] border-b border-border hover:bg-surface">
              <th scope="row" title={`${c.name} · ${c.type}`} className="sticky left-0 bg-panel px-3 text-left font-medium">
                <span className="flex items-center gap-1">
                  <KeyBadge col={c} />
                  <span className="truncate">{c.name}</span>
                  <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] font-normal text-faint">{c.type}</span>
                </span>
              </th>
              {records.map((r) => renderCell(r.key, c, j, r.row))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
