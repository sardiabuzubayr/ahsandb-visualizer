import type { Cell, Driver, ParamMode, Routine, RoutineParam, SchemaNode } from "../../types";

export type RoutineKind = Routine["kind"];

export const isBool = (type: string) => /^bool/i.test(type);

/** Function parameters are always IN, whatever the form last held. */
export const modeOf = (r: Routine, p: RoutineParam): ParamMode => (r.kind === "function" ? "IN" : p.mode);

/** The routine as saved/compared: procedures carry no `returns`, function params are IN. */
export function normalize(r: Routine): Routine {
  return { ...r, returns: r.kind === "function" ? r.returns : undefined, params: r.params.map((p) => ({ ...p, mode: modeOf(r, p) })) };
}

export const isDirty = (original: Routine, current: Routine) =>
  JSON.stringify(normalize(original)) !== JSON.stringify(normalize(current));

/** Run-form value of one parameter; `isNull` is the explicit NULL toggle. */
export interface ArgInput {
  value: string;
  isNull: boolean;
}

/**
 * One Cell per IN/INOUT parameter, in declaration order. Empty text stays '' (NULL only via the
 * toggle); booleans are "1"/"0", which both PostgreSQL and MySQL/MariaDB accept for their bool types.
 */
export function runArgs(r: Routine, inputs: Record<string, ArgInput>): Cell[] {
  return r.params
    .filter((p) => modeOf(r, p) !== "OUT")
    .map((p) => {
      const a = inputs[p.name] ?? { value: isBool(p.type) ? "0" : "", isNull: false };
      return a.isNull ? null : a.value;
    });
}

function findRoutine(nodes: SchemaNode[], name: string, schema?: string): SchemaNode | undefined {
  for (const n of nodes) {
    if ((n.kind === "function" || n.kind === "procedure") && n.label === name && (!schema || n.schema === schema)) return n;
    const hit = n.children && findRoutine(n.children, name, schema);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * What to load for a routine tab: target is "name" (navigator) or "schema.name". The navigator tree,
 * when loaded, tells the schema and function/procedure; otherwise the connection default is used.
 */
export function routineTarget(target: string, driver: Driver, database: string | undefined, tree?: SchemaNode[]) {
  const dot = target.indexOf(".");
  const name = dot < 0 ? target : target.slice(dot + 1);
  const node = tree && findRoutine(tree, name, dot < 0 ? undefined : target.slice(0, dot));
  const fallback = driver === "postgres" ? "public" : driver === "sqlite" ? "main" : (database ?? "");
  const schema = dot >= 0 ? target.slice(0, dot) : (node?.schema ?? fallback);
  // shortcut: Tab has no routine kind; without a tree node try procedure, then function on NotFound.
  const kinds: RoutineKind[] = node ? [node.kind as RoutineKind] : ["procedure", "function"];
  return { schema, name, kinds };
}
