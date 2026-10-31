import { useCallback } from "react";
import { isApiError } from "../../lib/api";
import { useApp } from "../../state/app";

/** True when the error means the connection itself is gone (server down, tunnel dropped, pool closed). */
export function isConnectionError(e: unknown): boolean {
  return isApiError(e, "connection") || (isApiError(e, "notFound") && e.message === "Not connected");
}

/** Returns `(id, err) => boolean`: marks the connection disconnected on a connection error; true = it did. */
export function useConnectionError() {
  const { dispatch } = useApp();
  return useCallback(
    (id: string, e: unknown) => {
      if (!isConnectionError(e)) return false;
      dispatch({ type: "setConnected", id, connected: false });
      dispatch({ type: "setTree", id, tree: null });
      return true;
    },
    [dispatch],
  );
}
