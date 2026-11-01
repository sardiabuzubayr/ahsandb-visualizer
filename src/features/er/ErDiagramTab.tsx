import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  useViewport,
  type Connection as FlowConnection,
  type Edge,
  type EdgeChange,
  type Node,
} from "@xyflow/react";
import { Download, LayoutGrid, Plus, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import { Button, Menu } from "../../components/ui";
import { fileName, pickFileToSave } from "../../lib/sqlFile";
import { exportDiagram } from "./exportImage";
import { useT } from "../../i18n";
import { api, isApiError } from "../../lib/api";
import { scopedId } from "../../lib/scope";
import { firstDatabase } from "../editor/treeScope";
import { useConnection, useTabDirty, useToast } from "../../state/app";
import type { ApplyReport, Env, ErModel, Preview, Tab } from "../../types";
import { useConnectionError } from "../../components/shell/connectionError";
import { PreviewList, previewErrorText } from "../../components/shell/PreviewList";
import { errorText, useConnect } from "../../components/shell/useConnect";
import { ColumnPanel } from "./ColumnPanel";
import { buildView, draftChips, draftReducer, emptyDraft, previewChanges, toChanges, type ViewTable } from "./draft";
import { CARD_W, dagreLayout, initialPositions, loadPositions, positionsKey, savePositions, type Positions, type XY } from "./layout";
import { ErActionsContext, TableNode, type ErActions, type TableNodeType } from "./TableNode";

const nodeTypes = { table: TableNode };
const ENV_TEXT: Record<Env, string> = { prod: "text-prod", staging: "text-stg", dev: "text-dev" };
const FLOW_STYLE = { background: "var(--bg)", "--xy-attribution-background-color": "transparent" } as CSSProperties;

type FkEdge = Edge<{ table: string; columns: string[]; refTable: string; label: string }>;

/** Edges per FK column pair; handles face each other, or top/bottom when the cards share a column. */
function toEdges(view: ViewTable[], pos: Record<string, XY>, selected: string | null): FkEdge[] {
  const idByName = Object.fromEntries(view.map((v) => [v.name, v.id]));
  return view.flatMap((v) =>
    v.fks.flatMap((fk) => {
      const target = idByName[fk.refTable];
      const a = pos[v.id];
      const b = pos[target];
      if (!a || !b) return [];
      return fk.columns.map((from, i): FkEdge => {
        const to = fk.refColumns[i];
        const [sourceHandle, targetHandle] =
          v.id === target
            ? [`${from}-r`, `${to}-r`]
            : Math.abs(a.x - b.x) < 100
              ? a.y > b.y ? ["top", "bottom"] : ["bottom", "top"]
              : a.x > b.x ? [`${from}-l`, `${to}-r`] : [`${from}-r`, `${to}-l`];
        const id = `${v.id}:${fk.columns.join(",")}>${fk.refTable}:${i}`;
        const on = id === selected;
        return {
          id,
          source: v.id,
          target,
          sourceHandle,
          targetHandle,
          type: "smoothstep",
          selected: on,
          data: { table: v.id, columns: fk.columns, refTable: fk.refTable, label: `${v.name}.${from} → ${fk.refTable}.${to}` },
          style: {
            stroke: on ? "var(--accent-strong)" : fk.draft ? "var(--accent)" : "var(--border-strong)",
            strokeWidth: on ? 2.5 : 1.5,
            strokeDasharray: fk.draft ? "5 4" : undefined,
          },
        };
      });
    }),
  );
}

const layoutInput = (view: ViewTable[]) => {
  const idByName = Object.fromEntries(view.map((v) => [v.name, v.id]));
  return [
    view.map((v) => ({ id: v.id, columns: v.columns.length })),
    view.flatMap((v) => v.fks.map((fk) => ({ source: idByName[fk.refTable], target: v.id }))),
  ] as const;
};

/** Handle ids are "<column>-l" / "<column>-r"; top/bottom anchors aren't columns. */
const handleColumn = (h?: string | null) => (h && /-(l|r)$/.test(h) ? h.slice(0, -2) : null);

export function ErDiagramTab({ tab }: { tab: Tab }) {
  return (
    <ReactFlowProvider>
      <Diagram tab={tab} />
    </ReactFlowProvider>
  );
}

function Diagram({ tab }: { tab: Tab }) {
  const t = useT();
  const toast = useToast();
  const conn = useConnection(tab.connectionId);
  const sid = scopedId(conn.id, tab.database);
  const { loadTree } = useConnect();
  const markLost = useConnectionError();
  const { zoomIn, zoomOut, fitView, screenToFlowPosition, setCenter, getNodes } = useReactFlow();
  const [exporting, setExporting] = useState(false);
  const exportAs = async (kind: "png" | "svg") => {
    const schemaName = tab.target ?? "diagram";
    const path = await pickFileToSave(`ER-${schemaName}.${kind}`, { name: kind.toUpperCase(), extension: kind }).catch(() => null);
    if (!path || !canvas.current) return;
    setExporting(true);
    try {
      await exportDiagram(canvas.current, getNodes(), kind, path);
      toast(t("er.exported", { name: fileName(path) }));
    } catch (e) {
      toast(errorText(e));
    } finally {
      setExporting(false);
    }
  };
  const { zoom } = useViewport();

  const [model, setModel] = useState<ErModel>({ tables: [], relations: [] });
  const [draft, dispatch] = useReducer(draftReducer, emptyDraft);
  const [nodes, setNodes, onNodesChange] = useNodesState<TableNodeType>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ id: string; column: string }>();
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [report, setReport] = useState<ApplyReport | null>(null);
  const [applying, setApplying] = useState(false);
  // Positions for nodes about to appear (load, + Table), and whether to fit the view once they do.
  const pending = useRef<Positions>({});
  const fitPending = useRef(false);
  const canvas = useRef<HTMLDivElement>(null);

  const target = tab.target ?? "public";
  const schema =
    target !== "public" || conn.driver === "postgres" ? target : conn.driver === "sqlite" ? "main" : (firstDatabase(conn.database) ?? target);
  const posKey = positionsKey(sid, schema);

  const view = useMemo(() => buildView(model, draft), [model, draft]);
  const changes = useMemo(() => toChanges(draft), [draft]);
  const hasDraft = changes.length > 0;
  useTabDirty(tab.id, hasDraft);
  const typeOf = (table: string, column: string) => view.find((v) => v.name === table)?.columns.find((c) => c.name === column)?.type;
  const chips = draftChips(draft, typeOf, t);

  const load = async () => {
    setStatus("loading");
    try {
      const m = await api.erModel(sid, schema);
      const [tables, edges] = layoutInput(buildView(m, emptyDraft));
      pending.current = { ...pending.current, ...initialPositions(tables, edges, loadPositions(posKey)) };
      fitPending.current = true;
      setModel(m);
      setStatus("ready");
    } catch (e) {
      markLost(conn.id, e);
      setError(isApiError(e) ? e.message : String(e));
      setStatus("error");
    }
  };
  useEffect(() => {
    setNodes([]);
    // Waits for the connection: a restored tab mounts while it is still reconnecting.
    if (conn.connected) void load();
    else (setError(t("results.notConnected")), setStatus("error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, conn.connected, schema]);

  // Nodes follow the view; existing nodes keep their position and measurements.
  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return view.map((v) => {
        const p = byId.get(v.id);
        return p
          ? { ...p, data: { table: v } }
          : { id: v.id, type: "table", position: pending.current[v.id] ?? { x: 0, y: 0 }, deletable: false, data: { table: v } };
      });
    });
    if (fitPending.current) {
      fitPending.current = false;
      void fitView({ padding: 0.15, maxZoom: 1 });
    }
  }, [view, setNodes, fitView]);

  const positions = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n.position])), [nodes]);
  const edges = useMemo(() => toEdges(view, positions, selectedEdge), [view, positions, selectedEdge]);

  /** Saves positions by table name; draft tables only count once applied (`asNames`). */
  const persist = (pos: Positions, asNames = false) =>
    savePositions(
      posKey,
      Object.fromEntries(view.filter((v) => asNames || !v.isNew).flatMap((v) => (pos[v.id] ? [[v.name, pos[v.id]]] : []))),
    );

  // Review panel: regenerate the preview (debounced) whenever the draft changes while it's open.
  const changesKey = JSON.stringify(changes);
  useEffect(() => {
    setPreview(null);
    setPreviewError("");
    setReport(null);
    const req = review ? previewChanges(draft, conn.readOnly) : null;
    if (!req) return;
    let live = true;
    const timer = setTimeout(() => {
      api.previewSchemaChanges(sid, req).then(
        (p) => live && setPreview(p),
        (e) => live && setPreviewError(previewErrorText(t, e)),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review, changesKey, sid, conn.readOnly]);

  /** Existing tables are loaded (once) before their first edit; false = load failed (toast shown). */
  const ensure = async (id: string) => {
    if (draft.tables[id]) return true;
    try {
      dispatch({ type: "loaded", id, def: await api.loadTable(sid, schema, id) });
      return true;
    } catch (e) {
      toast(errorText(e));
      return false;
    }
  };

  const actions: ErActions = {
    editing,
    onColumn: async (id, column) => {
      if (await ensure(id)) setEditing({ id, column });
    },
    onAddColumn: async (id) => {
      if (await ensure(id)) dispatch({ type: "addColumn", id });
    },
    onRemoveTable: async (id) => {
      if (!(await ensure(id))) return;
      dispatch({ type: "removeTable", id });
      if (editing?.id === id) setEditing(undefined);
    },
    onRename: (id, name) => dispatch({ type: "renameTable", id, name }),
  };

  const addTable = () => {
    const id = `__new__${Date.now().toString(36)}`;
    const taken = view.map((v) => v.name);
    let name = "new_table";
    for (let i = 2; taken.includes(name); i++) name = `new_table_${i}`;
    const r = canvas.current?.getBoundingClientRect();
    const c = r ? screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 };
    // Viewport center, nudged right past any card it would cover.
    let p = { x: c.x - CARD_W / 2, y: c.y - 40 };
    const covers = (q: XY) =>
      nodes.some(
        (n) =>
          q.x < n.position.x + CARD_W + 24 && n.position.x < q.x + CARD_W + 24 &&
          q.y < n.position.y + (n.measured?.height ?? 160) + 24 && n.position.y < q.y + 120,
      );
    for (let i = 0; i < 50 && covers(p); i++) p = { ...p, x: p.x + CARD_W + 48 };
    pending.current[id] = p;
    void setCenter(p.x + CARD_W / 2, p.y + 60, { zoom, duration: 300 });
    dispatch({ type: "addTable", id, schema, name, driver: conn.driver });
  };

  const autoLayout = () => {
    const pos = dagreLayout(...layoutInput(view));
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos[n.id] ?? n.position })));
    persist(pos);
    void fitView({ padding: 0.15, maxZoom: 1, duration: 300 });
  };

  const onConnect = async (c: FlowConnection) => {
    const from = handleColumn(c.sourceHandle);
    const to = handleColumn(c.targetHandle);
    const ref = view.find((v) => v.id === c.target);
    if (!from || !to || !ref || !(await ensure(c.source))) return;
    dispatch({ type: "addFk", id: c.source, fk: { columns: [from], refTable: ref.name, refColumns: [to] } });
  };

  const removeFk = async (e: FkEdge) => {
    setSelectedEdge(null);
    if (e.data && (await ensure(e.data.table))) dispatch({ type: "removeFk", id: e.data.table, columns: e.data.columns, refTable: e.data.refTable });
  };
  const onEdgesChange = (cs: EdgeChange<FkEdge>[]) => {
    for (const c of cs) {
      if (c.type === "select") setSelectedEdge(c.selected ? c.id : null);
      if (c.type === "remove") {
        const e = edges.find((x) => x.id === c.id);
        if (e) void removeFk(e);
      }
    }
  };

  const onDragStop = (_: unknown, node: Node, dragged: Node[]) =>
    persist({ ...positions, ...Object.fromEntries(dragged.map((n) => [n.id, n.position])), [node.id]: node.position });

  const discard = () => {
    dispatch({ type: "discard" });
    setEditing(undefined);
    setReview(false);
  };

  const apply = async () => {
    if (!preview) return;
    setApplying(true);
    setPreviewError("");
    try {
      const r = await api.applyPreview(sid, preview.id, true);
      if (r.failed) setReport(r);
      else {
        persist(positions, true);
        discard();
        toast(t("preview.applied", { n: r.executed }));
      }
    } catch (e) {
      setPreviewError(previewErrorText(t, e));
    } finally {
      setApplying(false);
    }
    // Structure may have changed (fully or partly): refresh the diagram and the navigator.
    await load();
    void loadTree(conn.id);
  };

  const editTable = editing && draft.tables[editing.id];
  const editColumn = editTable?.columns.find((c) => c.name === editing?.column);
  const edge = edges.find((e) => e.id === selectedEdge);
  const danger = conn.env === "prod" || !!preview?.destructive;

  return (
    <div className="flex min-h-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-[46px] shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <span className="flex items-center gap-1.5 text-[12.5px]">
            <span className="text-faint">{tab.database ?? firstDatabase(conn.database) ?? conn.file}</span>
            <span className="text-faint">›</span>
            <span className="font-medium">{schema}</span>
            <span className="ml-1 text-muted">{t("er.tables", { n: nodes.length })}</span>
          </span>
          <span className="flex-1" />
          <Button disabled={status !== "ready"} onClick={addTable}>
            <Plus size={12} aria-hidden="true" />
            {t("er.addTable")}
          </Button>
          <Button variant="ghost" disabled={status !== "ready" || nodes.length === 0} onClick={autoLayout}>
            <LayoutGrid size={14} aria-hidden="true" />
            {t("er.autoLayout")}
          </Button>
          <div role="group" aria-label={t("er.zoom")} className="flex items-center rounded-md border border-border bg-surface">
            <button type="button" aria-label={t("er.zoomOut")} title={t("er.zoomOut")} onClick={() => zoomOut()} className="h-[26px] w-7 text-muted hover:text-text">
              −
            </button>
            <span className="min-w-9 px-1 text-center font-mono text-[11.5px] text-muted">{Math.round(zoom * 100)}%</span>
            <button type="button" aria-label={t("er.zoomIn")} title={t("er.zoomIn")} onClick={() => zoomIn()} className="h-[26px] w-7 text-muted hover:text-text">
              +
            </button>
          </div>
          <Menu
            trigger={(p) => (
              <Button variant="ghost" disabled={exporting || nodes.length === 0} {...p}>
                <Download size={14} aria-hidden="true" />
                {t(exporting ? "er.exporting" : "er.export")}
              </Button>
            )}
            items={(["png", "svg"] as const).map((k) => ({ key: k, label: t(`er.export.${k}`), onSelect: () => void exportAs(k) }))}
          />
        </div>

        {hasDraft && (
          <div className="flex min-h-[44px] shrink-0 flex-wrap items-center gap-2 border-b border-border bg-accent-bg px-3 py-1.5">
            <span className="font-semibold text-accent-strong">{t("er.draft")}</span>
            <span className="text-muted">{t("er.draftCount", { n: chips.length })}</span>
            {chips.map((c, i) => (
              <span
                key={i}
                title={c.warn ? t("er.typesDiffer") : undefined}
                className={c.warn ? "flex items-center gap-1 rounded-[5px] bg-stg-bg px-2 py-0.5 font-mono text-[11.5px] text-stg" : "rounded-[5px] bg-surface px-2 py-0.5 font-mono text-[11.5px]"}
              >
                {c.warn && <TriangleAlert size={11} aria-label={t("er.typesDiffer")} />}
                {c.text}
              </span>
            ))}
            <span className="flex-1" />
            {!review && (
              <Button variant="outline" onClick={() => setReview(true)}>
                {t("er.reviewSql")}
              </Button>
            )}
            <Button variant="outline" onClick={discard}>
              {t("er.discardDraft")}
            </Button>
          </div>
        )}

        <div ref={canvas} className="relative min-h-0 flex-1">
          <ErActionsContext.Provider value={actions}>
            <ReactFlow
              aria-label={t("er.label")}
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={(c) => void onConnect(c)}
              onNodeDragStop={onDragStop}
              onPaneClick={() => setSelectedEdge(null)}
              nodeTypes={nodeTypes}
              connectionMode={ConnectionMode.Loose}
              connectionLineStyle={{ stroke: "var(--accent)", strokeWidth: 1.5, strokeDasharray: "5 4" }}
              deleteKeyCode={["Backspace", "Delete"]}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
              minZoom={0.25}
              maxZoom={2}
              style={FLOW_STYLE}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} color="var(--grid-dot)" />
              {edge && (
                <Panel position="top-center" className="flex items-center gap-2 rounded-lg border border-border-strong bg-panel px-2.5 py-1.5 text-xs">
                  <span className="font-mono">FK {edge.data?.label}</span>
                  <Button size="sm" variant="outline" className="text-prod" onClick={() => void removeFk(edge)}>
                    {t("er.removeFk")}
                  </Button>
                </Panel>
              )}
              <Panel position="bottom-left" className="flex flex-wrap gap-[18px] text-[11.5px] text-muted">
                <span>
                  <span className="font-mono text-stg">PK</span> {t("er.legendPk")}
                </span>
                <span>
                  <span className="font-mono text-dev">FK</span> {t("er.legendFk")}
                </span>
                <span>
                  <span className="text-accent">- - -</span> {t("er.legendDraft")}
                </span>
                <span>{t("er.dragHint")}</span>
              </Panel>
            </ReactFlow>
          </ErActionsContext.Provider>
          {editTable && editColumn && (
            <ColumnPanel
              table={editTable}
              column={editColumn}
              onChange={(patch) => {
                dispatch({ type: "updateColumn", id: editing.id, column: editColumn.name, patch });
                if (patch.name !== undefined) setEditing({ id: editing.id, column: patch.name });
              }}
              onDelete={() => {
                dispatch({ type: "removeColumn", id: editing.id, column: editColumn.name });
                setEditing(undefined);
              }}
              onClose={() => setEditing(undefined)}
            />
          )}
          {status !== "ready" ? (
            <div role={status === "error" ? "alert" : "status"} className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
              <p className={status === "error" ? "m-0 max-w-[520px] text-prod" : "m-0 text-muted"}>
                {status === "error" ? error : t("er.loading")}
              </p>
              {status === "error" && <Button onClick={() => void load()}>{t("er.retry")}</Button>}
            </div>
          ) : (
            nodes.length === 0 && <p className="pointer-events-none absolute inset-0 m-0 grid place-items-center text-muted">{t("er.empty")}</p>
          )}
        </div>
      </main>

      {hasDraft && review && (
        <aside aria-label={t("er.reviewTitle")} className="flex w-[380px] shrink-0 flex-col border-l border-border bg-panel">
          <div className="border-b border-border px-4 pt-4 pb-3">
            <h2 className="m-0 text-sm font-semibold">{t("er.reviewSql")}</h2>
            <p className="mt-1 mb-0 text-xs text-muted">
              {t("er.generatedFor")} <span className={ENV_TEXT[conn.env]}>{conn.name}</span> · {conn.serverVersion}
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {conn.readOnly ? (
              <p className="m-0 rounded-lg bg-surface px-3 py-2.5 text-xs text-muted">{t("preview.readOnly")}</p>
            ) : previewError ? (
              <p role="alert" className="m-0 rounded-lg bg-prod-bg px-3 py-2.5 text-xs break-words text-prod">
                {previewError}
              </p>
            ) : preview ? (
              <PreviewList preview={preview} report={report} />
            ) : (
              <p role="status" className="m-0 text-xs text-muted">
                {t("preview.loading")}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 p-3">
            <Button variant="outline" size="lg" onClick={() => setReview(false)}>
              {t("er.back")}
            </Button>
            <Button
              variant={danger ? "danger" : "primary"}
              size="lg"
              className="font-semibold"
              disabled={conn.readOnly || !preview || applying || !!report?.failed}
              title={conn.readOnly ? t("preview.readOnly") : undefined}
              onClick={() => void apply()}
            >
              {applying ? t("er.applying") : t("er.apply", { n: chips.length })}
            </Button>
          </div>
        </aside>
      )}
    </div>
  );
}
