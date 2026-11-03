import { nodeDatabase } from "../../lib/scope";
import type { DialogContext, DialogKind } from "../../state/reducer";
import type { Connection, Driver, ObjectKind, SchemaNode, Tab } from "../../types";

/** Keeps nodes whose label matches, plus the ancestors of any match. */
export function filterTree(nodes: SchemaNode[], query: string): SchemaNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const out: SchemaNode[] = [];
  for (const n of nodes) {
    const kids = n.children ? filterTree(n.children, q) : [];
    if (n.label.toLowerCase().includes(q) || kids.length) out.push({ ...n, children: kids.length ? kids : n.children });
  }
  return out;
}

/** Tab `database` for an object opened from `n`: PostgreSQL (not for cluster-wide Roles), or a Redis keyspace's index. */
export const tabDatabase = (driver: Driver, n: SchemaNode) =>
  driver === "redis" ? n.schema : driver === "postgres" && n.kind !== "role" ? nodeDatabase(n) : undefined;

/** More than one database node at the top: the navigator starts with all of them closed. */
export const isMultiDb = (nodes: SchemaNode[]) => nodes.filter((n) => n.kind === "database").length > 1;

/** Database nodes of a refreshed tree to load again: loaded before (non-lazy with children), lazy now. */
export function reloadedDatabases(prev: SchemaNode[] | undefined, next: SchemaNode[]): SchemaNode[] {
  const loaded = new Set(prev?.filter((n) => !n.lazy && n.children?.length).map((n) => n.id));
  return next.filter((n) => n.lazy && loaded.has(n.id));
}

/** Tab `target` for a table/view node: "schema.table", or just the name when the node has no schema. */
export const tableTarget = (n: SchemaNode) => (n.schema ? `${n.schema}.${n.label}` : n.label);

/** Schema an ER diagram for this node would show; PostgreSQL's top database node has none. */
export const erSchemaOf = (n: SchemaNode): string | undefined => n.schema ?? (n.kind === "schema" ? n.label : undefined);

/** Schema a node's objects live in; group nodes carry none, so their children tell. */
export const objectSchema = (n: SchemaNode): string | undefined => erSchemaOf(n) ?? n.children?.find((c) => c.schema)?.schema;

export type NodeAction =
  | "openData"
  | "newSql"
  | "newQuery"
  | "copyName"
  | "openEr"
  | "openDictionary"
  | "refresh"
  | "open"
  | "editTable"
  | "dropTable"
  | "dropView"
  | "newTable"
  | "newTrigger"
  | "editView"
  | "newView"
  | "showDdl"
  | "dropTrigger"
  | "dropSequence"
  | "dropEvent"
  | "newDatabase"
  | "renameDatabase"
  | "dropDatabase"
  | "export"
  | "importSql"
  | "exportData"
  | "importData"
  | "openKeys"
  | "openConsole";

/** Server drivers can create/rename/drop databases; SQLite is one file and Redis has fixed numbered ones. */
export const isServerDriver = (d?: Driver) => !!d && d !== "sqlite" && d !== "redis";

/** MySQL/MariaDB have no RENAME DATABASE: the menu entry stays, disabled with a tooltip. */
export const canRenameDatabase = (d: Driver) => d !== "mysql" && d !== "mariadb";

/** Right-click menu entries per navigator node; empty = no menu. `driver` adds database DDL to database nodes. */
export function nodeActions(n: SchemaNode, driver?: Driver): NodeAction[] {
  if (n.kind === "database" && isServerDriver(driver)) return [...nodeActions(n), "newDatabase", "renameDatabase", "dropDatabase"];
  switch (n.kind) {
    case "table":
      return ["openData", "newSql", "copyName", "openEr", "openDictionary", "editTable", "newTrigger", "exportData", "importData", "dropTable"];
    case "view":
      return ["openData", "editView", "newSql", "copyName", "openEr", "dropView"];
    case "schema":
    case "database":
      return erSchemaOf(n)
        ? ["newQuery", "openEr", "openDictionary", "newTable", "newView", "export", "importSql", "refresh"]
        : ["newQuery", "export", "importSql", "refresh"];
    case "group":
      return n.id.endsWith("/triggers") ? ["newTrigger", "refresh"] : ["refresh"];
    case "trigger":
      return ["open", "copyName", "dropTrigger"];
    case "sequence":
      return ["showDdl", "copyName", "dropSequence"];
    case "event":
      return ["showDdl", "copyName", "dropEvent"];
    case "function":
    case "procedure":
      return ["open", "copyName"];
    case "keyspace":
      return ["openKeys", "openConsole", "refresh"];
    default:
      return [];
  }
}

