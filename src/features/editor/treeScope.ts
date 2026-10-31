import type { SchemaNode } from "../../types";

/**
 * Navigator nodes a tab may look in: the children of the database node named `database` (multi-database
 * PostgreSQL), else all nodes (no database, or no such node, e.g. a single-database tree).
 */
export function databaseNodes(nodes: SchemaNode[], database?: string): SchemaNode[] {
  const db = database ? nodes.find((n) => n.kind === "database" && n.label === database) : undefined;
  return db ? (db.children ?? []) : nodes;
}

/** Labels of the top-level database nodes. */
export const databaseNames = (nodes: SchemaNode[]): string[] => nodes.filter((n) => n.kind === "database").map((n) => n.label);

/** First entry of a connection's comma-separated database list ("shop, analytics" → "shop"); undefined when empty. */
export const firstDatabase = (list?: string): string | undefined =>
  list
    ?.split(",")
    .map((d) => d.trim())
    .find(Boolean);
