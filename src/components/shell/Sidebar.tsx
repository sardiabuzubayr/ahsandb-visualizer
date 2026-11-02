import { useEffect, useMemo, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { BookOpen, ChevronDown, ChevronRight, Loader2, MoreHorizontal, PanelLeftClose, Plus, RefreshCw, Search } from "lucide-react";
import { writePref } from "../../lib/storage";
import { useT } from "../../i18n";
import { api, isApiError } from "../../lib/api";
import { useApp, useToast } from "../../state/app";
import type { Connection, NodeKind, SchemaNode } from "../../types";
import { Button, DbIcon, Dialog, EnvBadge, IconButton, Menu, cn } from "../ui";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import {
  canRenameDatabase,
  filterTree,
  formatBytes,
  isMultiDb,
  isServerDriver,
  nodeActions,
  objectSchema,
  redisDb,
  redisTab,
  selectSql,
  tabDatabase,
  tableTarget,
  transferDialog,
  type NodeAction,
} from "./tree";
import { scopedId } from "../../lib/scope";
import { duplicateOf } from "../../features/connection/form";
import { defaultSchema } from "../../features/data/table";
import { queueSql } from "../../features/editor/pendingSql";
import { DICT_CHANGED, dictDatabase, markKey } from "../../features/dictionary/dictionary";
import { errorText, folderLabel, useConnect } from "./useConnect";
import { DropDialog } from "./DropDialog";
import { DatabaseDialog } from "./DatabaseDialog";
import { DropDatabaseDialog } from "./DropDatabaseDialog";

const KIND_BADGE: Partial<Record<NodeKind, { text: string; color: string }>> = {
  database: { text: "DB", color: "text-faint" },
  schema: { text: "SC", color: "text-faint" },
  table: { text: "T", color: "text-accent" },
  view: { text: "V", color: "text-syn-fn" },
  function: { text: "ƒ", color: "text-syn-param" },
  procedure: { text: "P", color: "text-syn-param" },
  trigger: { text: "TR", color: "text-faint" },
  sequence: { text: "SQ", color: "text-faint" },
  event: { text: "EV", color: "text-faint" },
  keyspace: { text: "DB", color: "text-faint" },
};

const DEFAULT_OPEN = (n: SchemaNode) => n.kind === "database" || n.kind === "schema" || n.id.endsWith("/tables");

const SIDEBAR_DEFAULT = 280;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 600;
const clampWidth = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));

