import { describe, expect, it } from "vitest";
import type { NoteItem } from "../../types";
import { notePicks } from "./NoteCard";

const item = (after: string): NoteItem => ({ table: "orders", column: "status", term: "", mapsTo: "", before: "", after });

describe("dictionary card picks", () => {
  it("sends only checked, non-empty entries with their edited text", () => {
    const items = [item("a"), item("b"), item("c")];
    expect(notePicks(items, [true, false, true], [" a2 ", "b", ""])).toEqual([{ index: 0, text: "a2" }]);
    expect(notePicks(items, [true, true, true], ["a", "b", "c"])).toHaveLength(3);
  });
});
