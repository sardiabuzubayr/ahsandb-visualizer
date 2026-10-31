import dagre from "@dagrejs/dagre";

export type XY = { x: number; y: number };
export type Positions = Record<string, XY>;

/** Card size (see TableNode): 216 wide; header 34 + 22 per column + 12. */
export const CARD_W = 216;
export const cardHeight = (columns: number) => 34 + 22 * columns + 12;

/** Left-to-right dagre layout; edges point from the referenced table to the referencing one. Returns top-left corners. */
export function dagreLayout(tables: { id: string; columns: number }[], edges: { source: string; target: string }[]): Positions {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 48, ranksep: 96 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(tables.map((t) => t.id));
  for (const t of tables) g.setNode(t.id, { width: CARD_W, height: cardHeight(t.columns) });
  for (const e of edges) if (e.source !== e.target && ids.has(e.source) && ids.has(e.target)) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return Object.fromEntries(
    tables.map((t) => {
      const n = g.node(t.id);
      return [t.id, { x: n.x - CARD_W / 2, y: n.y - cardHeight(t.columns) / 2 }];
    }),
  );
}

/** Saved positions win; with nothing saved the whole schema is laid out; tables new since the last save stack to the right. */
export function initialPositions(
  tables: { id: string; columns: number }[],
  edges: { source: string; target: string }[],
  saved: Positions,
): Positions {
  const missing = tables.filter((t) => !saved[t.id]);
  if (missing.length === tables.length) return dagreLayout(tables, edges);
  const known = Object.values(saved);
  const x = Math.max(...known.map((p) => p.x)) + CARD_W + 72;
  let y = Math.min(...known.map((p) => p.y));
  const out: Positions = { ...saved };
  for (const t of missing) {
    out[t.id] = { x, y };
    y += cardHeight(t.columns) + 48;
  }
  return out;
}

export const positionsKey = (connectionId: string, schema: string) => `er-positions:${connectionId}:${schema}`;

/** Tolerates anything: bad JSON, wrong shapes and non-numbers come back as no positions. */
export function parsePositions(raw: string | null): Positions {
  try {
    const v: unknown = JSON.parse(raw ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Positions = {};
    for (const [k, p] of Object.entries(v as Record<string, Partial<XY> | null>)) {
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out[k] = { x: p.x!, y: p.y! };
    }
    return out;
  } catch {
    return {};
  }
}

// shortcut: positions live in localStorage per connection+schema (spec non-goal: backend storage).
export function loadPositions(key: string): Positions {
  try {
    return parsePositions(localStorage.getItem(key));
  } catch {
    return {};
  }
}

export function savePositions(key: string, positions: Positions): void {
  try {
    localStorage.setItem(key, JSON.stringify(positions));
  } catch {
    // Private mode or blocked storage: the layout just won't persist.
  }
}
