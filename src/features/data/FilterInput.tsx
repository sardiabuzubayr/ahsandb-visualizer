import { useId, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useT } from "../../i18n";
import type { Column, Driver } from "../../types";
import { cn } from "../../components/ui";
import { quoteIdent } from "../../components/shell/tree";
import { suggest, unknownColumns, wordAt } from "./filterAssist";

/**
 * The table tab's WHERE filter: suggests column names for the word being typed (↑↓ to pick, Enter/Tab
 * to insert) and, on Enter, warns about names that aren't columns; Enter again applies it anyway.
 */
export function FilterInput({
  value,
  columns,
  driver,
  onChange,
  onApply,
  onCancel,
}: {
  value: string;
  columns: Column[];
  driver: Driver;
  onChange: (v: string) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  const id = useId();
  const [caret, setCaret] = useState(value.length);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false); // Escape hides the list until the next keystroke
  const [warned, setWarned] = useState<{ text: string; names: string[] } | null>(null);
  const names = columns.map((c) => c.name);
  const at = wordAt(value, caret);
  const options = at && !closed ? suggest(at.word, names) : [];
  const pick = Math.min(active, options.length - 1);

  const insert = (name: string) => {
    if (!at) return;
    const text = /^[a-z_][a-z0-9_]*$/.test(name) ? name : quoteIdent(driver, name);
    const next = value.slice(0, at.start) + text + value.slice(caret);
    const pos = at.start + text.length;
    onChange(next);
    setCaret(pos);
    requestAnimationFrame(() => ref.current?.setSelectionRange(pos, pos));
  };
  const submit = () => {
    const unknown = unknownColumns(value, names);
    // A second Enter on the same text applies it: the check is a heuristic and can be wrong.
    if (unknown.length && warned?.text !== value) setWarned({ text: value, names: unknown });
    else onApply();
  };

  return (
    <span className="relative flex min-w-[280px] flex-[0_1_420px]">
      <input
        ref={ref}
        autoFocus
        role="combobox"
        aria-expanded={options.length > 0}
        aria-controls={`${id}-list`}
        aria-activedescendant={options.length ? `${id}-${pick}` : undefined}
        aria-label={t("data.filterLabel")}
        placeholder={t("data.filterPlaceholder")}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setActive(0);
          setClosed(false);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? value.length)}
        onKeyDown={(e) => {
          if (options.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setActive((pick + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
          } else if (options.length && (e.key === "Enter" || e.key === "Tab")) {
            e.preventDefault();
            insert(options[pick]);
          } else if (e.key === "Enter") submit();
          else if (e.key === "Escape") options.length ? setClosed(true) : onCancel();
        }}
        onBlur={onCancel}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className={cn(
          "h-[26px] w-full rounded-md border bg-surface px-2.5 font-mono text-xs outline-none",
          warned?.text === value ? "border-prod" : "border-accent",
        )}
      />
      {options.length > 0 && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={t("data.filterColumns")}
          className="absolute top-full left-0 z-20 m-0 mt-1 max-h-64 min-w-[240px] list-none overflow-auto rounded-lg border border-border-strong bg-panel p-1 text-xs shadow-lg"
        >
          {options.map((name, i) => (
            <li
              key={name}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === pick}
              // mousedown, not click: the input would blur (and close) first.
              onMouseDown={(e) => (e.preventDefault(), insert(name))}
              onMouseEnter={() => setActive(i)}
              className={cn("flex cursor-pointer justify-between gap-4 rounded px-2 py-1", i === pick && "bg-[var(--accent-sel)]")}
            >
              <span className="truncate font-mono">{name}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-faint">{columns.find((c) => c.name === name)?.type}</span>
            </li>
          ))}
        </ul>
      )}
      {warned?.text === value && !options.length && (
        <p
          role="alert"
          className="absolute top-full left-0 z-20 m-0 mt-1 flex min-w-[280px] items-start gap-2 rounded-lg border border-prod bg-panel px-2.5 py-2 text-xs text-prod shadow-lg"
        >
          <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
          <span>{t("data.filterUnknown", { names: warned.names.join(", ") })}</span>
        </p>
      )}
    </span>
  );
}
