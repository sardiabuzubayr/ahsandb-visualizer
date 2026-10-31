// mock: a sample agent conversation for the browser-only dev mode (data, so it stays in Indonesian).
import type { AgentMessage } from "../types";

export const mockAgentMessages: AgentMessage[] = [
  { id: "r1", role: "user", text: "Berapa order per status bulan ini?" },
  {
    id: "r2",
    role: "agent",
    steps: [{ label: "Running query", detail: "SELECT status, count(*) AS orders\nFROM orders\nWHERE created_at >= date_trunc('month', now())\nGROUP BY status ORDER BY orders DESC" }],
    text: "Bulan ini ada **1.240 order**. Rinciannya:\n\n- **`paid`**: 1.102 order\n- **`shipped`**: 100 order\n- **`pending`**: 38 order, perlu ditindaklanjuti\n\n| status | order |\n|---|---:|\n| paid | 1102 |\n| pending | 38 |\n\nMau saya cek order `pending` yang lebih dari *3 hari*?",
  },
  {
    id: "r3",
    role: "result",
    sql: "SELECT status, count(*) AS orders FROM orders WHERE created_at >= date_trunc('month', now()) GROUP BY status ORDER BY orders DESC",
    columns: [
      { name: "status", type: "text" },
      { name: "orders", type: "bigint", numeric: true },
    ],
    rows: [
      ["delivered", 902],
      ["shipped", 214],
      ["paid", 61],
      ["pending", 38],
      ["cancelled", 19],
      ["refunded", 6],
    ],
    truncated: false,
    elapsedMs: 9,
  },
  {
    id: "m1",
    role: "user",
    text: "Hapus tabel order_items_backup_2024, udah nggak dipakai. Terus buatin tabel shipments buat nyimpen kurir dan nomor resi per order.",
  },
  {
    id: "m2",
    role: "agent",
    steps: [
      { label: "Read schema", detail: "public · 7 tables" },
      { label: "Counted rows", detail: "order_items_backup_2024 → 38,214" },
      { label: "Checked dependencies", detail: "FK, views, triggers" },
    ],
    text: "Saya pecah jadi dua langkah. Membuat shipments tidak menghapus apa pun, jadi cukup disetujui sekali klik. Menghapus tabel backup itu permanen, jadi saya jelaskan dampaknya dulu.",
  },
  {
    id: "m3",
    role: "action",
    level: "change",
    title: "CREATE TABLE public.shipments",
    sql: "(id bigserial PRIMARY KEY, order_id bigint\n NOT NULL REFERENCES orders(id), carrier text\n NOT NULL, tracking_no text, created_at …)",
    status: "done",
    impact: [],
    facts: [],
    elapsedMs: 18,
    outcome: "Table created",
  },
  {
    id: "m4",
    role: "action",
    level: "critical",
    title: "DROP TABLE public.order_items_backup_2024",
    sql: "DROP TABLE public.order_items_backup_2024;",
    status: "pending",
    confirmName: "order_items_backup_2024",
    impact: [
      "38.214 baris terhapus permanen. Aplikasi tidak bisa membatalkannya.",
      "Ruang 4,1 MB dibebaskan.",
      "Tidak ada foreign key, view, atau trigger yang bergantung pada tabel ini, jadi tidak ada objek lain yang ikut rusak.",
      "Kalau masih ragu, ekspor dulu tabelnya ke file SQL.",
    ],
    facts: ["38.214 baris (dihitung dari database)", "Tidak ada FK, view, atau trigger yang bergantung", "Tidak bisa dibatalkan"],
  },
];
