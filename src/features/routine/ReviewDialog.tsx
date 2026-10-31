import { Button, Dialog, DialogHeader } from "../../components/ui";
import { PreviewList } from "../../components/shell/PreviewList";
import { useT } from "../../i18n";
import type { ApplyReport, Preview } from "../../types";

/** Review step of preview → apply; null = closed. Shared by the routine and roles tabs. */
export interface ReviewState {
  busy?: boolean;
  preview?: Preview;
  report?: ApplyReport;
  error?: string;
}

export function ReviewDialog({
  id,
  title,
  state,
  prod,
  onApply,
  onClose,
}: {
  id: string;
  title: string;
  state: ReviewState | null;
  prod: boolean;
  onApply: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const p = state?.preview;
  const failed = !!state?.report?.failed;
  return (
    <Dialog open={!!state} onClose={onClose} labelledBy={id} className={p?.destructive ? "top-[12%] max-w-[640px] border-prod!" : "top-[12%] max-w-[640px]"}>
      <DialogHeader id={id} title={title} onClose={onClose} />
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-auto px-5 py-4">
        {!p && state?.busy && <p className="m-0 text-muted">{t("routine.review.generating")}</p>}
        {p && <PreviewList preview={p} report={state?.report} />}
        {state?.error && (
          <p role="alert" className="m-0 rounded-lg bg-prod-bg px-3 py-2 text-xs whitespace-pre-wrap text-prod">
            {state.error}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
        <Button variant="outline" size="lg" onClick={onClose}>
          {t(failed ? "common.close" : "common.cancel")}
        </Button>
        <Button
          variant={prod || p?.destructive ? "danger" : "primary"}
          size="lg"
          disabled={!p || p.statements.length === 0 || state?.busy || failed}
          onClick={onApply}
        >
          {t(p && state?.busy ? "routine.review.applying" : "routine.review.apply")}
        </Button>
      </div>
    </Dialog>
  );
}
