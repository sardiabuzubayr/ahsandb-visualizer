import {
  CodeXml,
  Eye,
  PencilRuler,
  Plus,
  Table2,
  Users,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useT } from "../../i18n";
import { useApp } from "../../state/app";
import type { TabKind } from "../../types";
import { Button, Dialog, cn, envStripe } from "../ui";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";

const ICON: Record<TabKind, ReactNode> = {
  sql: <CodeXml size={14} aria-hidden="true" />,
  table: <Table2 size={14} aria-hidden="true" />,
  er: <Workflow size={14} aria-hidden="true" />,
  routine: (
    <span aria-hidden="true" className="font-mono text-[11px]">
      ƒ
    </span>
  ),
  roles: <Users size={14} aria-hidden="true" />,
  designer: <PencilRuler size={14} aria-hidden="true" />,
  trigger: <Zap size={14} aria-hidden="true" />,
  view: <Eye size={14} aria-hidden="true" />,
};

export function TabBar() {
  const t = useT();
  const { state, dispatch } = useApp();
  const [menu, setMenu] = useState<{
    at: { x: number; y: number };
    label: string;
    items: ContextMenuItem[];
  } | null>(null);
  const tabMenu = (id: string): ContextMenuItem[] => {
    const others = state.tabs.filter((x) => x.id !== id).map((x) => x.id);
    return [
      {
        key: "close",
        label: t("tabs.ctx.close"),
        onSelect: () => dispatch({ type: "closeTab", id }),
      },
      {
        key: "others",
        label: t("tabs.ctx.closeOthers"),
        disabled: others.length === 0,
        onSelect: () => dispatch({ type: "closeTabs", ids: others }),
      },
      {
        key: "all",
        label: t("tabs.ctx.closeAll"),
        onSelect: () =>
          dispatch({ type: "closeTabs", ids: state.tabs.map((x) => x.id) }),
      },
    ];
  };
  return (
    <>
      <div
        role="tablist"
        aria-label={t("tabs.label")}
        className="flex h-[38px] shrink-0 items-stretch overflow-x-auto border-b border-border bg-panel"
      >
        {state.tabs.map((tab) => {
          const active = tab.id === state.activeTabId;
          const conn = state.connections.find((c) => c.id === tab.connectionId);
          return (
            <div
              key={tab.id}
              role="tab"
              tabIndex={0}
              aria-selected={active}
              onClick={() => dispatch({ type: "focusTab", id: tab.id })}
              onKeyDown={(e) =>
                (e.key === "Enter" || e.key === " ") &&
                dispatch({ type: "focusTab", id: tab.id })
              }
              onContextMenu={(e) => {
                e.preventDefault();
                // From the keyboard (menu key / ⇧F10) there is no pointer position: anchor under the tab.
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({
                  at:
                    e.clientX || e.clientY
                      ? { x: e.clientX, y: e.clientY }
                      : { x: r.left + 8, y: r.bottom },
                  label: tab.title,
                  items: tabMenu(tab.id),
                });
              }}
              style={
                active && conn
                  ? { boxShadow: `inset 0 2px 0 ${envStripe[conn.env]}` }
                  : undefined
              }
              className={cn(
                "group flex cursor-pointer items-center gap-2 border-r border-border pr-1.5 pl-3.5 whitespace-nowrap",
                active ? "bg-bg text-text" : "text-muted hover:text-text",
              )}
            >
              <span className={active ? "text-accent" : ""}>
                {ICON[tab.kind]}
              </span>
              <span className="max-w-[180px] truncate" title={tab.title}>
                {tab.title}
              </span>
              {conn && (
                <span className="text-[11px] text-faint">{conn.name}</span>
              )}
              {tab.dirty && (
                <span
                  role="img"
                  aria-label={t("tabs.unsaved")}
                  className="size-[7px] rounded-full bg-accent"
                />
              )}
              <button
                type="button"
                aria-label={t("tabs.close")}
                title={t("tabs.close")}
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: "closeTab", id: tab.id });
                }}
                className={cn(
                  "grid size-5 place-items-center rounded text-faint hover:bg-raised hover:text-text",
                  active
                    ? ""
                    : "opacity-0 group-hover:opacity-100 focus:opacity-100",
                )}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          aria-label={t("tabs.new")}
          title={t("tabs.new")}
          onClick={() =>
            dispatch({
              type: "openTab",
              kind: "sql",
              connectionId: state.activeConnectionId,
              title: "untitled.sql",
            })
          }
          className="grid w-[38px] shrink-0 place-items-center text-muted hover:text-text"
        >
          <Plus size={14} />
        </button>
      </div>
      {menu && (
        <ContextMenu
          at={menu.at}
          label={menu.label}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

export function ConfirmCloseDialog() {
  const t = useT();
  const { state, dispatch } = useApp();
  const ids = state.confirmCloseIds ?? [];
  const dirty = state.tabs.filter((x) => ids.includes(x.id) && x.dirty);
  return (
    <Dialog
      open={ids.length > 0}
      onClose={() => dispatch({ type: "cancelClose" })}
      labelledBy="confirm-title"
      className="top-[30%] max-w-[420px]"
    >
      <div className="p-5">
        <h1 id="confirm-title" className="m-0 text-[15px] font-semibold">
          {t("confirm.title")}
        </h1>
        <p className="mt-2 mb-0 text-muted">
          {dirty.length === 1
            ? t("confirm.body", { name: dirty[0].title })
            : t("confirm.bodyMany", {
                n: dirty.length,
                names: dirty.map((x) => x.title).join(", "),
              })}
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
        <Button
          variant="outline"
          size="lg"
          onClick={() => dispatch({ type: "cancelClose" })}
        >
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          size="lg"
          onClick={() => dispatch({ type: "closeTabs", ids, force: true })}
        >
          {t("common.discard")}
        </Button>
      </div>
    </Dialog>
  );
}
