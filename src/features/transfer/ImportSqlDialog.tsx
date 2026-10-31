import { useState } from "react";
import { FileCode, FileUp } from "lucide-react";
import { useI18n } from "../../i18n";
import { api } from "../../lib/api";
import { onJobFinished, trackJob, useJob } from "../../lib/jobs";
import { scopedId } from "../../lib/scope";
import { errorText, useConnect } from "../../components/shell/useConnect";
import { useApp } from "../../state/app";
import { Button, Dialog, DialogHeader, EnvDot } from "../../components/ui";
import type { OnError } from "../../types";
import { ImportJobView, ProdConfirm } from "./ImportJobView";
import { baseName, pickFile } from "./importData";

const MOCK_PATH = "~/Downloads/orders_db-2026-10-30.sql.gz";

/** Runs a .sql / .sql.gz file against the connection (database from dialogContext) as a background job. */
export function ImportSqlDialog() {
  const { t } = useI18n();
  const { state, dispatch } = useApp();
  const { loadTree } = useConnect();
  const ctx = state.dialogContext ?? {};
  const conn = state.connections.find((c) => c.id === (state.editingConnectionId ?? state.activeConnectionId)) ?? state.connections[0];
  const sid = scopedId(conn.id, ctx.database);
  const prod = conn.env === "prod";
  const where = [ctx.database ?? conn.database ?? conn.file, ctx.schema].filter(Boolean).join("/");

  const [path, setPath] = useState<string | null>(null);
  const [onError, setOnError] = useState<OnError>("stop");
  const [confirmed, setConfirmed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const close = () => dispatch({ type: "closeDialog" });
  const fileName = path ? baseName(path) : "";

  const choose = async () => {
    try {
      const p = await pickFile("SQL", ["sql", "gz"], MOCK_PATH);
      if (p) setPath(p);
    } catch (e) {
      setErr(errorText(e));
    }
  };

  const start = async () => {
    if (!path) return;
    setBusy(true);
    setErr(null);
    try {
      const id = await api.importSql(sid, { path, onError }, prod && confirmed);
      trackJob(id, `Import SQL ${fileName} → ${conn.name}`, conn.id, "statements");
      // Statements may have created or dropped objects: refresh the navigator, even after the dialog is closed.
      const off = onJobFinished((j) => {
        if (j.id !== id) return;
        off();
        void loadTree(conn.id);
      });
      setJobId(id);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const result = job?.result;
  const ready = !!path && (!prod || confirmed) && !conn.readOnly && !busy;

  return (
    <Dialog open onClose={close} labelledBy="isql-title" className="max-h-[min(760px,calc(100vh-60px))] max-w-[640px] open:flex open:flex-col">
      <DialogHeader id="isql-title" title={t("importSql.title")} onClose={close}>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <EnvDot env={conn.env} />
          <span className="truncate">{[conn.name, where].filter(Boolean).join(" · ")}</span>
        </span>
      </DialogHeader>

      <div className="flex min-h-0 flex-auto flex-col *:shrink-0 gap-4 overflow-auto px-5 py-[18px]">
        {jobId ? (
          <ImportJobView job={job} unit="importSql" detail title={t("importSql.running", { file: fileName })} />
        ) : (
          <>
            {path ? (
              <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5">
                <FileCode size={16} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12.5px]">{fileName}</span>
                  <span className="block truncate text-xs text-muted" title={path}>
                    {path}
                  </span>
                </span>
                <Button variant="outline" size="sm" className="h-7" onClick={choose}>
                  {t("common.change")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-10 text-center">
                <FileUp size={22} strokeWidth={1.8} className="text-muted" aria-hidden="true" />
                <div>
                  <div className="font-medium">{t("importSql.pickTitle")}</div>
                  <div className="mt-0.5 text-xs text-muted">{t("import.pickHint")}</div>
                </div>
                <Button variant="primary" size="lg" onClick={choose}>
                  {t("import.chooseFile")}
                </Button>
              </div>
            )}

            <fieldset className="m-0 rounded-lg border border-border px-3.5 pt-1 pb-3">
              <legend className="px-1.5 text-xs text-muted">{t("importSql.onError")}</legend>
              {(["stop", "skip"] as const).map((p) => (
                <label key={p} className="flex cursor-pointer items-start gap-2.5 py-1.5">
                  <input type="radio" name="isql-onerror" checked={onError === p} onChange={() => setOnError(p)} className="mt-[3px] accent-accent" />
                  <span>
                    <span className="block font-medium">{t(`importSql.policy.${p}`)}</span>
                    <span className="block text-xs text-muted">{t(`importSql.policy.${p}.hint`)}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {prod && <ProdConfirm conn={conn} checked={confirmed} onChange={setConfirmed} />}
            {[conn.readOnly && t("import.readOnly", { conn: conn.name }), err].filter(Boolean).map((e) => (
              <p key={String(e)} role="alert" className="m-0 rounded-lg bg-prod-bg px-3 py-2 text-xs whitespace-pre-wrap text-prod">
                {e}
              </p>
            ))}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-border px-5 py-3.5">
        <span className="min-w-[220px] flex-1 text-[12.5px] text-muted">{!result && t(jobId ? "import.closeHint" : "import.background")}</span>
        {!jobId && (
          <>
            <Button variant="ghost" size="lg" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button variant={prod ? "danger" : "primary"} size="lg" className="font-semibold" disabled={!ready} onClick={start}>
              {t("importSql.run")}
            </Button>
          </>
        )}
        {jobId &&
          (result ? (
            <Button variant="primary" size="lg" className="font-semibold" onClick={close}>
              {t("import.doneButton")}
            </Button>
          ) : (
            <>
              <Button variant="outline" size="lg" onClick={() => void api.cancelJob(jobId)}>
                {t("import.cancel")}
              </Button>
              <Button variant="ghost" size="lg" onClick={close}>
                {t("common.close")}
              </Button>
            </>
          ))}
      </div>
    </Dialog>
  );
}
