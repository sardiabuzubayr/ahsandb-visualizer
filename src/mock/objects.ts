// mock: ER schema, routine, roles and privileges for the browser-only dev mode.
import type { ErRelation, ErTable, PrivilegeRow, Role, Routine, Trigger, ViewDef } from "../types";

export const erTables: ErTable[] = [
  {
    name: "customers", rows: "2.4k", x: 48, y: 48,
    columns: [
      { name: "id", type: "bigserial", pk: true }, { name: "name", type: "text" },
      { name: "email", type: "text" }, { name: "city", type: "text" },
      { name: "created_at", type: "timestamptz" },
    ],
  },
  {
    name: "orders", rows: "12.4k", x: 336, y: 48,
    columns: [
      { name: "id", type: "bigserial", pk: true }, { name: "customer_id", type: "bigint", fk: true },
      { name: "status", type: "text" }, { name: "total", type: "numeric(14,2)" },
      { name: "created_at", type: "timestamptz" }, { name: "shipped_at", type: "timestamptz", draft: true },
    ],
  },
  {
    name: "order_items", rows: "41k", x: 624, y: 48,
    columns: [
      { name: "id", type: "bigserial", pk: true }, { name: "order_id", type: "bigint", fk: true },
      { name: "product_id", type: "bigint", fk: true }, { name: "qty", type: "integer" },
      { name: "price", type: "numeric(14,2)" },
    ],
  },
  {
    name: "products", rows: "860", x: 624, y: 300,
    columns: [
      { name: "id", type: "bigserial", pk: true }, { name: "sku", type: "text" },
      { name: "name", type: "text" }, { name: "price", type: "numeric(14,2)" },
    ],
  },
  {
    name: "payments", rows: "11.9k", x: 336, y: 330,
    columns: [
      { name: "id", type: "bigserial", pk: true }, { name: "order_id", type: "bigint", fk: true },
      { name: "method", type: "text" }, { name: "amount", type: "numeric(14,2)" },
      { name: "paid_at", type: "timestamptz" },
    ],
  },
  {
    name: "shipments", rows: "", x: 48, y: 330, draft: true,
    columns: [
      { name: "id", type: "bigserial", pk: true }, { name: "order_id", type: "bigint", fk: true },
      { name: "carrier", type: "text" }, { name: "tracking_no", type: "text" },
      { name: "created_at", type: "timestamptz" },
    ],
  },
];

export const erRelations: ErRelation[] = [
  { id: "orders-customers", from: "orders", fromColumn: "customer_id", to: "customers", toColumn: "id" },
  { id: "items-orders", from: "order_items", fromColumn: "order_id", to: "orders", toColumn: "id" },
  { id: "items-products", from: "order_items", fromColumn: "product_id", to: "products", toColumn: "id" },
  { id: "payments-orders", from: "payments", fromColumn: "order_id", to: "orders", toColumn: "id" },
  { id: "shipments-orders", from: "shipments", fromColumn: "order_id", to: "orders", toColumn: "id", draft: true },
];

export const erDraftSql = `BEGIN;

CREATE TABLE public.shipments (
  id          bigserial PRIMARY KEY,
  order_id    bigint NOT NULL,
  carrier     text NOT NULL,
  tracking_no text,
  created_at  timestamptz NOT NULL
              DEFAULT now()
);

ALTER TABLE public.shipments
  ADD CONSTRAINT shipments_order_id_fkey
  FOREIGN KEY (order_id)
  REFERENCES public.orders (id);

ALTER TABLE public.orders
  ADD COLUMN shipped_at timestamptz;

COMMIT;`;

export const mockRoutine: Routine = {
  kind: "procedure",
  name: "close_daily_orders",
  database: "shop",
  security: "definer",
  params: [
    { mode: "IN", name: "p_date", type: "DATE" },
    { mode: "IN", name: "p_dry_run", type: "BOOLEAN" },
    { mode: "OUT", name: "p_closed", type: "INT" },
  ],
  body: `BEGIN
  DECLARE v_count INT DEFAULT 0;

  SELECT COUNT(*) INTO v_count
    FROM orders
   WHERE DATE(created_at) = p_date
     AND status = 'paid';

  IF NOT p_dry_run THEN
    UPDATE orders
       SET status = 'closed'
     WHERE DATE(created_at) = p_date
       AND status = 'paid';
  END IF;

  SET p_closed = v_count;
END`,
};

const attrs = (login: boolean, superuser = false, inherit = true) => ({
  login, superuser, createdb: false, createrole: false, inherit, replication: false,
});

export const mockRoles: Role[] = [
  { name: "analyst", tag: "login", attrs: attrs(true), connLimit: 10, memberOf: ["reporting"] },
  { name: "app_ro", tag: "login", attrs: attrs(true), memberOf: [] },
  { name: "app_rw", tag: "login", attrs: attrs(true), memberOf: [] },
  { name: "migrator", tag: "login", attrs: attrs(true), memberOf: [] },
  { name: "reporting", tag: "group", attrs: attrs(false), memberOf: [] },
  { name: "postgres", tag: "superuser", attrs: attrs(true, true), memberOf: [] },
];

// Order matches PRIVILEGES: SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES USAGE CREATE EXECUTE.
// Original (saved) state; the demo's two changes are applied on top by the Roles tab.
export const analystPrivileges: PrivilegeRow[] = [
  { kind: "schema", name: "public", cells: ["na", "na", "na", "na", "na", "na", "on", "off", "na"] },
  { kind: "table", name: "customers", cells: ["on", "off", "off", "off", "off", "off", "na", "na", "na"] },
  { kind: "table", name: "orders", cells: ["on", "off", "on", "off", "off", "off", "na", "na", "na"] },
  { kind: "table", name: "order_items", cells: ["on", "off", "off", "off", "off", "off", "na", "na", "na"] },
  { kind: "table", name: "payments", cells: ["off", "off", "off", "off", "off", "off", "na", "na", "na"] },
  { kind: "table", name: "products", cells: ["on", "off", "off", "off", "off", "off", "na", "na", "na"] },
  { kind: "view", name: "v_daily_revenue", cells: ["on", "na", "na", "na", "na", "na", "na", "na", "na"] },
  { kind: "sequence", name: "orders_id_seq", cells: ["off", "na", "off", "na", "na", "na", "off", "na", "na"] },
  { kind: "function", name: "fn_order_total(bigint)", cells: ["na", "na", "na", "na", "na", "na", "na", "na", "on"] },
];

export const mockTrigger: Trigger = {
  schema: "public",
  name: "trg_orders_touch",
  table: "orders",
  timing: "BEFORE",
  events: ["INSERT", "UPDATE"],
  forEachRow: true,
  condition: undefined,
  body: "public.trg_touch()",
};

export const mockView: ViewDef = {
  schema: "public",
  name: "v_open_orders",
  query: "SELECT o.id, c.name, o.total\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nWHERE o.status = 'pending'",
};
