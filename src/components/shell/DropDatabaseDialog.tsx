import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import type { ApplyReport, Connection, Preview, SchemaNode } from "../../types";
import { Button, Checkbox, Dialog, DialogHeader, Field, Input } from "../ui";
import { useConnectionError } from "./connectionError";
import { useDatabaseChanged } from "./DatabaseDialog";
import { PreviewList, previewErrorText } from "./PreviewList";
import { dropDatabaseConfirmed, formatBytes } from "./tree";

/** "Drop database?" with the backend's preview, size and a double confirm: a checkbox plus typing the exact name. */
export function DropDatabaseDialog({ node, conn, onClose }: { node: SchemaNode; conn: Connection; onClose: () => void }) {
  const t = useT();
  const markLost = useConnectionError();
  const changed = useDatabaseChanged();
  const name = node.label;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [report, setReport] = useState<ApplyReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [understood, setUnderstood] = useState(false);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    let live = true;
    // Database DDL runs on the main pool: the bare connection id.
    api.previewDropDatabase(conn.id, name).then(
      (p) => live && (setPreview(p), setBusy(false)),
      (e: unknown) => live && (markLost(conn.id, e), setError(previewErrorText(t, e)), setBusy(false)),
    );
    return () => void (live = false);
  }, [conn.id, name]); // t/markLost are stable enough

  const drop = async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.applyPreview(conn.id, preview.id, true);
      if (r.failed) return setReport(r);
      onClose();
      await changed(conn, name, null, t("dropDb.done", { name }));
    } catch (e) {
      markLost(conn.id, e);
      setError(previewErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const ready = !!preview && !report?.failed && !busy && dropDatabaseConfirmed(name, understood, typed);
  return (
    <Dialog open onClose={onClose} labelledBy="drop-db-title" className="top-[12%] max-w-[560px] border-prod!">
      <DialogHeader id="drop-db-title" title={t("dropDb.title", { name })} onClose={onClose} />
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-auto px-5 py-4">
        <p className="m-0 text-muted">{t("dropDb.body")}</p>
        {node.size !== undefined && <p className="m-0 font-mono text-xs text-text">{t("dropDb.size", { size: formatBytes(node.size) })}</p>}
        {preview && <PreviewList preview={preview} report={report} />}
        {busy && !preview && (
          <p role="status" className="m-0 flex items-center gap-2 text-muted">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            {t("preview.loading")}
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 break-words text-prod">
            {error}
          </p>
        )}
        {preview && (
          <div className="flex flex-col gap-3 rounded-lg border border-prod bg-prod-bg px-3 py-3">
            <div className="flex items-start gap-2.5">
              <Checkbox state={understood ? "on" : "off"} onChange={() => setUnderstood((u) => !u)} label={t("dropDb.understand", { name })} />
              <span aria-hidden="true" className="cursor-default text-text" onClick={() => setUnderstood((u) => !u)}>
                {t("dropDb.understand", { name })}
              </span>
            </div>
            <Field label={t("dropDb.type", { name })}>
              <Input mono value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={!!typed && typed !== name} />
            </Field>
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
        <Button variant="outline" size="lg" onClick={onClose}>
          {t(report?.failed ? "common.close" : "common.cancel")}
        </Button>
        <Button variant="danger" size="lg" disabled={!ready} onClick={() => void drop()}>
          {t("dropDb.confirm")}
        </Button>
      </div>
    </Dialog>
  );
}
