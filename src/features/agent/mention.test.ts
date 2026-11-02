import { describe, expect, it } from "vitest";
import { insertMention, matchTables, mentionAt } from "./mention";

describe("@table mentions", () => {
  it("finds the mention at the caret, not inside emails", () => {
    expect(mentionAt("Jelaskan table @bill_of", 23)).toEqual({ start: 15, query: "bill_of" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("(@inv", 5)).toEqual({ start: 1, query: "inv" });
    expect(mentionAt("mail me@host", 12)).toBeNull();
    expect(mentionAt("@bills done", 11)).toBeNull();
    expect(mentionAt("@bills done", 6)).toEqual({ start: 0, query: "bills" });
  });

  it("prefix matches first, then contains", () => {
    const tables = ["invoice_items", "bill_list", "invoices", "payment_bill", "santri"];
    expect(matchTables(tables, "bill")).toEqual(["bill_list", "payment_bill"]);
    expect(matchTables(tables, "INV")).toEqual(["invoice_items", "invoices"]);
    expect(matchTables(tables, "", 2)).toEqual(["bill_list", "invoice_items"]);
  });

  it("replaces the typed mention and keeps the rest", () => {
    expect(insertMention("Jelaskan @bil", { start: 9, query: "bil" }, 13, "bill_list")).toEqual({ text: "Jelaskan @bill_list ", caret: 20 });
    expect(insertMention("@bi dan @x", { start: 0, query: "bi" }, 3, "bill_list")).toEqual({ text: "@bill_list dan @x", caret: 10 });
  });
});