export function Sidebar() {
  const t = useT();
  // Drag the right edge to resize (double-click: default); kept across restarts.
  const [width, setWidthState] = useState(() => {
    try {
      return clampWidth(Number(localStorage.getItem("sidebar.width")) || SIDEBAR_DEFAULT);
    } catch {
      return SIDEBAR_DEFAULT;
    }
  });
  const setWidth = (w: number) => {
    setWidthState(clampWidth(w));
    writePref("sidebar.width", String(clampWidth(w)));
  };
  const startResize = (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let latest = startW;
    const move = (ev: PointerEvent) => {
      latest = clampWidth(startW + ev.clientX - startX);
      setWidthState(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      writePref("sidebar.width", String(latest));
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const toast = useToast();
  const { state, dispatch } = useApp();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const [dropping, setDropping] = useState<SchemaNode | null>(null);
  // Create (no `from`) or rename database dialog; drop database dialog.
  const [dbDialog, setDbDialog] = useState<{ conn: Connection; from?: string } | null>(null);
  const [droppingDb, setDroppingDb] = useState<{ conn: Connection; node: SchemaNode } | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; label: string; items: ContextMenuItem[] } | null>(null);
  const { connect, disconnect, loadTree, loadDatabase, dbStatus, isConnecting } = useConnect();
  // Redis: memory of the whole server (no per-database figure exists), read with each tree load.
  const [kvMemory, setKvMemory] = useState<Record<string, number>>({});
  // Tables with data-dictionary notes on the active connection: markKey → has drafts.
  const [marks, setMarks] = useState<Map<string, boolean>>(new Map());

  // Connected entries without a tree (the browser mock starts connected) load theirs once.
  useEffect(() => {
    for (const c of state.connections) if (c.connected && !state.trees[c.id]) void loadTree(c.id);
  }, [state.connections]); // loadTree/trees read fresh each run; only a connection change matters

  const folders = useMemo(() => {
    const m = new Map<string, Connection[]>();
    for (const c of state.connections) m.set(c.folder, [...(m.get(c.folder) ?? []), c]);
    return [...m.entries()];
  }, [state.connections]);

  const active = state.connections.find((c) => c.id === state.activeConnectionId);
  const treeState = active?.connected ? state.trees[active.id] : undefined;
  const tree = useMemo(() => (treeState?.status === "ready" ? filterTree(treeState.nodes, query) : []), [treeState, query]);
  // Several databases: nothing starts open, so connecting doesn't load (or show) every one of them.
  const multiDb = treeState?.status === "ready" && isMultiDb(treeState.nodes);

  // Dictionary marks follow the active connection's tree and every dictionary change.
  const markConn = active?.connected && active.driver !== "redis" && treeState?.status === "ready" ? active.id : null;
  useEffect(() => {
    if (!markConn) return setMarks(new Map());
    let live = true;
    const load = () =>
      api.dictMarks(markConn).then(
        (ms) => live && setMarks(new Map(ms.map((m) => [markKey(m.database, m.schema, m.table), m.draft]))),
        () => {}, // marks are a hint; the tree works without them
      );
    void load();
    window.addEventListener(DICT_CHANGED, load);
    return () => {
      live = false;
      window.removeEventListener(DICT_CHANGED, load);
    };
  }, [markConn]);

  const toggleConnection = (c: Connection) => (c.connected ? disconnect(c.id) : connect(c.id));
  const duplicate = async (c: Connection) => {
    try {
      dispatch({ type: "addConnection", connection: await api.saveConnection(duplicateOf(c), {}) });
    } catch (e) {
      toast(errorText(e));
    }
  };
  const remove = async (c: Connection) => {
    setDeleting(null);
    try {
      await api.deleteConnection(c.id);
      dispatch({ type: "removeConnection", id: c.id });
    } catch (e) {
      toast(errorText(e));
      // The store row is already gone when only the secret cleanup failed.
      if (isApiError(e, "secrets")) dispatch({ type: "removeConnection", id: c.id });
    }
  };

  useEffect(() => {
    if (active?.driver !== "redis" || treeState?.status !== "ready") return;
    const id = active.id;
    api.kvMemory(id).then(
      (b) => b !== null && setKvMemory((m) => ({ ...m, [id]: b })),
      () => {},
    );
  }, [treeState]); // a refreshed tree means fresh numbers
  const isOpen = (n: SchemaNode) => !!query || open.has(n.id) || (!multiDb && DEFAULT_OPEN(n) && !closed.has(n.id));

  // An open lazy database without a load in flight or a past error loads (expand, or open again after a refresh).
  useEffect(() => {
    if (!active || query || treeState?.status !== "ready") return;
    for (const n of treeState.nodes) if (n.lazy && open.has(n.id) && !dbStatus(n.id)) void loadDatabase(active.id, n);
  }, [treeState, open, query]); // dbStatus/loadDatabase read fresh each run
  const toggle = (n: SchemaNode) => {
    const nowOpen = isOpen(n);
    setOpen((s) => {
      const x = new Set(s);
      if (nowOpen) x.delete(n.id);
      else x.add(n.id);
      return x;
    });
    setClosed((s) => {
      const x = new Set(s);
      if (nowOpen) x.add(n.id);
      else x.delete(n.id);
      return x;
    });
  };

  /** Sequence/event DDL opened in a new SQL tab. */
  const showDdl = async (conn: Connection, n: SchemaNode) => {
    try {
      const database = tabDatabase(conn.driver, n);
      const ddl = await api.objectDdl(scopedId(conn.id, database), n.kind as "sequence" | "event", objectSchema(n) ?? defaultSchema(conn), n.label);
      queueSql(conn.id, ddl);
      dispatch({ type: "openTab", kind: "sql", connectionId: conn.id, title: `${n.label}.sql`, database });
    } catch (e) {
      toast(errorText(e));
    }
  };

  const activate = (n: SchemaNode) => {
    if (!active) return;
    const database = tabDatabase(active.driver, n);
    if (n.kind === "trigger")
      dispatch({ type: "openTab", kind: "trigger", connectionId: active.id, title: n.label, target: `${objectSchema(n) ?? defaultSchema(active)}.${n.label}`, database });
    else if (n.kind === "sequence" || n.kind === "event") void showDdl(active, n);
    else if (n.kind === "table" || n.kind === "view")
      dispatch({ type: "openTab", kind: "table", connectionId: active.id, title: n.label, target: tableTarget(n), database });
    else if (n.kind === "function" || n.kind === "procedure")
      dispatch({ type: "openTab", kind: "routine", connectionId: active.id, title: n.label, target: n.label, database });
    else if (n.kind === "role")
      dispatch({ type: "openTab", kind: "roles", connectionId: active.id, title: "Roles", target: "roles" });
    else if (n.kind === "keyspace") dispatch(redisTab("keys", active.id, n.schema ?? "0"));
    else if (n.children || n.lazy) toggle(n);
  };

  const connectionItems = (c: Connection): ContextMenuItem[] => [
    {
      key: "toggle",
      label: t(c.connected ? "nav.disconnect" : "nav.connect"),
      disabled: isConnecting(c.id),
      onSelect: () => void toggleConnection(c),
    },
    // The backend's connect replaces an open pool (and SSH tunnel) with a fresh one, then the tree reloads.
    ...(c.connected ? [{ key: "reconnect", label: t("nav.reconnect"), disabled: isConnecting(c.id), onSelect: () => void connect(c.id) }] : []),
    { key: "edit", label: t("nav.edit"), onSelect: () => dispatch({ type: "openDialog", dialog: "connection", connectionId: c.id }) },
    { key: "dup", label: t("nav.duplicate"), onSelect: () => void duplicate(c) },
    ...(c.connected && isServerDriver(c.driver) ? [{ key: "newDb", label: t("nav.ctx.newDatabase"), onSelect: () => setDbDialog({ conn: c }) }] : []),
    ...(c.connected && c.driver === "redis"
      ? [
          { key: "console", label: t("nav.ctx.openConsole"), onSelect: () => dispatch(redisTab("console", c.id, redisDb(c))) },
          {
            key: "info",
            label: t("nav.ctx.serverInfo"),
            onSelect: () => dispatch({ type: "openTab", kind: "info", connectionId: c.id, title: `${c.name} · info`, target: "info" }),
          },
        ]
      : []),
    { key: "del", label: <span className="text-prod">{t("nav.delete")}</span>, onSelect: () => setDeleting(c) },
  ];

  const runNodeAction = (a: NodeAction, n: SchemaNode) => {
    if (!active) return;
    if (a === "openData" || a === "open" || a === "openKeys") return activate(n);
    if (a === "openConsole") return dispatch(redisTab("console", active.id, n.schema ?? "0"));
    if (a === "refresh") return void loadTree(active.id);
    if (a === "copyName")
      return void navigator.clipboard.writeText(n.label).then(
        () => toast(t("nav.ctx.copied", { name: n.label })),
        (e: unknown) => toast(errorText(e)),
      );
    if (a === "newDatabase") return setDbDialog({ conn: active });
    if (a === "renameDatabase") return setDbDialog({ conn: active, from: n.label });
    if (a === "dropDatabase") return setDroppingDb({ conn: active, node: n });
    const transfer = transferDialog(a, n, active.driver);
    if (transfer) return dispatch({ type: "openDialog", connectionId: active.id, ...transfer });
    const database = tabDatabase(active.driver, n);
    if (a === "newSql") {
      queueSql(active.id, selectSql(active.driver, n.label, n.schema));
      return dispatch({ type: "openTab", kind: "sql", connectionId: active.id, title: "untitled.sql", database });
    }
    if (a === "editTable")
      return dispatch({ type: "openTab", kind: "designer", connectionId: active.id, title: `${n.label} · design`, target: tableTarget(n), database });
    if (a.startsWith("drop")) return setDropping(n);
    if (a === "showDdl") return void showDdl(active, n);
    const schema = objectSchema(n) ?? defaultSchema(active);
    const tab = { connectionId: active.id, database };
    if (a === "editView") return dispatch({ type: "openTab", kind: "view", ...tab, title: n.label, target: `${schema}.${n.label}` });
    if (a === "openDictionary") return dispatch({ type: "openTab", kind: "dict", ...tab, title: t("dict.tabTitle", { schema }), target: schema });
    const fresh = `${schema}.__new__${Date.now()}`;
    if (a === "newTable") return dispatch({ type: "openTab", kind: "designer", ...tab, title: t("nav.newTableTitle"), target: fresh });
    if (a === "newView") return dispatch({ type: "openTab", kind: "view", ...tab, title: t("nav.newViewTitle"), target: fresh });
    if (a === "newTrigger") {
      // From a table the editor starts with that table picked: "<schema>.__new__<ts>:<table>".
      const target = n.kind === "table" ? `${fresh}:${n.label}` : fresh;
      return dispatch({ type: "openTab", kind: "trigger", ...tab, title: t("nav.newTriggerTitle"), target });
    }
    dispatch({ type: "openTab", kind: "er", ...tab, title: `ER · ${schema}`, target: schema });
  };

  const openMenu = (e: MouseEvent, label: string, items: ContextMenuItem[]) => {
    e.preventDefault();
    if (!items.length) return;
    // Opened from the keyboard (menu key / ⇧F10) there is no pointer position: anchor under the row.
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ at: e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 16, y: r.bottom }, label, items });
  };

  // Group and "more" rows are UI labels; object names are data and stay as-is.
  const nodeLabel = (n: SchemaNode) => {
    if (n.kind === "group" || (n.kind === "role" && n.children)) return t(`nav.group.${n.id.split("/").pop()}`);
    if (n.kind === "more") return t("nav.more", { n: parseInt(n.label, 10) });
    return n.label;
  };

  const renderNodes = (nodes: SchemaNode[], depth: number) =>
    nodes.map((n) => {
      const badge = n.kind === "role" && n.children ? { text: "RL", color: "text-syn-fn" } : KIND_BADGE[n.kind];
      const expandable = (!!n.children?.length || !!n.lazy) && n.kind !== "role";
      const expanded = expandable && isOpen(n);
      const activeTab = state.tabs.find((tb) => tb.id === state.activeTabId);
      const selected =
        !!active &&
        activeTab?.connectionId === active.id &&
        (n.kind === "keyspace"
          ? activeTab.kind === "keys" && activeTab.database === n.schema
          : (n.kind === "table" || n.kind === "view") && activeTab.target === tableTarget(n) && activeTab.database === tabDatabase(active.driver, n));
      const status = n.lazy ? dbStatus(n.id) : undefined;
      return (
        <div key={n.id}>
          <button
            type="button"
            onClick={() => (expandable ? toggle(n) : activate(n))}
            onDoubleClick={() => expandable && activate(n)}
            onContextMenu={(e) =>
              openMenu(
                e,
                nodeLabel(n),
                nodeActions(n, active?.driver).map((a) => {
                  const noRename = a === "renameDatabase" && !!active && !canRenameDatabase(active.driver);
                  return {
                    key: a,
                    label: a.startsWith("drop") ? <span className="text-prod">{t(`nav.ctx.${a}`)}</span> : t(`nav.ctx.${a}`),
                    onSelect: () => runNodeAction(a, n),
                    disabled: noRename,
                    title: noRename ? t("nav.ctx.renameNotSupported") : undefined,
                  };
                }),
              )
            }
            style={{ paddingLeft: 22 + depth * 14 }}
            title={n.label}
            className={cn(
              "flex h-[26px] w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] hover:bg-raised",
              selected ? "bg-accent-bg" : "",
              n.kind === "group" || (n.kind === "keyspace" && !n.count) ? "text-muted" : n.kind === "more" ? "text-faint" : "text-text",
            )}
          >
            {expandable ? (
              expanded ? (
                <ChevronDown size={11} className="shrink-0 text-faint" aria-hidden="true" />
              ) : (
                <ChevronRight size={11} className="shrink-0 text-faint" aria-hidden="true" />
              )
            ) : (
              <span className="w-[11px] shrink-0" />
            )}
            <span className={cn("min-w-4 font-mono text-[10px]", badge?.color)}>{badge?.text}</span>
            <span className="flex-1 truncate">{nodeLabel(n)}</span>
            {n.count !== undefined && <span className="font-mono text-[11px] text-faint">{n.count}</span>}
            {n.kind === "table" && active && marks.has(markKey(dictDatabase(active.driver, n), n.schema, n.label)) && (
              <BookOpen
                size={11}
                role="img"
                aria-label={t(marks.get(markKey(dictDatabase(active.driver, n), n.schema, n.label)) ? "nav.dictDrafts" : "nav.dictNotes")}
                className={cn("shrink-0", marks.get(markKey(dictDatabase(active.driver, n), n.schema, n.label)) ? "text-accent" : "text-ok")}
              />
            )}
            {(n.kind === "database" || n.kind === "table") && n.size !== undefined && (
              <span className="shrink-0 font-mono text-[11px] text-faint">{formatBytes(n.size)}</span>
            )}
          </button>
          {expanded && status === "loading" && (
            <div style={{ paddingLeft: 22 + (depth + 1) * 14 }} className="flex h-[26px] items-center gap-2 text-[12.5px] text-muted">
              <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              {t("nav.loading")}
            </div>
          )}
          {expanded && typeof status === "object" && (
            <div role="alert" style={{ paddingLeft: 22 + (depth + 1) * 14 }} className="flex items-start gap-2 py-1 pr-2 text-[12.5px]">
              <span className="min-w-0 flex-1 break-words text-prod">{status.error}</span>
              <Button size="sm" onClick={() => active && void loadDatabase(active.id, n)}>
                {t("nav.retry")}
              </Button>
            </div>
          )}
          {expanded && n.children && renderNodes(n.children, depth + 1)}
        </div>
      );
    });

  return (
    <aside aria-label={t("nav.title")} style={{ width }} className="relative flex shrink-0 flex-col border-r border-border bg-panel">
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={t("nav.resize")}
        title={t("nav.resize")}
        onPointerDown={startResize}
        onDoubleClick={() => setWidth(SIDEBAR_DEFAULT)}
        className="absolute top-0 -right-[3px] z-10 h-full w-1.5 cursor-col-resize hover:bg-[var(--accent-ring)]"
      />
      <div className="flex items-center justify-between pt-3 pr-2.5 pb-2 pl-3.5">
        <span className="text-[11px] font-semibold tracking-[.06em] text-muted uppercase">{t("nav.title")}</span>
        <div className="flex gap-0.5">
          <IconButton label={t("nav.new")} onClick={() => dispatch({ type: "openDialog", dialog: "connection" })}>
            <Plus size={15} />
          </IconButton>
          <IconButton label={t("nav.refresh")} disabled={!active?.connected} onClick={() => active && loadTree(active.id)}>
            <RefreshCw size={14} />
          </IconButton>
          <IconButton label={t("nav.hide")} onClick={() => dispatch({ type: "toggleSidebar" })}>
            <PanelLeftClose size={15} />
          </IconButton>
        </div>
      </div>
      <div className="px-3 pb-2.5">
        <label className="flex h-[30px] items-center gap-2 rounded-[7px] border border-border bg-surface px-2.5 text-faint">
          <Search size={13} aria-hidden="true" />
          <input
            type="text"
            aria-label={t("nav.filterLabel")}
            placeholder={t("nav.filter")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 border-0 bg-transparent text-text outline-none"
          />
        </label>
      </div>
      <nav aria-label={t("nav.label")} className="min-h-0 flex-1 overflow-auto px-1.5 pb-2.5">
        {folders.length === 0 && (
          <div className="flex flex-col items-start gap-2.5 px-2 pt-1.5">
            <p className="m-0 text-muted">{t("nav.empty")}</p>
            <Button variant="primary" onClick={() => dispatch({ type: "openDialog", dialog: "connection" })}>
              <Plus size={14} aria-hidden="true" />
              {t("nav.new")}
            </Button>
          </div>
        )}
        {folders.map(([folder, conns], fi) => (
          <div key={folder}>
            <div className={cn("flex items-center gap-1.5 px-2 pb-1 text-[11px] font-medium text-faint", fi ? "pt-3" : "pt-1.5")}>
              <ChevronDown size={11} aria-hidden="true" />
              {folderLabel(t, folder)}
            </div>
            {conns.map((c) => {
              const isActive = c.id === state.activeConnectionId;
              const busy = isConnecting(c.id);
              return (
                <div key={c.id}>
                  <div
                    onContextMenu={(e) => openMenu(e, t("nav.actions", { name: c.name }), connectionItems(c))}
                    className={cn(
                      "group flex h-[30px] items-center rounded-md pr-1 hover:bg-raised",
                      isActive ? "bg-raised font-medium" : c.connected ? "" : "text-muted",
                    )}
                  >
                    <button
                      type="button"
                      title={t("nav.toggleHint")}
                      onClick={() => dispatch({ type: "setActiveConnection", id: c.id })}
                      onDoubleClick={() => toggleConnection(c)}
                      className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left"
                    >
                      <DbIcon driver={c.driver} />
                      <span className="flex-1 truncate" title={c.name}>
                        {c.name}
                      </span>
                      {busy ? (
                        <Loader2 size={12} role="img" aria-label={t("nav.connecting")} className="animate-spin text-muted" />
                      ) : (
                        c.connected && <span role="img" aria-label={t("nav.connected")} className="size-[7px] rounded-full bg-ok" />
                      )}
                      {c.driver === "redis" && c.connected && kvMemory[c.id] !== undefined && (
                        <span title={t("nav.redisMemory")} className="shrink-0 font-mono text-[11px] text-faint">
                          {formatBytes(kvMemory[c.id])}
                        </span>
                      )}
                      <EnvBadge env={c.env} />
                    </button>
                    <Menu
                      align="right"
                      trigger={(p) => (
                        <IconButton
                          {...p}
                          label={t("nav.actions", { name: c.name })}
                          size={22}
                          className={cn(!isActive && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100")}
                        >
                          <MoreHorizontal size={14} />
                        </IconButton>
                      )}
                      items={connectionItems(c)}
                    />
                  </div>
                  {isActive && treeState?.status === "loading" && (
                    <div className="flex h-[26px] items-center gap-2 pl-[22px] text-[12.5px] text-muted">
                      <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                      {t("nav.loading")}
                    </div>
                  )}
                  {isActive && treeState?.status === "error" && (
                    <div role="alert" className="flex items-start gap-2 py-1 pr-2 pl-[22px] text-[12.5px]">
                      <span className="min-w-0 flex-1 break-words text-prod">{treeState.message}</span>
                      <Button size="sm" onClick={() => loadTree(c.id)}>
                        {t("nav.retry")}
                      </Button>
                    </div>
                  )}
                  {isActive && renderNodes(tree, 0)}
                </div>
              );
            })}
          </div>
        ))}
      </nav>
      {dropping && active && <DropDialog node={dropping} conn={active} onClose={() => setDropping(null)} />}
      {dbDialog && <DatabaseDialog conn={dbDialog.conn} from={dbDialog.from} onClose={() => setDbDialog(null)} />}
      {droppingDb && <DropDatabaseDialog conn={droppingDb.conn} node={droppingDb.node} onClose={() => setDroppingDb(null)} />}
      {menu && <ContextMenu at={menu.at} label={menu.label} items={menu.items} onClose={() => setMenu(null)} />}
      <Dialog open={!!deleting} onClose={() => setDeleting(null)} labelledBy="del-conn-title" className="top-[30%] max-w-[420px]">
        <div className="p-5">
          <h1 id="del-conn-title" className="m-0 text-[15px] font-semibold">
            {t("nav.deleteTitle")}
          </h1>
          <p className="mt-2 mb-0 text-muted">{t("nav.deleteBody", { name: deleting?.name ?? "" })}</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
          <Button variant="outline" size="lg" onClick={() => setDeleting(null)}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" size="lg" onClick={() => deleting && remove(deleting)}>
            {t("nav.delete")}
          </Button>
        </div>
      </Dialog>
    </aside>
  );
}
