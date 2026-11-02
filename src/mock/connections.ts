// mock: sample connections for the browser-only dev mode.
import type { Connection, SchemaNode } from "../types";

const base = { readOnly: false, sslMode: "prefer", aiAccess: "schema" } as const;

export const mockConnections: Connection[] = [
  {
    ...base,
    id: "orders-prod",
    name: "orders-prod",
    folder: "Production",
    driver: "postgres",
    env: "prod",
    host: "10.0.12.4",
    port: 5432,
    database: "orders_db",
    user: "app_admin",
    connected: true,
    aiAccess: "data",
    serverVersion: "PostgreSQL 16.4",
    ssh: { host: "bastion-01.example.net", port: 22, user: "deploy", auth: "key", keyPath: "~/.ssh/id_ed25519" },
  },
  {
    ...base,
    id: "analytics-prod",
    name: "analytics-prod",
    folder: "Production",
    driver: "mysql",
    env: "prod",
    host: "10.0.14.8",
    port: 3306,
    database: "analytics",
    user: "reader",
    connected: false,
    serverVersion: "MySQL 8.4",
  },
  {
    ...base,
    id: "orders-staging",
    name: "orders-staging",
    folder: "Staging",
    driver: "postgres",
    env: "staging",
    host: "staging-db.internal",
    port: 5432,
    database: "orders_db, analytics",
    user: "app",
    connected: true,
    aiAccess: "data",
    serverVersion: "PostgreSQL 16.2",
  },
  {
    ...base,
    id: "shop-local",
    name: "shop-local",
    folder: "Local",
    driver: "mariadb",
    env: "dev",
    host: "localhost",
    port: 3306,
    database: "shop",
    user: "root",
    connected: true,
    aiAccess: "data",
    serverVersion: "MariaDB 11.4",
  },
  {
    ...base,
    id: "notes-db",
    name: "notes.db",
    folder: "Local",
    driver: "sqlite",
    env: "dev",
    file: "~/Projects/notes/notes.db",
    connected: false,
    serverVersion: "SQLite 3.46",
  },
];

const group = (id: string, label: string, count: number, children: SchemaNode[] = []): SchemaNode => ({
  id,
  label,
  kind: "group",
  count,
  children,
});

/** Size on disk per mock database, in bytes. */
const SIZES: Record<string, number> = { orders_db: 13_002_342, analytics: 1_288_490_189 };

const tables = ["customers", "order_items", "orders", "payments", "products"];

/** One database node with the orders schema; ids follow the backend's "<connId>/<database>/<schema>/…". */
function databaseNode(p: string, db: string, mysql: boolean): SchemaNode {
  const q = `${p}/${db}/public`;
  const events = mysql ? [group(`${q}/events`, "Events", 1, [{ id: `${q}/events/ev_purge_sessions`, label: "ev_purge_sessions", kind: "event" }])] : [];
  return {
    id: `${p}/${db}`,
    label: db,
    kind: "database",
    size: SIZES[db],
    children: [
      {
        id: q,
        label: "public",
        kind: "schema",
        children: [
          group(`${q}/tables`, "Tables", 12, [
            ...tables.map((t, i) => ({ id: `${q}/tables/${t}`, label: t, kind: "table" as const, size: [5_242_880, 81_920, 3_407_872, 1_310_720, 245_760][i % 5] })),
            { id: `${q}/tables/more`, label: "6 more…", kind: "more" as const },
          ]),
          group(`${q}/views`, "Views", 3, [
            { id: `${q}/views/v_daily_revenue`, label: "v_daily_revenue", kind: "view" },
            { id: `${q}/views/v_open_orders`, label: "v_open_orders", kind: "view" },
            { id: `${q}/views/v_top_customers`, label: "v_top_customers", kind: "view" },
          ]),
          group(`${q}/functions`, "Functions", 5, [{ id: `${q}/functions/fn_order_total`, label: "fn_order_total", kind: "function" }]),
          group(`${q}/procedures`, "Procedures", 2, [
            { id: `${q}/procedures/close_daily_orders`, label: "close_daily_orders", kind: "procedure" },
          ]),
          group(`${q}/triggers`, "Triggers", 4, [
            { id: `${q}/triggers/trg_orders_touch`, label: "trg_orders_touch", kind: "trigger" },
            { id: `${q}/triggers/trg_orders_updated`, label: "trg_orders_updated", kind: "trigger" },
          ]),
          group(`${q}/sequences`, "Sequences", 6, [{ id: `${q}/sequences/orders_id_seq`, label: "orders_id_seq", kind: "sequence" }]),
          ...events,
        ],
      },
    ],
  };
}

/**
 * Navigator tree for a connection id, or for "<connId>@<database>" just that (loaded) database node, like the backend.
 * orders-staging lists two databases, so its top level has both as lazy nodes; MySQL/MariaDB get an Events group.
 */
export function mockSchemaTree(id: string): SchemaNode[] {
  const [p, scoped] = id.split("@");
  const driver = mockConnections.find((c) => c.id === p)?.driver;
  const mysql = driver === "mysql" || driver === "mariadb";
  if (scoped) return [databaseNode(p, scoped, mysql)];
  const databases =
    p === "orders-staging"
      ? ["orders_db", "analytics"].map((db) => ({ id: `${p}/${db}`, label: db, kind: "database" as const, lazy: true, size: SIZES[db] }))
      : [databaseNode(p, "orders_db", mysql)];
  return [
    ...databases,
    {
      id: `${p}/roles`,
      label: "Roles",
      kind: "role",
      count: 7,
      children: ["analyst", "app_ro", "app_rw", "migrator", "reporting", "postgres"].map((r) => ({
        id: `${p}/roles/${r}`,
        label: r,
        kind: "role" as const,
      })),
    },
  ];
}
