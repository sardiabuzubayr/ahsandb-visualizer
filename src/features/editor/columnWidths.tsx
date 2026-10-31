// Resizable grid columns: drag the right edge of a header, double-click it to go back to automatic.
// Widths are kept per grid (key) in localStorage, so they survive closing the tab or the app.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Column } from "../../types";

const MIN = 48;
/** Width a column without a set or typed width gets once the grid switches to fixed widths. */
const AUTO = 180;

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

export function useColumnWidths(key: string | null, columns: Column[], autoWidth: (c: Column) => number | undefined) {
  const [widths, setWidths] = useState<Widths>(() => load(key));
  const loaded = useRef(key);
  useEffect(() => {
    if (loaded.current === key) return;
    loaded.current = key;
    setWidths(load(key));
  }, [key]);

  // Once any column was sized by hand every column gets a fixed width and the table its total width
  // (horizontal scroll), so dragging one column never squeezes the others.
  const fixed = columns.some((c) => widths[c.name] !== undefined);
  const widthOf = (c: Column) => widths[c.name] ?? (fixed ? (autoWidth(c) ?? AUTO) : autoWidth(c));
  const tableWidth = fixed ? columns.reduce((sum, c) => sum + (widthOf(c) ?? AUTO), 0) : undefined;

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
