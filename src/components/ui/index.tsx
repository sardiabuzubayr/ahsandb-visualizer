import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { Check, Loader2, Minus } from "lucide-react";
import type { Driver, Env } from "../../types";
import { useT } from "../../i18n";
import mariadbLogo from "../../assets/db/mariadb.svg";
import mysqlLogo from "../../assets/db/mysql.svg";
import postgresLogo from "../../assets/db/postgresql.svg";
import redisLogo from "../../assets/db/redis.svg";
import sqliteLogo from "../../assets/db/sqlite.svg";

export function cn(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

/* ---------- Buttons ---------- */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-on-accent font-medium border border-transparent hover:brightness-110",
  secondary: "bg-surface border border-border-strong text-text hover:bg-raised",
  outline: "bg-transparent border border-border-strong text-text hover:bg-raised",
  ghost: "bg-transparent border border-transparent text-muted hover:bg-raised hover:text-text",
  danger: "bg-prod text-on-danger font-semibold border border-transparent hover:brightness-110",
};
const sizes: Record<Size, string> = {
  sm: "h-[26px] px-2 text-xs gap-1.5 rounded-md",
  md: "h-7 px-2.5 gap-1.5 rounded-md",
  lg: "h-8 px-3.5 gap-2 rounded-[7px]",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    />
  );
}

/** Icon-only button; `label` is required so it always has an accessible name. */
export function IconButton({
  label,
  className,
  size = 26,
  active,
  type = "button",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & { label: string; size?: number; active?: boolean }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      style={{ width: size, height: size }}
      className={cn(
        "grid shrink-0 place-items-center rounded-md border-0 disabled:opacity-40",
        active ? "bg-raised text-text" : "bg-transparent text-muted hover:bg-raised hover:text-text",
        className,
      )}
      {...rest}
    />
  );
}

/* ---------- Inputs ---------- */

export function Input({ mono, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return (
    <input
      className={cn(
        "h-[34px] w-full min-w-0 rounded-[7px] border border-border-strong bg-surface px-2.5 text-text outline-none placeholder:text-faint focus:border-accent",
        mono && "font-mono text-[12.5px]",
        className,
      )}
      {...rest}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("block min-w-0", className)}>
      <span className="mb-1.5 flex justify-between gap-2 text-xs text-muted">
        <span>{label}</span>
        {hint && <span className="truncate text-faint">{hint}</span>}
      </span>
      {children}
      {error && <span className="mt-1 block text-xs text-prod">{error}</span>}
    </label>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("text-[11px] font-semibold uppercase tracking-[.06em] text-muted", className)}>{children}</div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex h-5 w-[34px] shrink-0 rounded-[10px] border p-0.5",
        checked ? "justify-end border-accent bg-accent" : "justify-start border-border-strong bg-raised",
      )}
    >
      <span className={cn("rounded-full", checked ? "size-[14px] bg-on-accent" : "size-[14px] bg-muted")} />
    </button>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-fit rounded-[7px] border border-border bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-[5px] px-3",
            size === "sm" ? "h-6" : "h-7",
            o.value === value ? "bg-raised text-text" : "text-muted hover:text-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type CheckState = "on" | "off" | "mixed";

export function Checkbox({
  state,
  onChange,
  label,
  mark,
  size = 18,
}: {
  state: CheckState;
  onChange?: () => void;
  label: string;
  /** Pending change ring: grant (accent) or revoke (prod). */
  mark?: "grant" | "revoke";
  size?: number;
}) {
  const filled = state !== "off";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "mixed" ? "mixed" : state === "on"}
      aria-label={label}
      title={label}
      onClick={onChange}
      style={{ width: size, height: size }}
      className={cn(
        "grid shrink-0 place-items-center rounded border-[1.5px] p-0",
        filled ? "border-accent bg-accent text-on-accent" : mark === "revoke" ? "border-prod" : "border-border-strong",
        mark === "grant" && "shadow-[0_0_0_3px_var(--accent-ring)]",
        mark === "revoke" && "shadow-[0_0_0_3px_var(--prod-ring)]",
      )}
    >
      {state === "on" && <Check size={size - 7} strokeWidth={3.2} />}
      {state === "mixed" && <Minus size={size - 7} strokeWidth={3.2} />}
    </button>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("rounded border border-border-strong px-1 font-mono text-[11px] leading-4 text-muted", className)}>
      {children}
    </span>
  );
}

