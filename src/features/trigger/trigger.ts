import type { Driver, NodeKind, SchemaNode, Trigger } from "../../types";

export const NEW = "__new__";
export const PG_EVENTS = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"];
export const EVENTS = PG_EVENTS.slice(0, 3);
export const noInsteadOf = (driver: Driver) => driver === "mysql" || driver === "mariadb";

/**
 * Tab target: "<schema>.<name>", or "<schema>.__new__<ts>[:<table>]" for a new trigger.
 * `schema` may be "" (caller falls back to the connection default).
 */
export function triggerTarget(target: string): { schema: string; name: string; isNew: boolean; table: string } {
  const dot = target.indexOf(".");
  const schema = dot < 0 ? "" : target.slice(0, dot);
  const name = target.slice(dot + 1);
  if (!name.startsWith(NEW)) return { schema, name, isNew: false, table: "" };
  const colon = name.indexOf(":");
  return { schema, name: "", isNew: true, table: colon < 0 ? "" : name.slice(colon + 1) };
}

export function emptyTrigger(driver: Driver, schema: string, table: string): Trigger {
  return {
    schema,
    name: "",
    table,
    timing: "BEFORE",
    events: ["INSERT"],
    forEachRow: true,
    condition: undefined,
    body: driver === "postgres" ? "" : "BEGIN\n  \nEND",
  };
}

/** As saved/compared: trimmed body/condition, empty condition dropped, events in canonical order. */
export function normalize(t: Trigger): Trigger {
  return { ...t, events: PG_EVENTS.filter((e) => t.events.includes(e)), body: t.body.trim(), condition: t.condition?.trim() || undefined };
}

export const isDirty = (original: Trigger, current: Trigger) => JSON.stringify(normalize(original)) !== JSON.stringify(normalize(current));

/** Same rules as the backend's plan_trigger; returns an i18n key or null. */
export function validate(driver: Driver, t: Trigger): string | null {
  if (!t.name.trim()) return "trigger.err.name";
  if (!t.table.trim()) return "trigger.err.table";
  if (t.events.length === 0) return "trigger.err.events";
  if (driver !== "postgres" && (t.events.length !== 1 || t.events.includes("TRUNCATE"))) return "trigger.err.oneEvent";
  if (t.events.includes("TRUNCATE") && t.forEachRow) return "trigger.err.truncateRow";
  if (t.timing === "INSTEAD OF" && noInsteadOf(driver)) return "trigger.err.insteadOf";
  if (!t.body.trim()) return "trigger.err.body";
  return null;
}

/**
 * Labels of tree nodes of `kinds` in `schema`. A node's schema is its own `schema` field, else the
 * nearest schema/database ancestor's label (the mock tree leaves `schema` unset).
 */
export function objectsIn(nodes: SchemaNode[], schema: string, kinds: NodeKind[], ctx = ""): string[] {
  return nodes.flatMap((n) => {
    const here = n.kind === "schema" || n.kind === "database" ? n.label : ctx;
    const self = kinds.includes(n.kind) && (n.schema ?? here) === schema ? [n.label] : [];
    return [...self, ...(n.children ? objectsIn(n.children, schema, kinds, here) : [])];
  });
}
