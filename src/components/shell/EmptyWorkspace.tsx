import type { ReactNode } from "react";
import { useT } from "../../i18n";
import { Kbd } from "../ui";

export function EmptyWorkspace() {
  const t = useT();
  const rows: [string, string][] = [
    ["⌘K", t("empty.palette")],
    ["⌘T", t("empty.newSql")],
    ["⌘J", t("empty.agent")],
  ];
  return (
    <div className="grid h-full place-items-center">
      <div className="flex w-[320px] flex-col gap-4 text-center">
        <div>
          <h2 className="m-0 text-[15px] font-semibold">{t("empty.title")}</h2>
          <p className="mt-1 mb-0 text-muted">{t("empty.body")}</p>
        </div>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map(([k, label]) => (
            <li key={k} className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2">
              <span>{label}</span>
              <Kbd>{k}</Kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** `children`: extra toasts with their own controls (they set pointer-events-auto). */
export function ToastHost({ toasts, children }: { toasts: { id: number; text: string }[]; children?: ReactNode }) {
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-10 z-50 flex flex-col gap-2">
      {toasts.map((x) => (
        <div key={x.id} className="rounded-lg border border-border-strong bg-raised px-3.5 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,.4)]">
          {x.text}
        </div>
      ))}
      {children}
    </div>
  );
}