/** Quiet placeholder while a lazily loaded screen's code arrives. */
export function Loading({ className }: { className?: string }) {
  const t = useT();
  return (
    <div role="status" aria-label={t("common.loading")} className={cn("grid h-full place-items-center text-muted", className)}>
      <Loader2 size={14} className="animate-spin" aria-hidden="true" />
    </div>
  );
}

/* ---------- Environment & database identity ---------- */

const envStyle: Record<Env, string> = {
  prod: "text-prod bg-prod-bg",
  staging: "text-stg bg-stg-bg",
  dev: "text-dev bg-dev-bg",
};
const envDot: Record<Env, string> = { prod: "bg-prod", staging: "bg-stg", dev: "bg-dev" };
export const envStripe: Record<Env, string> = { prod: "var(--prod)", staging: "var(--stg)", dev: "var(--dev)" };

export function EnvBadge({ env }: { env: Env }) {
  const t = useT();
  return (
    <span className={cn("rounded px-1.5 py-px text-[10px] font-semibold tracking-[.04em]", envStyle[env])}>
      {t(`env.short.${env}`)}
    </span>
  );
}

export function EnvDot({ env, className }: { env: Env; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-[7px] shrink-0 rounded-full", envDot[env], className)} />;
}

// Logos and brand colors from Simple Icons (CC0); the marks are trademarks of their owners.
export const DB_META: Record<Driver, { logo: string; name: string; bg: string; port?: number }> = {
  postgres: { logo: postgresLogo, name: "PostgreSQL", bg: "#4169E1", port: 5432 },
  mysql: { logo: mysqlLogo, name: "MySQL", bg: "#4479A1", port: 3306 },
  mariadb: { logo: mariadbLogo, name: "MariaDB", bg: "#003545", port: 3306 },
  sqlite: { logo: sqliteLogo, name: "SQLite", bg: "#003B57" },
  redis: { logo: redisLogo, name: "Redis", bg: "#FF4438", port: 6379 },
};

export function DbIcon({ driver, size = 18 }: { driver: Driver; size?: 16 | 18 | 32 }) {
  const m = DB_META[driver];
  return (
    <span
      role="img"
      aria-label={m.name}
      className="grid shrink-0 place-items-center"
      style={{ width: size, height: size, borderRadius: size === 32 ? 8 : size === 18 ? 5 : 4, background: m.bg }}
    >
      <img src={m.logo} alt="" draggable={false} style={{ width: size * 0.72, height: size * 0.72 }} />
    </span>
  );
}

/* ---------- Dialog ---------- */

export function Dialog({
  open,
  onClose,
  labelledBy,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Start on the first form field rather than the close button.
      d.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea")?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cn(
        "fixed top-11 left-1/2 m-0 w-[calc(100%-32px)] -translate-x-1/2 overflow-hidden rounded-xl border border-border-strong bg-panel text-text shadow-[0_24px_64px_rgba(0,0,0,.55)]",
        className,
      )}
    >
      {open && children}
    </dialog>
  );
}

export function DialogHeader({ id, title, onClose, children }: { id: string; title: ReactNode; onClose: () => void; children?: ReactNode }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 border-b border-border px-5 py-4">
      <h1 id={id} className="m-0 text-[15px] font-semibold">
        {title}
      </h1>
      {children}
      <span className="flex-1" />
      <IconButton label={t("common.close")} size={28} onClick={onClose}>
        <XIcon />
      </IconButton>
    </div>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/* ---------- Popover menu ---------- */

export function Menu({
  trigger,
  items,
  align = "left",
}: {
  trigger: (props: { onClick: () => void; "aria-expanded": boolean; "aria-haspopup": "menu" }) => ReactNode;
  items: { key: string; label: ReactNode; onSelect: () => void; disabled?: boolean }[];
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      {trigger({ onClick: () => setOpen((o) => !o), "aria-expanded": open, "aria-haspopup": "menu" })}
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute top-full z-50 mt-1 min-w-48 rounded-lg border border-border-strong bg-panel p-1 shadow-[0_12px_32px_rgba(0,0,0,.45)]",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {items.map((i) => (
            <button
              key={i.key}
              type="button"
              role="menuitem"
              disabled={i.disabled}
              onClick={() => {
                setOpen(false);
                i.onSelect();
              }}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left hover:bg-raised disabled:opacity-50"
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
