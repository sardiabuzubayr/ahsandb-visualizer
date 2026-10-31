import { CodeXml, Download, FileUp, MessageSquareText, Plus, Settings, Upload, Workflow, type LucideIcon } from "lucide-react";
import { DB_META } from "../../components/ui";
import type { TFn } from "../../i18n";
import { tabDatabase, tableTarget } from "../../components/shell/tree";
import type { Action, AppState, DialogContext } from "../../state/reducer";
import type { Env, SchemaNode } from "../../types";

export interface PaletteItem {
  id: string;
  label: string;
  /** Dispatched in order when the item runs; the palette closes itself afterwards. */
  run: Action[];
  icon?: LucideIcon;
  /** Table rows: "T" or "V" badge. */
  badge?: string;
  sub?: string;
  env?: Env;
  conn?: string;
  hint?: string;
  kbd?: string;
  /** Connection to connect (async, via useConnect) after `run`. */
  connect?: string;
  /** Table rows: what export/import data dialogs need. */
  ref?: { connectionId: string; context: DialogContext };
}

/** Tables and views of a connection's loaded navigator tree, with their "database.schema" path. */
function tableRefs(s: AppState, connectionId: string) {
  const out: { node: SchemaNode; path: string }[] = [];
  const walk = (nodes: SchemaNode[], path: string[]) => {
    for (const n of nodes) {
      if (n.kind === "table" || n.kind === "view") out.push({ node: n, path: path.join(".") });
      if (n.children) walk(n.children, n.kind === "database" || n.kind === "schema" ? [...path, n.label] : path);
    }
  };
  const tree = s.trees[connectionId];
  if (tree?.status === "ready") walk(tree.nodes, []);
  return out;
}

export function tableItems(s: AppState): PaletteItem[] {
  return s.connections
    .filter((c) => c.connected)
    .flatMap((c) =>
      tableRefs(s, c.id).map(({ node, path }) => ({
        ref: { connectionId: c.id, context: { database: tabDatabase(c.driver, node), schema: node.schema, table: node.label } },
        id: `t:${c.id}/${node.id}`,
        label: node.label,
        badge: node.kind === "view" ? "V" : "T",
        sub: path,
        env: c.env,
        conn: c.name,
        run: [
          { type: "openTab", kind: "table", connectionId: c.id, title: node.label, target: tableTarget(node), database: tabDatabase(c.driver, node) },
        ],
      })),
    );
}

/** `subject` is the table the export/import data actions refer to (the best table hit). */
export function actionItems(s: AppState, t: TFn, subject?: PaletteItem): PaletteItem[] {
  const active = s.connections.find((c) => c.id === s.activeConnectionId);
  const items: PaletteItem[] = [];
  if (active) {
    items.push({
      id: "a:sql",
      label: t("palette.newSql", { name: active.name }),
      icon: CodeXml,
      kbd: "⌘T",
      run: [{ type: "openTab", kind: "sql", connectionId: active.id, title: "untitled.sql" }],
    });
    const first = active.connected ? tableRefs(s, active.id)[0] : undefined;
    if (first) {
      const schema = first.path;
      const name = first.node.schema ?? schema.split(".").pop() ?? schema;
      items.push({
        id: "a:er",
        label: t("palette.er", { schema }),
        icon: Workflow,
        run: [
          { type: "openTab", kind: "er", connectionId: active.id, title: `ER · ${name}`, target: name, database: tabDatabase(active.driver, first.node) },
        ],
      });
    }
  }
  if (active?.connected) {
    const connectionId = active.id;
    items.push(
      { id: "a:exportDb", label: t("palette.exportDb", { name: active.name }), icon: Download, run: [{ type: "openDialog", dialog: "export", connectionId }] },
      { id: "a:importSql", label: t("palette.importSql", { name: active.name }), icon: FileUp, run: [{ type: "openDialog", dialog: "importSql", connectionId }] },
    );
  }
  if (subject?.ref) {
    const { connectionId, context } = subject.ref;
    items.push(
      { id: "a:export", label: t("palette.export", { name: subject.label }), icon: Download, run: [{ type: "openDialog", dialog: "exportData", connectionId, context }] },
      { id: "a:import", label: t("palette.import", { name: subject.label }), icon: Upload, run: [{ type: "openDialog", dialog: "import", connectionId, context }] },
    );
  }
  items.push(
    { id: "a:conn", label: t("palette.newConnection"), icon: Plus, run: [{ type: "openDialog", dialog: "connection" }] },
    { id: "a:settings", label: t("palette.settings"), icon: Settings, run: [{ type: "openDialog", dialog: "settings" }] },
    { id: "a:agent", label: t("palette.toggleAgent"), icon: MessageSquareText, kbd: "⌘J", run: [{ type: "toggleAgent" }] },
  );
  return items;
}

export function connectionItems(s: AppState, t: TFn): PaletteItem[] {
  return s.connections.map((c) => ({
    id: `c:${c.id}`,
    label: c.name,
    env: c.env,
    sub: `${DB_META[c.driver].name} · ${t(`env.${c.env}`)}`,
    hint: c.connected ? undefined : t("palette.connect"),
    run: [{ type: "setActiveConnection", id: c.id }],
    connect: c.connected ? undefined : c.id,
  }));
}
