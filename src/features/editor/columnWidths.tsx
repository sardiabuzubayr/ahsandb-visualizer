// Resizable grid columns: each starts fitted to its header and values; drag the right edge of a header
// to set it, double-click to go back to fitted. Set widths are kept per grid (key) in localStorage.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Cell, Column } from "../../types";
import { formatCell } from "./format";

const MIN = 48;
const AUTO = 180;
const FIT_MIN = 64;
/** Longer values stay truncated (full text in the cell's tooltip / record view). */
const FIT_MAX = 360;
/** Cell padding (px-3 both sides) plus a little air. */
const PAD = 28;
const SAMPLE = 100;

export type TextKind = "head" | "cell" | "mono" | "small";
export type Measure = (text: string, kind: TextKind) => number;

/** Width that shows each column's header and its first SAMPLE values whole, within FIT_MIN..FIT_MAX. */
export function fitWidths(columns: Column[], rows: Cell[][], measure: Measure, headExtra: (c: Column, m: Measure) => number = () => 0): Widths {
  const sample = rows.slice(0, SAMPLE);
  return Object.fromEntries(
    columns.map((c, j) => {
      let w = measure(c.name, "head") + headExtra(c, measure);
      for (const r of sample) if (r[j] !== undefined) w = Math.max(w, measure(formatCell(r[j], c.numeric), c.numeric ? "mono" : "cell"));
      return [c.name, Math.round(Math.min(FIT_MAX, Math.max(FIT_MIN, w + PAD)))];
    }),
  );
}

let ctx: CanvasRenderingContext2D | null | undefined;
/** Text width in the grid's fonts (canvas); a rough per-character guess where canvas is missing. */
const measureText: Measure = (text, kind) => {
  if (ctx === undefined) ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!ctx) return text.length * 7.5;
  const css = getComputedStyle(document.documentElement);
  const sans = css.getPropertyValue("--font-sans") || "sans-serif";
  const mono = css.getPropertyValue("--font-mono") || "monospace";
  ctx.font = { head: `500 12px ${sans}`, cell: `12.5px ${sans}`, mono: `12.5px ${mono}`, small: `10.5px ${mono}` }[kind];
  return ctx.measureText(text).width;
};

type Widths = Record<string, number>;

function load(key: string | null): Widths {
  if (!key) return {};
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "{}");
    return v && typeof v === "object" ? (v as Widths) : {};
  } catch {
    return {};
  }
}

function save(key: string | null, w: Widths) {
  if (!key) return;
  try {
    if (Object.keys(w).length) localStorage.setItem(key, JSON.stringify(w));
    else localStorage.removeItem(key);
  } catch {
    // shortcut: without storage, widths last until the grid is closed.
  }
}

/** Storage key for a grid; `parts` identify it (e.g. connection + table, or the result's column names). */
export const gridKey = (...parts: string[]) => `grid.widths:${parts.join("\u001f")}`;

/** `headExtra` = header room besides the name (key badge, type label, sort arrow). */
export function useColumnWidths(key: string | null, columns: Column[], rows: Cell[][], headExtra?: (c: Column, m: Measure) => number) {
  const [widths, setWidths] = useState<Widths>(() => load(key));
  const loaded = useRef(key);
  useEffect(() => {
    if (loaded.current === key) return;
    loaded.current = key;
    setWidths(load(key));
  }, [key]);

  // Fitted once per column set and first page (loading more rows doesn't make columns jump).
  const first = rows.slice(0, SAMPLE);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fit = useMemo(() => fitWidths(columns, first, measureText, headExtra), [columns.map((c) => `${c.name}:${c.type}:${c.pk}:${c.fk}`).join("\u001f"), first.length, rows[0]]);
  // Every column has a fixed width and the table their total (horizontal scroll, at least the grid's width).
  const widthOf = (c: Column) => widths[c.name] ?? fit[c.name] ?? AUTO;
  const tableWidth = columns.reduce((sum, c) => sum + widthOf(c), 0);

  const startResize = (name: string, e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.closest("th");
    const startX = e.clientX;
    const startW = th?.getBoundingClientRect().width ?? AUTO;
    let latest = widths;
    const move = (ev: PointerEvent) => {
      latest = { ...latest, [name]: Math.max(MIN, Math.round(startW + ev.clientX - startX)) };
      setWidths(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      save(key, latest);
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const reset = (name: string) => {
    const { [name]: _gone, ...rest } = widths;
    setWidths(rest);
    save(key, rest);
  };

  return { widthOf, tableWidth, startResize, reset };
}

/** The drag handle on a header's right edge (the header cell must be `relative`). */
export function ResizeHandle({ label, onPointerDown, onReset }: { label: string; onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void; onReset: () => void }) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => (e.stopPropagation(), onReset())}
      onClick={(e) => e.stopPropagation()}
      className="absolute top-0 right-0 z-[2] h-full w-1.5 cursor-col-resize after:absolute after:top-1.5 after:right-0 after:bottom-1.5 after:w-px after:bg-border-strong hover:after:w-0.5 hover:after:bg-accent"
    />
  );
}
