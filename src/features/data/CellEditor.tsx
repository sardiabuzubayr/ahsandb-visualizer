import { useT } from "../../i18n";
import type { Cell, Column } from "../../types";
import { cn } from "../../components/ui";

/** Typed text → cell value: whole numbers stay numbers in numeric columns. */
export const parseCell = (text: string, prev: Cell, col: Column): Cell =>
  (typeof prev === "number" || (prev === null && col.numeric)) && /^-?\d+$/.test(text) ? Number(text) : text;

/**
 * The in-cell editor of a grid: a text input (or a list for enums) plus a NULL button.
 * `onCommit` gets the typed text and the text it started with; Escape or leaving an enum list cancels.
 */
export function CellEditor({
  col,
  value,
  vertical,
  onCommit,
  onNull,
  onCancel,
}: {
  col: Column;
  /** undefined = a new row's untouched cell (column default). */
  value: Cell | undefined;
  vertical?: boolean;
  onCommit: (text: string, shown: string) => void;
  onNull: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const shown = value == null ? "" : String(value);
  const nullButton = (
    <button
      type="button"
      title={t("data.setNull")}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onNull}
      onBlur={(e) => !e.currentTarget.parentElement?.contains(e.relatedTarget) && onCancel()}
      className="absolute top-1/2 right-1 h-5 -translate-y-1/2 rounded border border-border-strong bg-panel px-1 font-mono text-[10px] text-muted hover:text-text focus-visible:text-text"
    >
      NULL
    </button>
  );
  if (col.enumValues?.length)
    return (
      <td className="relative p-0">
        <select
          autoFocus
          aria-label={col.name}
          defaultValue={shown}
          onFocus={(e) => {
            try {
              e.currentTarget.showPicker();
            } catch {
              // Older WebKit: the list opens on click or Space instead.
            }
          }}
          onChange={(e) => onCommit(e.currentTarget.value, shown)}
          onBlur={(e) => !e.currentTarget.parentElement?.contains(e.relatedTarget) && onCancel()}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
          className="h-7 w-full border-0 bg-surface pr-12 pl-3 text-text shadow-[inset_0_0_0_1.5px_var(--accent)] outline-none"
        >
          {!col.enumValues.includes(shown) && <option value={shown} disabled hidden />}
          {col.enumValues.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        {nullButton}
      </td>
    );
  return (
    <td className="relative p-0">
      <input
        autoFocus
        aria-label={col.name}
        defaultValue={shown}
        onBlur={(e) => {
          if (e.currentTarget.parentElement?.contains(e.relatedTarget)) return; // moving to the NULL button
          if (e.currentTarget.dataset.cancel) onCancel();
          else onCommit(e.currentTarget.value, shown);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.currentTarget.dataset.cancel = "1";
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        }}
        className={cn(
          "h-7 w-full border-0 bg-surface pr-12 pl-3 text-text shadow-[inset_0_0_0_1.5px_var(--accent)] outline-none",
          col.numeric && (vertical ? "font-mono" : "text-right font-mono"),
        )}
      />
      {nullButton}
    </td>
  );
}
