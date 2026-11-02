import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useT } from "../../i18n";
import { isApiError } from "../../lib/api";
import type { Connection } from "../../types";
import { Button, Dialog } from "../../components/ui";

/** Thrown when the user cancels the production confirmation (callers just stop). */
export class Cancelled extends Error {}

/**
 * Runs a Redis write; on `needsConfirmation` (production) shows the exact commands and runs it again
 * with `confirmed` once the user agrees. Render `dialog` somewhere in the tab.
 */
export function useProdConfirm(conn: Connection) {
  const t = useT();
  const [pending, setPending] = useState<{ lines: string[]; resolve: (ok: boolean) => void } | null>(null);
  const answer = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  const run = async <T,>(fn: (confirmed: boolean) => Promise<T>): Promise<T> => {
    try {
      return await fn(false);
    } catch (e) {
      if (!isApiError(e, "needsConfirmation")) throw e;
      const ok = await new Promise<boolean>((resolve) => setPending({ lines: e.detail ?? [], resolve }));
      if (!ok) throw new Cancelled();
      return fn(true);
    }
  };
  const dialog = (
    <Dialog open={!!pending} onClose={() => answer(false)} labelledBy="kv-confirm" className="top-[20%] max-w-[560px] border-prod!">
      <div className="flex items-center gap-2 bg-prod-bg px-5 py-3.5 text-prod">
        <TriangleAlert size={16} aria-hidden="true" />
        <h1 id="kv-confirm" className="m-0 text-[15px] font-semibold">
          {t("kv.confirm.title")}
        </h1>
      </div>
      <div className="px-5 pt-4 pb-1">
        <p className="m-0 text-muted">{t("kv.confirm.body", { name: conn.name })}</p>
        <pre className="mt-3 mb-0 max-h-64 overflow-auto rounded-lg border border-border bg-bg px-3 py-2.5 font-mono text-[11.5px] leading-[19px] whitespace-pre-wrap">
          {pending?.lines.join("\n")}
        </pre>
      </div>
      <div className="flex justify-end gap-2 px-5 py-3.5">
        <Button variant="outline" size="lg" onClick={() => answer(false)}>
          {t("common.cancel")}
        </Button>
        <Button variant="danger" size="lg" onClick={() => answer(true)}>
          {t("kv.confirm.run")}
        </Button>
      </div>
    </Dialog>
  );
  return { run, dialog };
}
