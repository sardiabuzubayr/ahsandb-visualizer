import { describe, expect, it } from "vitest";
import type { DictNote, Dictionary, ErModel } from "../../types";
import { coverageTotals, dictDatabase, draftGroups, drafts, filterCoverage, incompleteTables, noteFor, tableCoverage } from "./dictionary";

const n = (table: string, column: string, note: string, status: DictNote["status"] = "verified", unsure = false): DictNote => ({
  table,
  column,
  note,
  status,
  evidence: "",
  unsure,
});

const model: ErModel = {
  tables: [
    { name: "bills", rows: "68k", columns: [{ name: "id", type: "int8", pk: true }, { name: "status", type: "int2" }, { name: "amount", type: "numeric" }] },
    { name: "carts", rows: "", columns: [{ name: "id", type: "int8", pk: true }] },
  ],
  relations: [],
};

const dict: Dictionary = {
  notes: [n("bills", "", "One bill per month"), n("bills", "status", "1 = active", "draft", true), n("bills", "amount", "")],
  terms: [{ term: "Paid", meaning: "No balance", mapsTo: "bills.outstanding = 0", status: "draft", evidence: "", unsure: false }],
  comments: [n("bills", "status", "status code"), n("bills", "amount", "Before discount")],
};

describe("data dictionary helpers", () => {
  it("saved notes win over comments; empty saved notes fall back", () => {
    expect(noteFor(dict, "bills", "status")).toMatchObject({ text: "1 = active", source: "draft" });
    expect(noteFor(dict, "bills", "amount")).toEqual({ text: "Before discount", source: "db" });
    expect(noteFor(dict, "bills", "id")).toEqual({ text: "", source: "missing" });
    expect(noteFor(dict, "bills", "")).toMatchObject({ source: "verified" });
  });

  it("coverage counts noted columns, drafts and descriptions", () => {
    const cov = tableCoverage(model, dict);
    expect(cov).toEqual([
      { name: "bills", noted: 2, columns: 3, drafts: 1, described: true },
      { name: "carts", noted: 0, columns: 1, drafts: 0, described: false },
    ]);
    expect(coverageTotals(cov)).toEqual({ tables: 1, tableCount: 2, columns: 2, columnCount: 4 });
    expect(filterCoverage(cov, "drafts").map((c) => c.name)).toEqual(["bills"]);
    expect(filterCoverage(cov, "missing").map((c) => c.name)).toEqual(["bills", "carts"]);
    expect(incompleteTables(cov).map((c) => c.name)).toEqual(["bills", "carts"]);
  });

  it("drafts split confident from unsure and group by table", () => {
    const d = drafts(dict);
    expect([d.total, d.confident, d.notes.length, d.terms.length]).toEqual([2, 1, 1, 1]);
    const groups = draftGroups([n("t", "b", "x", "draft"), n("t", "", "y", "draft"), n("u", "a", "z", "draft")]);
    expect(groups.map((g) => [g.table, g.notes.map((x) => x.column)])).toEqual([
      ["t", ["", "b"]],
      ["u", ["a"]],
    ]);
  });

  it("dictionary database per driver", () => {
    const node = { id: "c/shop/public/tables/bills", label: "bills", kind: "table" as const, schema: "public" };
    expect(dictDatabase("postgres", node)).toBe("shop");
    expect(dictDatabase("mysql", { ...node, schema: "shop_db" })).toBe("shop_db");
    expect(dictDatabase("sqlite", node)).toBe("main");
  });
});
