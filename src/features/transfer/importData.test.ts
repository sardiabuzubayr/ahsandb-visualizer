import { describe, expect, it } from "vitest";
import { mockSchemaTree } from "../../mock/connections";
import type { ColumnDef, FileOptions } from "../../types";
import { autoMap, buildImportOptions, canImport, checkMapping, formatOf, landedRows, mappingOf, newColumns, treeTables } from "./importData";

const file: FileOptions = { path: "~/x.csv", format: "csv", delimiter: ",", header: true, encoding: "UTF-8" };
const col = (name: string, p: Partial<ColumnDef> = {}): ColumnDef => ({ name, type: "text", nullable: true, autoIncrement: false, ...p });

describe("autoMap", () => {
  it("matches case-insensitively, ignoring _, - and spaces; unmatched → skip", () => {
    expect(autoMap(["Name", "E-mail", "Tgl Daftar", "Catatan"], ["id", "name", "email", "tgl_daftar"])).toEqual([
      "name",
      "email",
      "tgl_daftar",
      null,
    ]);
  });
  it("uses each target once", () => {
    expect(autoMap(["name", "NAME"], ["name"])).toEqual(["name", null]);
  });
});

describe("buildImportOptions", () => {
  it("existing table: mapping skips unmapped columns, no create", () => {
    const o = buildImportOptions({ file, schema: "public", table: "customers", targets: ["name", null, "city"], onError: "skip", emptyAsNull: true });
    expect(o).toEqual({
      file,
      schema: "public",
      table: "customers",
      mapping: [
        { source: 0, target: "name" },
        { source: 2, target: "city" },
      ],
      onError: "skip",
      emptyAsNull: true,
    });
    expect("create" in o).toBe(false);
  });

  it("new table: create holds only the included columns, names trimmed", () => {
    const cols = newColumns(["name", "email", "joined"], ["text", "text", "date"]);
    cols[1].include = false;
    cols[2].name = " joined_at ";
    const o = buildImportOptions({ file, schema: "public", table: " leads ", targets: [], newTable: cols, onError: "stop", emptyAsNull: false });
    expect(o.table).toBe("leads");
    expect(o.mapping).toEqual([
      { source: 0, target: "name" },
      { source: 2, target: "joined_at" },
    ]);
    expect(o.create).toEqual({
      schema: "public",
      name: "leads",
      columns: [col("name"), col("joined_at", { type: "date" })],
      primaryKey: [],
      foreignKeys: [],
      indexes: [],
      checks: [],
    });
  });
});

describe("checkMapping", () => {
  const target = [col("id", { nullable: false, autoIncrement: true }), col("name", { nullable: false }), col("status", { nullable: false, default: "'new'" }), col("city")];

  it("warns about NOT NULL columns without default that are not mapped", () => {
    const c = checkMapping(mappingOf(["city"]), target);
    expect(c).toEqual({ duplicates: [], missingRequired: ["name"], blank: false });
    expect(canImport(mappingOf(["city"]), c)).toBe(true);
  });

  it("errors on a target mapped twice", () => {
    const m = mappingOf(["name", "name", "city"]);
    const c = checkMapping(m, target);
    expect(c.duplicates).toEqual(["name"]);
    expect(canImport(m, c)).toBe(false);
  });

  it("nothing mapped cannot import", () => {
    expect(canImport([], checkMapping([], target))).toBe(false);
  });

  it("new table: blank table or column name blocks, duplicate names are errors", () => {
    const cols = newColumns(["a", "A"], ["text", "text"]);
    const c = checkMapping(mappingOf([], cols), undefined, { table: "", columns: cols });
    expect(c.blank).toBe(true);
    expect(c.duplicates).toEqual(["a", "A"]);
    cols[1].include = false;
    expect(checkMapping(mappingOf([], cols), undefined, { table: "t", columns: cols })).toEqual({ duplicates: [], missingRequired: [], blank: false });
  });
});

describe("misc", () => {
  it("detects the format from the extension", () => {
    expect(formatOf("/a/b.JSON")).toBe("json");
    expect(formatOf("/a/b.csv")).toBe("csv");
    expect(formatOf("/a/b.txt")).toBe("csv");
  });

  it("landedRows keeps mapped columns and turns empty into NULL", () => {
    const m = mappingOf([null, "b", "a"]);
    expect(landedRows([["x", "", "1"]], m, true)).toEqual([[null, "1"]]);
    expect(landedRows([["x", "", "1"]], m, false)).toEqual([["", "1"]]);
  });

  it("treeTables lists tables with their schema, filtered by database", () => {
    const all = treeTables(mockSchemaTree("orders-prod"));
    expect(all[0]).toEqual({ schema: "public", table: "customers" });
    expect(all.some((t) => t.table === "6 more…")).toBe(false);
    expect(treeTables(mockSchemaTree("orders-prod"), "nope")).toEqual([]);
  });
});
