import { useState } from "react";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import { useApp, useToast } from "../../state/app";
import type { Connection, DatabaseDef } from "../../types";
import { ReviewDialog, type ReviewState } from "../../features/routine/ReviewDialog";
import { Button, Dialog, DialogHeader, Field, Input } from "../ui";
import { useConnectionError } from "./connectionError";
import { previewErrorText } from "./PreviewList";
import { inDatabase, nextDatabaseList } from "./tree";
import { errorText, useConnect } from "./useConnect";

/**
 * After a database is created (`from` null), renamed or dropped (`to` null): updates an explicit database list on the
 * connection, closes the old database's tabs, toasts and reloads the tree (which reads the saved list).
 */
export function useDatabaseChanged() {
  const { state, dispatch } = useApp();
  const toast = useToast();
  const { loadTree } = useConnect();
  return async (conn: Connection, from: string | null, to: string | null, message: string) => {
    const database = nextDatabaseList(conn.database, from, to);
    if (database !== undefined)
      try {
        dispatch({ type: "addConnection", connection: await api.saveConnection({ ...conn, database }, {}) });
      } catch (e) {
        toast(errorText(e));
      }
    if (from !== null)
      for (const tab of state.tabs)
        if (tab.connectionId === conn.id && inDatabase(conn.driver, from, tab)) dispatch({ type: "closeTab", id: tab.id, force: true });
    toast(message);
    await loadTree(conn.id);
  };
}

/** Create a database (`from` undefined) or rename `from`: form → Review SQL → Apply on the main pool (bare conn.id). */
export function DatabaseDialog({ conn, from, onClose }: { conn: Connection; from?: string; onClose: () => void }) {
  const t = useT();
  const markLost = useConnectionError();
  const changed = useDatabaseChanged();
  const [def, setDef] = useState<DatabaseDef>({ name: from ?? "" });
  const [review, setReview] = useState<ReviewState | null>(null);
  const name = def.name.trim();
  const same = from !== undefined && name === from;
  const mysql = conn.driver === "mysql" || conn.driver === "mariadb";
  const set = (k: keyof DatabaseDef) => (e: { target: { value: string } }) => setDef((d) => ({ ...d, [k]: e.target.value }));

  const openReview = async () => {
    setReview({ busy: true });
    try {
      const opt = (s?: string) => s?.trim() || undefined;
      const preview =
        from === undefined
          ? await api.previewCreateDatabase(conn.id, { name, owner: opt(def.owner), charset: opt(def.charset), collation: opt(def.collation) })
          : await api.previewRenameDatabase(conn.id, from, name);
      setReview({ preview });
    } catch (e) {
      markLost(conn.id, e);
      setReview({ error: previewErrorText(t, e) });
    }
  };

  const apply = async () => {
    const preview = review?.preview;
    if (!preview) return;
    setReview({ preview, busy: true });
    try {
      const report = await api.applyPreview(conn.id, preview.id, true);
      if (report.failed) return setReview({ preview, report });
      setReview(null);
      onClose();
      await changed(conn, from ?? null, name, from === undefined ? t("db.created", { name }) : t("db.renamed", { from, to: name }));
    } catch (e) {
      markLost(conn.id, e);
      setReview({ preview, error: previewErrorText(t, e) });
    }
  };

  return (
    <>
      <Dialog open onClose={onClose} labelledBy="db-title" className="top-[18%] max-w-[460px]">
        <DialogHeader id="db-title" title={from === undefined ? t("db.createTitle") : t("db.renameTitle", { name: from })} onClose={onClose} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name && !same) void openReview();
          }}
        >
          <div className="flex flex-col gap-3 px-5 py-4">
            <Field label={t(from === undefined ? "db.name" : "db.newName")} error={same ? t("db.sameName") : undefined}>
              <Input mono value={def.name} onChange={set("name")} autoComplete="off" spellCheck={false} />
            </Field>
            {from === undefined && conn.driver === "postgres" && (
              <Field label={t("db.owner")} hint={t("db.optional")}>
                <Input mono value={def.owner ?? ""} onChange={set("owner")} placeholder={conn.user} autoComplete="off" spellCheck={false} />
              </Field>
            )}
            {from === undefined && mysql && (
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("db.charset")} hint={t("db.optional")}>
                  <Input mono value={def.charset ?? ""} onChange={set("charset")} placeholder={t("db.serverDefault")} spellCheck={false} />
                </Field>
                <Field label={t("db.collation")} hint={t("db.optional")}>
                  <Input mono value={def.collation ?? ""} onChange={set("collation")} placeholder={t("db.serverDefault")} spellCheck={false} />
                </Field>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
            <Button variant="outline" size="lg" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant={conn.env === "prod" ? "danger" : "primary"} size="lg" disabled={!name || same}>
              {t("db.review")}
            </Button>
          </div>
        </form>
      </Dialog>
      <ReviewDialog
        id="db-review"
        title={from === undefined ? t("db.reviewCreate", { name }) : t("db.reviewRename", { from, to: name })}
        state={review}
        prod={conn.env === "prod"}
        onApply={() => void apply()}
        onClose={() => setReview(null)}
      />
    </>
  );
}
