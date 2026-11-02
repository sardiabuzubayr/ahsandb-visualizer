// mock: an in-memory data dictionary for the browser-only dev mode, plus a fake "Learn schema" run.
import type { DictMark, DictNote, DictTerm, Dictionary, LearnEvent, LearnOptions } from "../types";

const note = (table: string, column: string, text: string, status: DictNote["status"] = "verified", evidence = "", unsure = false): DictNote => ({
  table,
  column,
  note: text,
  status,
  evidence,
  unsure,
});

const dicts = new Map<string, { notes: DictNote[]; terms: DictTerm[] }>([
  [
    "orders-staging|public",
    {
      notes: [
        note("orders", "", "One checkout by a customer. Items are in order_items, payments in payments."),
        note("orders", "customer_id", "Customer who placed the order (customers.id)."),
        note("orders", "status", "open = not paid yet, paid, shipped, cancelled.", "draft", "Distinct values: open (61%), paid (30%), shipped (7%), cancelled (2%)"),
        note("orders", "total", "Order total after discounts, in rupiah.", "draft", "Guessed from the column name only", true),
        note("payments", "method", "1 = cash, 2 = transfer, 3 = wallet.", "draft", "Distinct values: 1 (71%), 2 (24%), 3 (5%). Meanings are guessed", true),
        note("customers", "", "People who buy in the shop."),
      ],
      terms: [
        { term: "Paid order", meaning: "An order with a completed payment.", mapsTo: "orders.status = 'paid'", status: "verified", evidence: "", unsure: false },
        { term: "Open order", meaning: "Placed but not paid yet.", mapsTo: "orders.status = 'open'", status: "verified", evidence: "", unsure: false },
        { term: "Repeat customer", meaning: "A customer with more than one paid order.", mapsTo: "customers + orders", status: "draft", evidence: "Not in the data; common term", unsure: true },
      ],
    },
  ],
]);

// The mock tree has no database in scoped ids for most connections; key by bare connection + schema.
const keyOf = (id: string, schema: string) => `${id.split("@")[0]}|${schema}`;
const get = (id: string, schema: string) => {
  const k = keyOf(id, schema);
  if (!dicts.has(k)) dicts.set(k, { notes: [], terms: [] });
  return dicts.get(k)!;
};

export const mockDictGet = (id: string, schema: string): Dictionary => {
  const d = get(id, schema);
  const comments = schema === "public" ? [note("order_items", "qty", "Units ordered (database comment)")] : [];
  return structuredClone({ notes: d.notes, terms: d.terms, comments });
};

export function mockDictPutNote(id: string, schema: string, n: DictNote) {
  const d = get(id, schema);
  d.notes = d.notes.filter((x) => !(x.table === n.table && x.column === n.column));
  if (n.note.trim()) d.notes.push({ ...n, note: n.note.trim() });
}

export function mockDictDeleteNote(id: string, schema: string, table: string, column: string) {
  const d = get(id, schema);
  d.notes = d.notes.filter((x) => !(x.table === table && x.column === column));
}

export function mockDictPutTerm(id: string, schema: string, t: DictTerm, previous: string | null) {
  const d = get(id, schema);
  if (previous !== t.term && d.terms.some((x) => x.term === t.term)) throw new Error(`The glossary already has "${t.term}"`);
  d.terms = d.terms.filter((x) => x.term !== (previous ?? t.term) && x.term !== t.term);
  d.terms.push(t);
}

export function mockDictDeleteTerm(id: string, schema: string, term: string) {
  const d = get(id, schema);
  d.terms = d.terms.filter((x) => x.term !== term);
}

export function mockDictResolve(id: string, schema: string, approve: boolean, includeUnsure: boolean): number {
  const d = get(id, schema);
  const hit = (x: { status: string; unsure: boolean }) => x.status === "draft" && (includeUnsure || !x.unsure);
  const n = d.notes.filter(hit).length + d.terms.filter(hit).length;
  const fix = <T extends { status: DictNote["status"]; unsure: boolean }>(xs: T[]) =>
    approve ? xs.map((x) => (hit(x) ? { ...x, status: "verified" as const } : x)) : xs.filter((x) => !hit(x));
  d.notes = fix(d.notes);
  d.terms = fix(d.terms);
  return n;
}

export function mockDictMarks(id: string): DictMark[] {
  const bare = id.split("@")[0];
  return [...dicts.entries()].flatMap(([k, d]) => {
    const [conn, schema] = k.split("|");
    if (conn !== bare) return [];
    const tables = [...new Set(d.notes.map((n) => n.table))];
    return tables.map((table) => ({ database: "orders_db", schema, table, draft: d.notes.some((n) => n.table === table && n.status === "draft") }));
  });
}

export const mockLearnListeners = new Set<(e: LearnEvent) => void>();
const stopped = new Set<string>();

/** Walks the tables on a timer and writes a draft for each column without a note. */
export function mockDictLearn(id: string, schema: string, o: LearnOptions, tables: { name: string; columns: { name: string }[] }[]) {
  const k = keyOf(id, schema);
  stopped.delete(k);
  const picked = tables.filter((t) => !o.tables.length || o.tables.includes(t.name));
  let drafts = 0;
  const emit = (e: Omit<LearnEvent, "id" | "schema">) => mockLearnListeners.forEach((cb) => cb({ id, schema, ...e }));
  const step = (i: number) => {
    if (i >= picked.length || stopped.has(k)) return emit({ done: i, total: picked.length, current: "", drafts, finished: true, error: null });
    const t = picked[i];
    emit({ done: i, total: picked.length, current: t.name, drafts, finished: false });
    setTimeout(() => {
      const d = get(id, schema);
      for (const c of t.columns.filter((c) => c.name !== "id")) {
        if (d.notes.some((n) => n.table === t.name && n.column === c.name)) continue;
        const unsure = c.name.endsWith("_at");
        d.notes.push(note(t.name, c.name, `${c.name.replace(/_/g, " ")} of the ${t.name.replace(/s$/, "")}.`, "draft", o.samples ? "Sample values" : "Column name", unsure));
        drafts++;
      }
      step(i + 1);
    }, 700);
  };
  setTimeout(() => step(0), 200);
}

export const mockDictLearnStop = (id: string, schema: string) => void stopped.add(keyOf(id, schema));
