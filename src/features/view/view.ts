import type { ViewDef } from "../../types";

/** Name part of a new-view tab target: `"<schema>.__new__<ts>"`. */
export const NEW_PREFIX = "__new__";

/** Tab target `"<schema>.<name>"` (split at the first dot) → what to load, or a new view. */
export function parseTarget(target: string) {
  const dot = target.indexOf(".");
  const schema = dot < 0 ? "" : target.slice(0, dot);
  const name = target.slice(dot + 1);
  return { schema, name, isNew: name.startsWith(NEW_PREFIX) };
}

export const emptyView = (schema: string): ViewDef => ({ schema, name: "", query: "" });

/** The query as saved and previewed: no surrounding whitespace, no trailing `;`. */
export const normalizeQuery = (q: string) => q.replace(/[\s;]+$/, "").trim();

/** The view as sent to the backend. */
export const normalizeView = (v: ViewDef): ViewDef => ({ ...v, name: v.name.trim(), query: normalizeQuery(v.query) });

export const isDirty = (original: ViewDef, current: ViewDef) =>
  JSON.stringify(normalizeView(original)) !== JSON.stringify(normalizeView(current));

/** First problem that blocks saving, as an i18n key; null when the view can be saved. */
export function validate(v: ViewDef): string | null {
  if (v.name.trim() === "") return "view.nameRequired";
  if (normalizeQuery(v.query) === "") return "view.queryRequired";
  return null;
}
