// mock: rows of public.orders for the data viewer.
import type { Cell, Column, PendingChange } from "../types";

export const ordersColumns: Column[] = [
  { name: "id", type: "bigserial", numeric: true, pk: true },
  { name: "customer_id", type: "bigint", numeric: true, fk: true },
  { name: "status", type: "order_status", enumValues: ["pending", "paid", "shipped", "cancelled"] },
  { name: "total", type: "numeric(14,2)", numeric: true },
  { name: "note", type: "text" },
  { name: "created_at", type: "timestamptz" },
];

export const ordersRows: Cell[][] = [
  [10198, 1042, "cancelled", "1250000.00", null, "2026-10-20 08:14"],
  [10203, 1121, "shipped", "4725000.00", "Gudang B", "2026-10-20 13:40"],
  [10211, 1078, "paid", "980000.00", null, "2026-10-21 07:55"],
  [10219, 1033, "paid", "2310500.00", "Reseller", "2026-10-21 15:12"],
  [10231, 1187, "pending", "3480000.00", "Kirim via JNE", "2026-10-22 09:02"],
  [10232, 1009, "pending", "845500.00", null, "2026-10-22 10:41"],
  [10233, 1310, "pending", "12900000.00", "Partial payment", "2026-10-22 11:05"],
  [10234, 1256, "pending", "610000.00", null, "2026-10-22 13:27"],
  [10240, 1155, "paid", "1775250.00", null, "2026-10-22 16:48"],
  [10247, 1291, "pending", "5600000.00", "Termin 2", "2026-10-23 08:30"],
  [10251, 1366, "paid", "730000.00", null, "2026-10-23 10:02"],
  [10258, 1402, "shipped", "2040000.00", null, "2026-10-23 11:19"],
  [10262, 1042, "pending", "9150000.00", "Kontrak Q4", "2026-10-23 14:51"],
  [10266, 1187, "paid", "415000.00", null, "2026-10-23 17:06"],
  [10270, 1009, "pending", "1320000.00", null, "2026-10-24 07:44"],
];

/** Pending changes the demo opens with. */
export const ordersInitialChanges: PendingChange[] = [
  { kind: "update", rowKey: "10231", column: "status", from: "pending", to: "shipped" },
  {
    kind: "insert",
    tempId: "new-1",
    values: { customer_id: 1402, status: "pending", total: "2150000.00", note: "Manual order", created_at: null },
  },
  { kind: "delete", rowKey: "10198" },
];

