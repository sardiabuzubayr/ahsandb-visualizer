// shortcut: a new SQL tab can't carry initial text (Tab has no field and its id is made in the reducer), so the
// opener queues the text per connection right before `openTab` and the next SqlEditorTab mounted for that
// connection takes it. Move it onto the tab/openTab action when the state contract next changes.
const queued = new Map<string, string>();

/** Call right before dispatching `openTab` (kind "sql") for `connectionId`. */
export const queueSql = (connectionId: string, sql: string) => void queued.set(connectionId, sql);

/** Read without consuming (safe in a useState initializer, which StrictMode runs twice). */
export const peekQueuedSql = (connectionId: string) => queued.get(connectionId);

export const dropQueuedSql = (connectionId: string) => void queued.delete(connectionId);
