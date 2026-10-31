import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import { useApp } from "../../state/app";
import { Button, IconButton } from "../ui";
import { useConnect } from "./useConnect";

/**
 * Listens for SSH tunnel drops (once, mounted in App): marks the connection disconnected and shows a toast with
 * Reconnect. Kept here because the shared toasts are text-only; rendered inside ToastHost so they stack together.
 */
export function ConnectionLostToasts() {
  const t = useT();
  const { state, dispatch } = useApp();
  const { connect } = useConnect();
  const [lost, setLost] = useState<{ id: string; message: string }[]>([]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let live = true;
    void api
      .onConnectionLost((e) => {
        dispatch({ type: "setConnected", id: e.id, connected: false });
        dispatch({ type: "setTree", id: e.id, tree: null });
        setLost((l) => [...l.filter((x) => x.id !== e.id), e]);
      })
      .then((u) => (live ? (off = u) : u()));
    return () => {
      live = false;
      off?.();
    };
  }, [dispatch]);

  // A toast goes away once its connection is back (or deleted), however that happened.
  useEffect(() => {
    setLost((l) => {
      const next = l.filter((x) => state.connections.some((c) => c.id === x.id && !c.connected));
      return next.length === l.length ? l : next;
    });
  }, [state.connections]);

  const dismiss = (id: string) => setLost((l) => l.filter((x) => x.id !== id));

  return lost.map((x) => {
    const name = state.connections.find((c) => c.id === x.id)?.name ?? x.id;
    return (
      <div
        key={x.id}
        role="alert"
        className="pointer-events-auto flex max-w-[420px] items-center gap-3 rounded-lg border border-border-strong bg-raised py-2 pr-2 pl-3.5 shadow-[0_8px_24px_rgba(0,0,0,.4)]"
      >
        <span className="min-w-0 flex-1 break-words">{t("lost.text", { name, message: x.message })}</span>
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            dismiss(x.id);
            void connect(x.id);
          }}
        >
          {t("lost.reconnect")}
        </Button>
        <IconButton label={t("common.close")} size={22} onClick={() => dismiss(x.id)}>
          <X size={13} />
        </IconButton>
      </div>
    );
  });
}
