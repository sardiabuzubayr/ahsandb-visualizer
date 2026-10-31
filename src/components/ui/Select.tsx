import type { SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./index";

// Native <select> styled like Input.
export function Select({
  className,
  compact,
  mono,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { compact?: boolean; mono?: boolean }) {
  return (
    <span className={cn("relative block min-w-0", className)}>
      <select
        className={cn(
          "w-full appearance-none border border-border-strong bg-surface pr-7 pl-2.5 text-text outline-none focus:border-accent disabled:text-faint",
          compact ? "h-[30px] rounded-md" : "h-[34px] rounded-[7px]",
          mono && "font-mono text-[12.5px]",
        )}
        {...rest}
      />
      <ChevronDown size={12} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-faint" />
    </span>
  );
}
