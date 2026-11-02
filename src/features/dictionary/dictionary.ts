// Pure helpers for the data dictionary tab: which note applies, coverage, drafts to review.
import type { DictNote, DictTerm, Dictionary, Driver, ErModel, SchemaNode } from "../../types";
import { nodeDatabase } from "../../lib/scope";

/** Where the note the agent uses comes from. */
export type NoteSource = "verified" | "draft" | "db" | "missing";

export interface ShownNote {
  text: string;
  source: NoteSource;
  /** The saved note (absent for database comments and missing notes). */
  saved?: DictNote;
}

/** Same rule as the backend (`Dictionary::note`): a saved note wins over the database comment. */
export function noteFor(d: Dictionary, table: string, column: string): ShownNote {
  const hit = (n: DictNote) => n.table === table && n.column === column && n.note.trim() !== "";
  const saved = d.notes.find(hit);
  if (saved) return { text: saved.note, source: saved.status, saved };
  const comment = d.comments.find(hit);
  return comment ? { text: comment.note, source: "db" } : { text: "", source: "missing" };
}

export interface TableCoverage {
  name: string;
  /** Columns with a note (any source). */
  noted: number;
  columns: number;
  drafts: number;
  /** The table itself has a description. */
  described: boolean;
}

export function tableCoverage(m: ErModel, d: Dictionary): TableCoverage[] {
  return m.tables.map((t) => ({
    name: t.name,
    noted: t.columns.filter((c) => noteFor(d, t.name, c.name).source !== "missing").length,
    columns: t.columns.length,
    drafts: d.notes.filter((n) => n.table === t.name && n.status === "draft").length,
    described: noteFor(d, t.name, "").source !== "missing",
  }));
}

/** A table "has notes" when it is described or any column has one. */
export const hasNotes = (c: TableCoverage) => c.described || c.noted > 0;

export function coverageTotals(cov: TableCoverage[]) {
  return {
    tables: cov.filter(hasNotes).length,
    tableCount: cov.length,
    columns: cov.reduce((n, c) => n + c.noted, 0),
    columnCount: cov.reduce((n, c) => n + c.columns, 0),
  };
}

export type TableFilter = "all" | "missing" | "drafts";

export function filterCoverage(cov: TableCoverage[], f: TableFilter): TableCoverage[] {
  if (f === "missing") return cov.filter((c) => c.noted < c.columns || !c.described);
  if (f === "drafts") return cov.filter((c) => c.drafts > 0);
  return cov;
}

/** Tables Learn schema would still help with: something undescribed. */
export const incompleteTables = (cov: TableCoverage[]) => cov.filter((c) => !c.described || c.noted < c.columns);

export interface Drafts {
  notes: DictNote[];
  terms: DictTerm[];
  /** Approve-confident count. */
  confident: number;
  total: number;
}

export function drafts(d: Dictionary): Drafts {
  const notes = d.notes.filter((n) => n.status === "draft");
  const terms = d.terms.filter((t) => t.status === "draft");
  const all = [...notes, ...terms];
  return { notes, terms, confident: all.filter((x) => !x.unsure).length, total: all.length };
}

/** Draft notes grouped by table, the table's own note first. */
export function draftGroups(notes: DictNote[]): { table: string; notes: DictNote[] }[] {
  const groups = new Map<string, DictNote[]>();
  for (const n of notes) groups.set(n.table, [...(groups.get(n.table) ?? []), n]);
  return [...groups.entries()].map(([table, ns]) => ({ table, notes: ns.sort((a, b) => (a.column === "" ? -1 : b.column === "" ? 1 : 0)) }));
}

/** Rough token count of the glossary the agent gets (the backend sends up to 6,000 characters ≈ 1,500 tokens). */
export const GLOSSARY_TOKENS = 1500;
export function glossaryTokens(terms: DictTerm[]): number {
  const chars = terms.reduce((n, t) => n + t.term.length + t.meaning.length + t.mapsTo.length + 8, 0);
  return Math.ceil(chars / 4);
}

/** Database a dictionary key uses for a navigator node (matches the backend's `dict::database_name`). */
export function dictDatabase(driver: Driver, n: SchemaNode): string | undefined {
  if (driver === "sqlite") return "main";
  if (driver === "postgres") return nodeDatabase(n);
  return n.schema;
}

export const markKey = (database: string | undefined, schema: string | undefined, table: string) => `${database ?? ""}|${schema ?? ""}|${table}`;

/** Fired after the dictionary changed elsewhere (agent card saved, Learn schema wrote drafts). */
export const DICT_CHANGED = "ahsandb:dict-changed";
export const dictChanged = () => window.dispatchEvent(new Event(DICT_CHANGED));
