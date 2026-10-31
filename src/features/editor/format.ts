import type { Cell } from "../../types";

/** Decimal strings get en-US thousands separators without losing precision; numbers (ids, counts) stay raw. */
export function formatCell(v: Cell, numeric?: boolean): string {
  if (v === null) return "NULL";
  const s = String(v);
  const m = numeric && typeof v === "string" ? /^(-?)(\d+)(\.\d+)?$/.exec(s) : null;
  return m ? m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (m[3] ?? "") : s;
}
