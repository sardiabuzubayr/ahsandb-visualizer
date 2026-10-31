import { useSyncExternalStore } from "react";
import type { TFn } from "../../i18n";
import { api } from "../../lib/api";
import { scopedId } from "../../lib/scope";
import { useApp, useToast } from "../../state/app";
import type { SchemaNode } from "../../types";
import { useConnectionError } from "./connectionError";
import { hostKeyStep, withHostKey } from "./hostKey";
import { reloadedDatabases } from "./tree";

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Saved folder names are user text; known ones ("Production", …) get a translation. */
export function folderLabel(t: TFn, folder: string): string {
  const key = `folder.${folder}`;
  const s = t(key);
  return s === key ? folder : s;
}

// Ids with a connect in flight, shared so the sidebar spinner shows whoever started it (sidebar, dialog, palette).
let connecting = new Set<string>();
const listeners = new Set<() => void>();
const setConnecting = (id: string, on: boolean) => {
  connecting = new Set(connecting);
  if (on) connecting.add(id);
  else connecting.delete(id);
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** Lazy database node being loaded, or the error text of its last load. */
export type DbStatus = "loading" | { error: string };
// By node id ("<connId>/<database>"), shared so a refresh started anywhere shows in the sidebar.
let dbStatus: Record<string, DbStatus> = {};
const setDbStatus = (update: (s: Record<string, DbStatus>) => void) => {
  dbStatus = { ...dbStatus };
  update(dbStatus);
  listeners.forEach((l) => l());
};

/** Connect/disconnect + navigator tree loading, shared by the sidebar, connection dialog and palette. */
export function useConnect() {
  const { state, dispatch } = useApp();
  const toast = useToast();
  const busy = useSyncExternalStore(subscribe, () => connecting);
  const databases = useSyncExternalStore(subscribe, () => dbStatus);
  const markLost = useConnectionError();

  /** Loads a lazy database node's objects into the tree (the backend returns it with the same id). */
  const loadDatabase = async (connId: string, n: SchemaNode) => {
    setDbStatus((s) => void (s[n.id] = "loading"));
    try {
      const [node] = await api.schemaTree(scopedId(connId, n.label));
      dispatch({ type: "setDatabaseNode", id: connId, node });
      setDbStatus((s) => void delete s[n.id]);
    } catch (e) {
      setDbStatus((s) => void delete s[n.id]);
      if (markLost(connId, e)) return toast(errorText(e));
      setDbStatus((s) => void (s[n.id] = { error: errorText(e) }));
    }
  };

  const loadTree = async (id: string) => {
    const prev = state.trees[id];
    dispatch({ type: "setTree", id, tree: { status: "loading" } });
    setDbStatus((s) => Object.keys(s).forEach((k) => k.startsWith(`${id}/`) && delete s[k]));
    let nodes: SchemaNode[];
    try {
      nodes = await api.schemaTree(id);
    } catch (e) {
      if (markLost(id, e)) return toast(errorText(e));
      return dispatch({ type: "setTree", id, tree: { status: "error", message: errorText(e) } });
    }
    dispatch({ type: "setTree", id, tree: { status: "ready", nodes } });
    // Databases loaded before the refresh come back lazy; load them again, leaving open/closed as it was.
    await Promise.all(reloadedDatabases(prev?.status === "ready" ? prev.nodes : undefined, nodes).map((n) => loadDatabase(id, n)));
  };

  const connect = async (id: string) => {
    if (connecting.has(id)) return;
    setConnecting(id, true);
    try {
      const { serverVersion } = await withHostKey(() => api.connect(id));
      dispatch({ type: "setConnected", id, connected: true, serverVersion });
    } catch (e) {
      // Host-key errors were already explained by the host-key dialog.
      if (!hostKeyStep(e)) toast(errorText(e));
      return;
    } finally {
      setConnecting(id, false);
    }
    await loadTree(id);
  };

  const disconnect = async (id: string) => {
    try {
      await api.disconnect(id);
    } catch (e) {
      toast(errorText(e));
    }
    dispatch({ type: "setConnected", id, connected: false });
    dispatch({ type: "setTree", id, tree: null });
  };

  return {
    connect,
    disconnect,
    loadTree,
    loadDatabase,
    dbStatus: (nodeId: string): DbStatus | undefined => databases[nodeId],
    isConnecting: (id: string) => busy.has(id),
  };
}
