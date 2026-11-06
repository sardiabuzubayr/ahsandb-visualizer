// mock: query results and SQL samples for the browser-only dev mode.
import type { Cell, Column, ResultSet } from "../types";

const revenueRows: Cell[][] = [
  [1042, "PT Sinar Jaya Abadi", 38, "184250000.00"],
  [1187, "CV Maju Bersama", 31, "152780500.00"],
  [1009, "Toko Mekar Sari", 29, "139400000.00"],
  [1310, "PT Nusantara Logistik", 24, "121975250.00"],
  [1256, "UD Berkah Tani", 22, "98310000.00"],
  [1121, "PT Cahaya Digital", 19, "87640750.00"],
  [1078, "Koperasi Sejahtera", 18, "80115000.00"],
  [1402, "CV Rumah Kopi", 16, "71560000.00"],
  [1033, "PT Arunika Media", 14, "64980500.00"],
  [1291, "Toko Bangunan Sentosa", 13, "58200000.00"],
  [1155, "PT Delta Farma", 12, "51775000.00"],
  [1366, "CV Laut Biru", 11, "47300250.00"],
];

export const revenueColumns: Column[] = [
  { name: "id", type: "int8", numeric: true, origin: { schema: "public", table: "customers", column: "id" } },
  { name: "name", type: "text", origin: { schema: "public", table: "customers", column: "name" } },
  { name: "orders", type: "int8", numeric: true },
  { name: "revenue", type: "numeric", numeric: true },
];

const mockSql = `-- Revenue per customer, last 30 days
SELECT c.id, c.name, COUNT(o.id) AS orders, SUM(o.total) AS revenue
FROM customers c JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.name ORDER BY revenue DESC LIMIT 50;`;

export const mockResults: (ResultSet & { sql?: string })[] = [
  { id: "r1", label: "Result 1", columns: revenueColumns, rows: revenueRows, elapsedMs: 42, sql: mockSql.split(";")[0].replace(/^--.*\n/, "") },
  { id: "r2", label: "Result 2", columns: [], rows: [], elapsedMs: 8, affected: 3 },
];
