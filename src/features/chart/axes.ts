import type { Column } from "../../types";

const MEASURE = /numeric|decimal|float|double|real|money/i;
const ID_LIKE = /^id$|_id$/i;

/** First text column → X; a measure-like numeric column → Y. Null when nothing can be charted. */
export function suggestAxes(columns: Column[]): { x: string; y: string } | null {
  const x = columns.find((c) => !c.numeric) ?? columns[0];
  const nums = columns.filter((c) => c.numeric && c !== x);
  const y = nums.find((c) => MEASURE.test(c.type)) ?? nums.find((c) => !ID_LIKE.test(c.name)) ?? nums[0];
  return x && y ? { x: x.name, y: y.name } : null;
}
