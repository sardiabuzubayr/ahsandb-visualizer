import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import { scopedId } from "../../lib/scope";
import { useApp, useToast } from "../../state/app";
import type { ApplyReport, Connection, Preview, SchemaNode } from "../../types";
import { defaultSchema } from "../../features/data/table";
import { Button, Dialog, DialogHeader } from "../ui";
import { PreviewList, previewErrorText } from "./PreviewList";
import { closesOnDrop, dropKind, tabDatabase } from "./tree";
import { useConnect } from "./useConnect";

/** "Drop <kind>?" with the backend's DROP preview; Drop applies it, reloads the tree and closes the object's tabs. */
export function DropDialog({ node, conn, onClose }: { node: SchemaNode; conn: Connection; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const { state, dispatch } = useApp();
  const { loadTree } = useConnect();
  const kind = dropKind(node);
  const schema = node.schema ?? defaultSchema(conn);
  const database = tabDatabase(conn.driver, node);
  const id = scopedId(conn.id, database);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [report, setReport] = useState<ApplyReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let live = true;
    api.previewDrop(id, kind, schema, node.label).then(
      (p) => live && (setPreview(p), setBusy(false)),
      (e: unknown) => live && (setError(previewErrorText(t, e)), setBusy(false)),
    );
    return () => void (live = false);
  }, [id, kind, schema, node.label]); // t is stable enough; a language switch mid-dialog keeps the old text

  const drop = async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.applyPreview(id, preview.id, true);
      if (r.failed) return setReport(r);
      for (const tab of state.tabs)
        if (tab.connectionId === conn.id && tab.database === database && closesOnDrop(node, schema, tab)) dispatch({ type: "closeTab", id: tab.id, force: true });
      toast(t("drop.done", { name: node.label }));
      onClose();
      void loadTree(conn.id);
    } catch (e) {
      setError(previewErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} labelledBy="drop-title" className="top-[18%] max-w-[560px]">
      <DialogHeader id="drop-title" title={t(`drop.title${kind[0].toUpperCase()}${kind.slice(1)}`, { name: node.label })} onClose={onClose} />
      <div className="flex max-h-[50vh] flex-col gap-3 overflow-auto px-5 py-4">
        <p className="m-0 text-muted">{t("drop.body")}</p>
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
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
        <Button variant="outline" size="lg" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button variant="danger" size="lg" disabled={!preview || busy} onClick={() => void drop()}>
          {t("drop.confirm")}
        </Button>
      </div>
    </Dialog>
  );
}
