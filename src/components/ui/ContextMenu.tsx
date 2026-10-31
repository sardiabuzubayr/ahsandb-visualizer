import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface ContextMenuItem {
  key: string;
  label: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Tooltip, e.g. why the item is disabled. */
  title?: string;
}

const GAP = 4;

/** Keeps a w×h menu opened at (x, y) inside a vw×vh viewport. */
export function clampMenu(x: number, y: number, w: number, h: number, vw: number, vh: number) {
  return { left: Math.max(GAP, Math.min(x, vw - w - GAP)), top: Math.max(GAP, Math.min(y, vh - h - GAP)) };
}

/** Next enabled index for ↑/↓ (wraps); `from` -1 = nothing focused yet. Returns -1 when all are disabled. */
export function stepIndex(enabled: boolean[], from: number, dir: 1 | -1): number {
  const n = enabled.length;
  // With nothing focused, ↓ starts at the first item and ↑ at the last.
  const start = from >= 0 ? from : dir > 0 ? -1 : n;
  for (let i = 1; i <= n; i++) {
    const j = (((start + dir * i) % n) + n) % n;
    if (enabled[j]) return j;
  }
  return -1;
}

/**
 * App menu opened at the pointer (right-click). Closes on Esc, Tab, outside click, scroll, resize, window blur
 * or after an item is chosen. Render it only while open (`at` set).
 */
export function ContextMenu({
  at,
  items,
  label,
  onClose,
}: {
  at: { x: number; y: number };
  items: ContextMenuItem[];
  label?: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    setPos(clampMenu(at.x, at.y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight));
    focusAt(el, stepIndex(items.map((i) => !i.disabled), -1, 1));
    return () => prev?.focus({ preventScroll: true });
  }, [at.x, at.y]); // eslint-disable-line react-hooks/exhaustive-deps -- reposition per opening only

  useEffect(() => {
    const done = () => close.current();
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && done();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", done, true);
    window.addEventListener("resize", done);
    window.addEventListener("blur", done);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", done, true);
      window.removeEventListener("resize", done);
      window.removeEventListener("blur", done);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      return onClose();
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
    const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
    focusAt(ref.current!, stepIndex(items.map((i) => !i.disabled), from, e.key === "ArrowDown" ? 1 : -1));
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 min-w-48 rounded-lg border border-border-strong bg-panel p-1 shadow-[0_12px_32px_rgba(0,0,0,.45)]"
    >
      {items.map((i) => (
        <button
          key={i.key}
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={i.disabled}
          title={i.title}
          onClick={() => {
            onClose();
            i.onSelect();
          }}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left outline-none hover:bg-raised focus:bg-raised disabled:opacity-50"
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

function focusAt(menu: HTMLElement, i: number) {
  if (i >= 0) menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]")[i]?.focus({ preventScroll: true });
}
