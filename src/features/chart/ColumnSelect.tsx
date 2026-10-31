import { ChevronDown } from "lucide-react";
import type { Column } from "../../types";
import { cn } from "../../components/ui";

/** Native select with an optional color swatch and the column type on the right. */
export function ColumnSelect({
  value,
  onChange,
  columns,
  noneLabel,
  swatch,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  columns: Column[];
  /** Adds an empty "none" option with this text. */
  noneLabel?: string;
  /** CSS color for the series swatch. */
  swatch?: string;
  /** Accessible name when not wrapped in a <Field>. */
  label?: string;
}) {
  const type = columns.find((c) => c.name === value)?.type;
  return (
    <span className="relative block">
      {swatch && (
        <span aria-hidden="true" className="absolute top-3 left-2.5 size-2 rounded-[2px]" style={{ background: swatch }} />
      )}
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "h-8 w-full appearance-none truncate rounded-[7px] border border-border-strong bg-surface pr-24 text-text outline-none focus:border-accent",
          swatch ? "pl-6" : "pl-2.5",
          !value && "text-muted",
        )}
      >
        {noneLabel !== undefined && <option value="">{noneLabel}</option>}
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center gap-2 text-faint">
        {type && <span className="font-mono text-[10.5px]">{type}</span>}
        <ChevronDown size={12} aria-hidden="true" />
      </span>
    </span>
  );
}