const TRANSFER: Partial<Record<NodeAction, DialogKind>> = { export: "export", importSql: "importSql", exportData: "exportData", importData: "import" };

/** Dialog and context a transfer menu entry opens: database/schema dumps and SQL imports, table data export/import. */
export function transferDialog(a: NodeAction, n: SchemaNode, driver: Driver): { dialog: DialogKind; context: DialogContext } | null {
  const dialog = TRANSFER[a];
  if (!dialog) return null;
  // erSchemaOf: a PG database node has no schema (→ the dialog's default), unlike objectSchema's first child.
  const context = { database: tabDatabase(driver, n), schema: erSchemaOf(n), ...(n.kind === "table" && { table: n.label }) };
  return { dialog, context };
}

const DROPPABLE: ObjectKind[] = ["table", "view", "trigger", "sequence", "event"];

/** Object kind a DropDialog for this node drops. */
export const dropKind = (n: SchemaNode): ObjectKind => DROPPABLE.find((k) => k === n.kind) ?? "table";

/** Whether dropping `n` (in `schema`) leaves `tab` pointing at nothing: data/designer tabs of a table/view, or the view/trigger editor. */
export function closesOnDrop(n: SchemaNode, schema: string, tab: Pick<Tab, "kind" | "target">): boolean {
  const kind = dropKind(n);
  const own = `${schema}.${n.label}`;
  if (tab.kind === "table" || tab.kind === "designer")
    return (kind === "table" || kind === "view") && (tab.target === own || tab.target === tableTarget(n));
  return (tab.kind === "view" || tab.kind === "trigger") && tab.kind === kind && tab.target === own;
}

/** Identifier quoted for the driver: `name` on MySQL/MariaDB, "name" elsewhere (embedded quotes doubled). */
export function quoteIdent(driver: Driver, name: string): string {
  const q = driver === "mysql" || driver === "mariadb" ? "`" : '"';
  return q + name.replaceAll(q, q + q) + q;
}

export const selectSql = (driver: Driver, table: string, schema?: string) =>
  `SELECT * FROM ${[schema, table]
    .filter((x): x is string => !!x)
    .map((x) => quoteIdent(driver, x))
    .join(".")} LIMIT 100;`;

/** Database size as "0 B", "512 B", "1.5 KB", "12.4 MB" (1024-based, one decimal from KB up). */
export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  // Compare the rounded value so 1023.96 KB shows as "1.0 MB", not "1024.0 KB".
  for (; i < units.length - 1 && Math.round(n * 10) >= 10240; i++) n /= 1024;
  return i ? `${n.toFixed(1)} ${units[i]}` : `${n} B`;
}

/**
 * Connection `database` field after a database is created (`from` null), renamed or dropped (`to` null);
 * undefined when the field isn't an explicit list (empty = every database), so there's nothing to update.
 */
export function nextDatabaseList(list: string | undefined, from: string | null, to: string | null): string | undefined {
  const names = (list ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  if (!names.length) return undefined;
  const next = from === null ? [...names, to!] : names.flatMap((d) => (d !== from ? [d] : to === null ? [] : [to]));
  return [...new Set(next)].join(", ");
}

/** Whether a tab works in database `name` (closed when it's renamed/dropped). PG: the tab's database; MySQL/MariaDB: its target. */
export const inDatabase = (driver: Driver, name: string, tab: Pick<Tab, "database" | "target">) =>
  driver === "postgres" ? tab.database === name : tab.target === name || !!tab.target?.startsWith(`${name}.`);

/** Drop database is enabled only after both confirmations: the checkbox and the exact (case-sensitive) name. */
export const dropDatabaseConfirmed = (name: string, understood: boolean, typed: string) => understood && typed === name;

/** Tab that opens a Redis tool on database `index` ("0" when the connection didn't pick one). */
export const redisTab = (kind: "keys" | "console", connectionId: string, index: string) =>
  ({ type: "openTab", kind, connectionId, title: kind === "keys" ? `db${index}` : `console · db${index}`, target: `db${index}`, database: index }) as const;

/** Database index a Redis connection opens ("0" when its Database field is empty). */
export const redisDb = (c: Pick<Connection, "database">) => c.database?.trim() || "0";
