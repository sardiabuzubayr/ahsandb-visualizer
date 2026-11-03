import { useEffect, useRef, useState } from "react";
import type { Column, ResultSet } from "../../types";
import { cn } from "../../components/ui";
import { formatCell } from "./format";
import { visibleRange } from "./results";
import { ResizeHandle, gridKey, useColumnWidths, type Measure } from "./columnWidths";
import { useT } from "../../i18n";

const ROW_H = 28;

/** Header room besides the name: the type label. */
const headRoom = (c: Column, m: Measure) => m(c.type, "small") + 8;

export function ResultGrid({ result, label }: { result: ResultSet; label: string }) {
  const t = useT();
  const [selected, setSelected] = useState<number | null>(null);
  // Widths follow the column set, so re-running the same query keeps them.
  const cols = useColumnWidths(gridKey("result", ...result.columns.map((c) => c.name)), result.columns, result.rows, headRoom);
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setScroll({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Windowed: only rows in view (+ overscan) are in the DOM; spacer rows keep the scroll height.
  const { start, end } = visibleRange(scroll.top, scroll.height, ROW_H, result.rows.length, 10);
  return (
    <div
      ref={box}
      onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      className="min-h-0 flex-1 overflow-auto text-[12.5px] select-text"
    >
      <table
        aria-label={label}
        style={{ width: cols.tableWidth + 52 }}
        className="table-fixed border-collapse"
      >
        <colgroup>
          <col style={{ width: 52 }} />
          {result.columns.map((c) => (
            <col key={c.name} style={{ width: cols.widthOf(c) }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-[1] bg-panel text-xs">
          <tr className="h-[30px] shadow-[inset_0_-1px_0_var(--border-strong)]">
            <th scope="col" className="px-3 text-right font-normal text-faint">
              #
            </th>
            {result.columns.map((c) => (
              <th key={c.name} scope="col" className="relative px-3 font-medium">
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
          {result.rows.slice(start, end).map((row, k) => {
            const i = start + k;
            return (
            <tr
              key={i}
              aria-selected={selected === i}
              onClick={() => setSelected(i)}
              className={cn("h-7 shadow-[inset_0_-1px_0_var(--border)]", selected === i ? "bg-accent-bg" : "hover:bg-surface")}
            >
              <td className="px-3 text-right font-mono text-[11px] text-faint">{i + 1}</td>
              {row.map((v, j) => {
                const col = result.columns[j];
                const text = formatCell(v, col?.numeric);
                return (
                  <td
                    key={j}
                    title={text}
                    className={cn(
                      "truncate px-3",
                      col?.numeric && "text-right font-mono",
                      v === null && "text-faint italic",
                    )}
                  >
                    {text}
                  </td>
                );
              })}
            </tr>
            );
          })}
          {end < result.rows.length && <tr aria-hidden="true" style={{ height: (result.rows.length - end) * ROW_H }} />}
        </tbody>
      </table>
    </div>
  );
}
