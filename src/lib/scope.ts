import type { SchemaNode } from "../types";

/** IPC id scoped to one database of a multi-database connection: "<connId>@<database>" (see commands.rs `conn_id`). */
export const scopedId = (connId: string, database?: string) => (database ? `${connId}@${database}` : connId);

/** Database a navigator node belongs to: second segment of its id ("<connId>/<database>/…").
 *  Roles live at "<connId>/roles", outside any database → undefined. */
export const nodeDatabase = (n: SchemaNode): string | undefined =>
  n.kind === "role" ? undefined : n.id.split("/")[1] || undefined;
