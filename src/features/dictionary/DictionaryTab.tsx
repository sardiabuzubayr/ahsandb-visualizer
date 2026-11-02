import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { BookOpen, Check, ChevronLeft, Loader2, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import { scopedId } from "../../lib/scope";
import { useApp, useConnection, useToast } from "../../state/app";
import { useConnectionError } from "../../components/shell/connectionError";
import { errorText } from "../../components/shell/useConnect";
import type { DictNote, DictTerm, Dictionary, ErModel, LearnEvent, Tab } from "../../types";
import { Button, IconButton, Segmented, cn } from "../../components/ui";
import {
  DICT_CHANGED,
  GLOSSARY_TOKENS,
  coverageTotals,
  dictChanged,
  draftGroups,
  drafts,
  filterCoverage,
  glossaryTokens,
  noteFor,
  tableCoverage,
  type NoteSource,
  type TableCoverage,
  type TableFilter,
} from "./dictionary";
import { LearnDialog } from "./LearnDialog";

type View = "tables" | "glossary" | "review";

const CHIP: Record<NoteSource, string> = {
  verified: "bg-ok-bg text-ok",
  draft: "bg-accent-bg text-accent",
  db: "bg-dev-bg text-dev",
  missing: "bg-raised text-faint",
};

function SourceChip({ source }: { source: NoteSource }) {
  const t = useT();
  return <span className={cn("justify-self-start rounded-full px-[7px] py-px text-[11px] whitespace-nowrap", CHIP[source])}>{t(`dict.source.${source}`)}</span>;
}

/** Green check; a plain button because `cn` doesn't merge over IconButton's own colors. */
function ApproveIcon({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="grid size-[26px] shrink-0 place-items-center rounded-md bg-ok-bg text-ok hover:brightness-125">
      <Check size={14} strokeWidth={2.4} aria-hidden="true" />
    </button>
  );
}

/** Inline textarea: ⌘/Ctrl+Enter saves, Esc cancels. */
function NoteEditor({ value, label, placeholder, onSave, onCancel }: { value: string; label: string; placeholder?: string; onSave: (v: string) => void; onCancel: () => void }) {
  const t = useT();
  const [text, setText] = useState(value);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") (e.preventDefault(), onCancel());
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), onSave(text));
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <textarea
        autoFocus
        aria-label={label}
        title={t("dict.saveHint")}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        rows={Math.min(6, Math.max(2, Math.ceil(text.length / 70)))}
        className="w-full resize-y rounded-md border border-accent bg-bg px-2 py-1.5 leading-[18px] text-text outline-none placeholder:text-faint"
      />
      <div className="flex gap-1.5">
        <Button size="sm" variant="primary" onClick={() => onSave(text)}>
          {t("dict.save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("dict.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** Data dictionary of one schema: notes per table/column, the glossary, and drafts to review. */
export function DictionaryTab({ tab }: { tab: Tab }) {
  const t = useT();
  const toast = useToast();
  const conn = useConnection(tab.connectionId);
  const sid = scopedId(conn.id, tab.database);
  const schema = tab.target ?? "";
  const markLost = useConnectionError();
  const [model, setModel] = useState<ErModel | null>(null);
  const [dict, setDict] = useState<Dictionary>({ notes: [], terms: [], comments: [] });
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("tables");
  const [learnOpen, setLearnOpen] = useState(false);
  const [progress, setProgress] = useState<LearnEvent | null>(null);

  const reloadDict = useCallback(() => api.dictGet(sid, schema).then(setDict, (e: unknown) => toast(errorText(e))), [sid, schema, toast]);

  useEffect(() => {
    if (!conn.connected) return setError(t("dict.notConnected"));
    let live = true;
    setError("");
    Promise.all([api.erModel(sid, schema), api.dictGet(sid, schema)]).then(
      ([m, d]) => live && (setModel(m), setDict(d)),
      (e: unknown) => live && (markLost(conn.id, e), setError(errorText(e))),
    );
    return () => void (live = false);
  }, [sid, schema, conn.connected]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const on = () => void reloadDict();
    window.addEventListener(DICT_CHANGED, on);
    return () => window.removeEventListener(DICT_CHANGED, on);
  }, [reloadDict]);

  useEffect(() => {
    let live = true;
    let off: (() => void) | undefined;
    void api
      .onDictLearn((e) => {
        if (e.id !== sid || e.schema !== schema) return;
        setProgress(e);
        dictChanged();
        if (e.finished) toast(e.error ? t("dict.learnFailed", { error: e.error }) : t("dict.learnDone", { n: e.drafts }));
      })
      .then((u) => (live ? (off = u) : u()));
    return () => {
      live = false;
      off?.();
    };
  }, [sid, schema]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Runs a change, then every open view of the dictionary reloads. */
  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
      dictChanged();
    } catch (e) {
      toast(errorText(e));
    }
  };
  const putNote = (n: Omit<DictNote, "evidence" | "unsure"> & Partial<DictNote>) => act(() => api.dictPutNote(sid, schema, { evidence: "", unsure: false, ...n }));
  const deleteNote = (table: string, column: string) => act(() => api.dictDeleteNote(sid, schema, table, column));
  const putTerm = (term: DictTerm, previous: string | null) => act(() => api.dictPutTerm(sid, schema, term, previous));
  const deleteTerm = (term: string) => act(() => api.dictDeleteTerm(sid, schema, term));

  if (conn.driver === "redis") return <Centered>{t("dict.notSql")}</Centered>;
  if (error) return <Centered>{error}</Centered>;
  if (!model)
    return (
      <Centered>
        <Loader2 size={14} className="animate-spin" aria-label={t("common.loading")} />
      </Centered>
    );

  const learning = !!progress && !progress.finished;
  const d = drafts(dict);
  const ctx = { t, dict, putNote, deleteNote, putTerm, deleteTerm };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {view === "review" ? (
        <ReviewHeader
          count={d.total}
          confident={d.confident}
          progress={progress}
          onBack={() => setView("tables")}
          onStop={() => void api.dictLearnStop(sid, schema).catch((e: unknown) => toast(errorText(e)))}
          onResolve={(approve, includeUnsure) =>
            act(async () => toast(t(approve ? "dict.approved" : "dict.rejected", { n: await api.dictResolveDrafts(sid, schema, approve, includeUnsure) })))
          }
        />
      ) : (
        <Header
          schema={schema}
          database={tab.database}
          view={view}
          setView={setView}
          drafts={d.total}
          learning={learning}
          accessOff={conn.aiAccess === "off"}
          onReview={() => setView("review")}
          onLearn={() => setLearnOpen(true)}
          coverage={coverageTotals(tableCoverage(model, dict))}
          glossaryTokens={glossaryTokens(dict.terms)}
        />
      )}
      {view === "tables" && <TablesView {...ctx} model={model} tab={tab} schema={schema} />}
      {view === "glossary" && <GlossaryView {...ctx} />}
      {view === "review" && <ReviewView {...ctx} onLearn={() => setLearnOpen(true)} canLearn={!learning && conn.aiAccess !== "off"} />}
      {learnOpen && (
        <LearnDialog
          conn={conn}
          sid={sid}
          schema={schema}
          coverage={tableCoverage(model, dict)}
          onClose={() => setLearnOpen(false)}
          onStarted={() => {
            setLearnOpen(false);
            setProgress({ id: sid, schema, done: 0, total: 0, current: "", drafts: 0, finished: false });
            setView("review");
          }}
        />
      )}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="grid min-h-0 flex-1 place-items-center p-6 text-center text-muted">{children}</div>;
}

type Ctx = {
  t: ReturnType<typeof useT>;
  dict: Dictionary;
  putNote: (n: Omit<DictNote, "evidence" | "unsure"> & Partial<DictNote>) => Promise<void>;
  deleteNote: (table: string, column: string) => Promise<void>;
  putTerm: (term: DictTerm, previous: string | null) => Promise<void>;
  deleteTerm: (term: string) => Promise<void>;
};

function Header(p: {
  schema: string;
  database?: string;
  view: View;
  setView: (v: View) => void;
  drafts: number;
  learning: boolean;
  accessOff: boolean;
  onReview: () => void;
  onLearn: () => void;
  coverage: ReturnType<typeof coverageTotals>;
  glossaryTokens: number;
}) {
  const t = useT();
  const c = p.coverage;
  const pct = c.columnCount ? Math.round((c.columns / c.columnCount) * 100) : 0;
  const budget = Math.min(100, Math.round((p.glossaryTokens / GLOSSARY_TOKENS) * 100));
  return (
    <section className="flex shrink-0 flex-col gap-2.5 border-b border-border px-5 pt-3.5 pb-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 text-base font-semibold">{t("dict.title")}</h1>
        <span className="text-muted">{[p.database, p.schema].filter(Boolean).join(" › ")}</span>
        <Segmented
          size="sm"
          label={t("dict.section")}
          value={p.view === "glossary" ? "glossary" : "tables"}
          onChange={p.setView}
          options={[
            { value: "tables", label: t("dict.tables") },
            { value: "glossary", label: t("dict.glossary") },
          ]}
        />
        <span className="flex-1" />
        <Button variant="outline" size="lg" onClick={p.onReview} disabled={!p.drafts && !p.learning}>
          {t("dict.review")}
          {(p.drafts > 0 || p.learning) && <span className="rounded-full bg-accent-bg px-1.5 text-[11px] font-semibold text-accent">{p.drafts}</span>}
        </Button>
        <Button variant="primary" size="lg" onClick={p.onLearn} disabled={p.accessOff || p.learning} title={p.accessOff ? t("dict.learnAccessOff") : undefined}>
          {p.learning ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
          {t(p.learning ? "dict.learnRunning" : "dict.learn")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        {p.view === "glossary" ? (
          <>
            <Bar pct={budget} tone={budget >= 100 ? "bg-stg" : "bg-accent"} />
            <span>{t("dict.glossaryBudget", { n: p.glossaryTokens.toLocaleString(), max: GLOSSARY_TOKENS.toLocaleString() })}</span>
          </>
        ) : (
          <>
            <Bar pct={pct} tone="bg-ok" />
            <span>{t("dict.coverage", c)}</span>
            <span className="text-faint">·</span>
            <span>{t("dict.local")}</span>
          </>
        )}
      </div>
    </section>
  );
}

function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <span aria-hidden="true" className="h-1 w-40 overflow-hidden rounded-sm bg-border">
      <span className={cn("block h-1", tone)} style={{ width: `${pct}%` }} />
    </span>
  );
}

// ---------- tables & columns ----------

function TablesView({ t, dict, putNote, deleteNote, model, tab, schema }: Ctx & { model: ErModel; tab: Tab; schema: string }) {
  const { dispatch } = useApp();
  const [filter, setFilter] = useState<TableFilter>("all");
  const coverage = tableCoverage(model, dict);
  const shown = filterCoverage(coverage, filter);
  const [selected, setSelected] = useState<string | undefined>(() => coverage[0]?.name);
  const table = model.tables.find((x) => x.name === selected) ?? model.tables.find((x) => x.name === shown[0]?.name);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => setEditing(null), [table?.name]);
  if (!model.tables.length) return <Centered>{t("dict.noTables")}</Centered>;

  const save = (column: string, text: string, status: DictNote["status"] = "verified") => {
    setEditing(null);
    if (!table) return;
    void (text.trim() ? putNote({ table: table.name, column, note: text, status }) : deleteNote(table.name, column));
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[230px] shrink-0 flex-col border-r border-border">
        <div role="radiogroup" aria-label={t("dict.filter")} className="flex gap-1 px-2.5 pt-2.5 pb-1.5">
          {(["all", "missing", "drafts"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              onClick={() => setFilter(f)}
              className={cn("h-6 rounded-full border px-2 text-xs", filter === f ? "border-border-strong bg-raised text-text" : "border-border text-muted hover:text-text")}
            >
              {t(`dict.filter.${f}`)}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
          {shown.length === 0 && <p className="m-0 px-2 py-3 text-xs text-faint">{t("dict.noMatch")}</p>}
          {shown.map((c) => (
            <button
              key={c.name}
              type="button"
              aria-current={c.name === table?.name}
              onClick={() => setSelected(c.name)}
              className={cn("flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left hover:bg-raised", c.name === table?.name ? "bg-raised text-text" : "text-muted")}
            >
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <CoverageTag c={c} />
            </button>
          ))}
        </div>
      </div>

      {table && (
        <div className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-auto px-5 py-4">
          <div className="flex items-center gap-2.5">
            <h2 className="m-0 font-mono text-[15px] font-medium">{table.name}</h2>
            {table.rows && <span className="text-xs text-faint">{t("dict.rows", { rows: table.rows })}</span>}
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => dispatch({ type: "openTab", kind: "table", connectionId: tab.connectionId, database: tab.database, title: table.name, target: `${schema}.${table.name}` })}
            >
              {t("dict.openData")}
            </Button>
          </div>

          <TableDescription key={table.name} t={t} dict={dict} table={table.name} editing={editing === ""} setEditing={(on) => setEditing(on ? "" : null)} save={save} remove={() => void deleteNote(table.name, "")} />

          <div role="table" aria-label={table.name} className="flex shrink-0 flex-col overflow-hidden rounded-lg border border-border">
            <div role="row" className="grid h-8 shrink-0 grid-cols-[minmax(120px,190px)_minmax(80px,150px)_minmax(0,1fr)_112px_84px] items-center gap-3 border-b border-border bg-panel px-3 text-[11.5px] font-medium text-faint">
              <span role="columnheader">{t("dict.col.column")}</span>
              <span role="columnheader">{t("dict.col.type")}</span>
              <span role="columnheader">{t("dict.col.note")}</span>
              <span role="columnheader">{t("dict.col.source")}</span>
              <span />
            </div>
            {table.columns.map((c) => {
              const n = noteFor(dict, table.name, c.name);
              const label = `${table.name}.${c.name}`;
              return (
                <div role="row" key={c.name} className="grid min-h-10 grid-cols-[minmax(120px,190px)_minmax(80px,150px)_minmax(0,1fr)_112px_84px] items-center gap-3 border-b border-border px-3 py-1.5 last:border-b-0">
                  <span role="cell" className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-mono text-[12.5px]">{c.name}</span>
                    {(c.pk || c.fk) && <span className="rounded bg-stg-bg px-1 text-[10px] font-semibold text-stg">{c.pk ? "PK" : "FK"}</span>}
                  </span>
                  <span role="cell" className="truncate font-mono text-xs text-muted" title={c.type}>
                    {c.type}
                  </span>
                  <span role="cell" className="min-w-0">
                    {editing === c.name ? (
                      <NoteEditor value={n.text} label={t("dict.editNote")} placeholder={t("dict.notePlaceholder")} onSave={(v) => save(c.name, v)} onCancel={() => setEditing(null)} />
                    ) : (
                      <NoteText t={t} note={n} onAdd={() => setEditing(c.name)} />
                    )}
                  </span>
                  <span role="cell">
                    <SourceChip source={n.source} />
                  </span>
                  <span role="cell" className="flex justify-end gap-0.5">
                    {n.source === "draft" && (
                      <ApproveIcon label={t("dict.approveNote")} onClick={() => save(c.name, n.text)} />
                    )}
                    <IconButton label={`${t("dict.editNote")}: ${label}`} onClick={() => setEditing(c.name)}>
                      <Pencil size={13} aria-hidden="true" />
                    </IconButton>
                    {n.saved && (
                      <IconButton label={`${t("dict.deleteNote")}: ${label}`} onClick={() => void deleteNote(table.name, c.name)}>
                        <Trash2 size={13} aria-hidden="true" />
                      </IconButton>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function CoverageTag({ c }: { c: TableCoverage }) {
  const t = useT();
  if (c.drafts) return <span className="rounded-full bg-accent-bg px-1.5 text-[11px] whitespace-nowrap text-accent">{t(c.drafts === 1 ? "dict.tag.draft" : "dict.tag.drafts", { n: c.drafts })}</span>;
  if (!c.described && !c.noted) return <span className="rounded-full bg-surface px-1.5 text-[11px] whitespace-nowrap text-faint">{t("dict.tag.missing")}</span>;
  const all = c.noted === c.columns && c.described;
  return <span className={cn("rounded-full px-1.5 text-[11px] whitespace-nowrap", all ? "bg-ok-bg text-ok" : "bg-surface text-muted")}>{`${c.noted}/${c.columns}`}</span>;
}

function NoteText({ t, note, onAdd }: { t: Ctx["t"]; note: ReturnType<typeof noteFor>; onAdd: () => void }) {
  if (note.source === "missing")
    return (
      <button type="button" onClick={onAdd} className="text-left text-faint italic hover:text-muted">
        {t("dict.addNote")}
      </button>
    );
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="leading-[18px] break-words">{note.text}</span>
      {note.saved?.status === "draft" && (note.saved.evidence || note.saved.unsure) && (
        <span className="text-[11.5px] text-faint">
          {note.saved.unsure && <span className="text-stg">{t("dict.unsure")}</span>}
          {note.saved.unsure && note.saved.evidence && " · "}
          {note.saved.evidence}
        </span>
      )}
    </span>
  );
}

function TableDescription(p: { t: Ctx["t"]; dict: Dictionary; table: string; editing: boolean; setEditing: (on: boolean) => void; save: (column: string, text: string) => void; remove: () => void }) {
  const { t } = p;
  const n = noteFor(p.dict, p.table, "");
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted">{t("dict.tableDescription")}</span>
        <SourceChip source={n.source} />
        <span className="flex-1" />
        {!p.editing && n.source === "draft" && (
          <ApproveIcon label={t("dict.approveNote")} onClick={() => p.save("", n.text)} />
        )}
        {!p.editing && (
          <IconButton label={`${t("dict.editNote")}: ${p.table}`} onClick={() => p.setEditing(true)}>
            <Pencil size={13} aria-hidden="true" />
          </IconButton>
        )}
        {!p.editing && n.saved && (
          <IconButton label={`${t("dict.deleteNote")}: ${p.table}`} onClick={p.remove}>
            <Trash2 size={13} aria-hidden="true" />
          </IconButton>
        )}
      </div>
      {p.editing ? (
        <NoteEditor value={n.text} label={t("dict.tableDescription")} placeholder={t("dict.describePlaceholder")} onSave={(v) => p.save("", v)} onCancel={() => p.setEditing(false)} />
      ) : (
        <div className="rounded-[7px] border border-border bg-surface px-3 py-2 leading-[19px]">
          <NoteText t={t} note={n} onAdd={() => p.setEditing(true)} />
        </div>
      )}
    </div>
  );
}

// ---------- glossary ----------

const emptyTerm: DictTerm = { term: "", meaning: "", mapsTo: "", status: "verified", evidence: "", unsure: false };

function GlossaryView({ t, dict, putTerm, deleteTerm }: Ctx) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const grid = "grid grid-cols-[minmax(110px,170px)_minmax(0,1fr)_minmax(140px,280px)_112px_84px] items-center gap-3.5 px-3";
  const save = async (term: DictTerm, previous: string | null) => {
    await putTerm({ ...term, status: "verified" }, previous);
    setEditing(null);
    setAdding(false);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-5 py-4">
      <div className="flex items-center gap-2">
        <p className="m-0 max-w-[760px] flex-1 text-xs leading-[18px] text-muted">{t("dict.glossaryHelp")}</p>
        <Button variant="primary" size="lg" onClick={() => setAdding(true)} disabled={adding}>
          <Plus size={14} aria-hidden="true" />
          {t("dict.addTerm")}
        </Button>
      </div>
      <div role="table" aria-label={t("dict.glossary")} className="flex shrink-0 flex-col overflow-hidden rounded-lg border border-border">
        <div role="row" className={cn(grid, "h-8 border-b border-border bg-panel text-[11.5px] font-medium text-faint")}>
          <span role="columnheader">{t("dict.term")}</span>
          <span role="columnheader">{t("dict.meaning")}</span>
          <span role="columnheader">{t("dict.mapsTo")}</span>
          <span role="columnheader">{t("dict.col.source")}</span>
          <span />
        </div>
        {dict.terms.length === 0 && !adding && <p className="m-0 px-3 py-4 text-xs text-faint">{t("dict.noTerms")}</p>}
        {dict.terms.map((term) =>
          editing === term.term ? (
            <TermForm key={term.term} t={t} initial={term} onSave={(x) => save(x, term.term)} onCancel={() => setEditing(null)} />
          ) : (
            <div role="row" key={term.term} className={cn(grid, "min-h-11 border-b border-border py-1.5 last:border-b-0")}>
              <span role="cell" className="font-medium break-words">
                {term.term}
              </span>
              <span role="cell" className="flex min-w-0 flex-col gap-0.5 leading-[18px]">
                <span className="break-words">{term.meaning}</span>
                {term.status === "draft" && (term.evidence || term.unsure) && (
                  <span className="text-[11.5px] text-faint">
                    {term.unsure && <span className="text-stg">{t("dict.unsure")}</span>}
                    {term.unsure && term.evidence && " · "}
                    {term.evidence}
                  </span>
                )}
              </span>
              <code role="cell" className="font-mono text-xs leading-[18px] break-words text-accent-strong">
                {term.mapsTo}
              </code>
              <span role="cell">
                <SourceChip source={term.status} />
              </span>
              <span role="cell" className="flex justify-end gap-0.5">
                {term.status === "draft" && (
                  <ApproveIcon label={`${t("dict.approveTerm")}: ${term.term}`} onClick={() => void save(term, term.term)} />
                )}
                <IconButton label={`${t("dict.editTerm")}: ${term.term}`} onClick={() => setEditing(term.term)}>
                  <Pencil size={13} aria-hidden="true" />
                </IconButton>
                <IconButton label={`${t("dict.deleteTerm")}: ${term.term}`} onClick={() => void deleteTerm(term.term)}>
                  <Trash2 size={13} aria-hidden="true" />
                </IconButton>
              </span>
            </div>
          ),
        )}
        {adding && <TermForm t={t} initial={emptyTerm} onSave={(x) => save(x, null)} onCancel={() => setAdding(false)} />}
      </div>
    </div>
  );
}

function TermForm({ t, initial, onSave, onCancel }: { t: Ctx["t"]; initial: DictTerm; onSave: (t: DictTerm) => Promise<void>; onCancel: () => void }) {
  const [term, setTerm] = useState(initial);
  const set = (k: "term" | "meaning" | "mapsTo") => (e: { target: { value: string } }) => setTerm((x) => ({ ...x, [k]: e.target.value }));
  const ok = term.term.trim() && term.meaning.trim();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
    if (e.key === "Enter" && ok) void onSave(term);
  };
  const input = "h-[30px] min-w-0 rounded-md border border-border-strong bg-surface px-2 text-text outline-none placeholder:text-faint focus:border-accent";
  return (
    <div role="row" className="grid grid-cols-[minmax(110px,170px)_minmax(0,1fr)_minmax(140px,280px)_auto] items-center gap-3.5 border-b border-border bg-panel px-3 py-2 last:border-b-0">
      <input autoFocus aria-label={t("dict.newTerm")} placeholder={t("dict.termPlaceholder")} value={term.term} onChange={set("term")} onKeyDown={onKey} className={input} />
      <input aria-label={t("dict.meaning")} placeholder={t("dict.meaningPlaceholder")} value={term.meaning} onChange={set("meaning")} onKeyDown={onKey} className={input} />
      <input aria-label={t("dict.mapsTo")} placeholder={t("dict.mapsToPlaceholder")} value={term.mapsTo} onChange={set("mapsTo")} onKeyDown={onKey} className={cn(input, "font-mono text-xs")} />
      <div className="flex justify-end gap-1.5">
        <Button size="md" variant="ghost" onClick={onCancel}>
          {t("dict.cancel")}
        </Button>
        <Button size="md" variant="primary" disabled={!ok} onClick={() => void onSave(term)}>
          {t("dict.save")}
        </Button>
      </div>
    </div>
  );
}

// ---------- review drafts ----------

function ReviewHeader(p: {
  count: number;
  confident: number;
  progress: LearnEvent | null;
  onBack: () => void;
  onStop: () => void;
  onResolve: (approve: boolean, includeUnsure: boolean) => void;
}) {
  const t = useT();
  const running = !!p.progress && !p.progress.finished;
  const pct = p.progress?.total ? Math.round((p.progress.done / p.progress.total) * 100) : 0;
  return (
    <section className="flex shrink-0 flex-col gap-3 border-b border-border px-5 pt-3.5 pb-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <button type="button" onClick={p.onBack} className="flex items-center gap-1 text-muted hover:text-text">
          <ChevronLeft size={14} aria-hidden="true" />
          {t("dict.title")}
        </button>
        <span className="text-faint">/</span>
        <h1 className="m-0 text-base font-semibold">{t("dict.reviewTitle")}</h1>
        <span className="rounded-full bg-accent-bg px-1.5 text-[11px] font-semibold text-accent">{p.count}</span>
        <span className="flex-1" />
        <Button variant="outline" size="lg" disabled={!p.count} onClick={() => p.onResolve(false, true)}>
          {t("dict.rejectAll")}
        </Button>
        <Button variant="primary" size="lg" disabled={!p.confident} onClick={() => p.onResolve(true, false)}>
          <Check size={14} strokeWidth={2.4} aria-hidden="true" />
          {t("dict.approveConfident", { n: p.confident })}
        </Button>
      </div>
      {running && p.progress && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-panel px-3 py-2">
          <Sparkles size={14} aria-hidden="true" className="text-accent" />
          <span>{t("dict.learning", { done: p.progress.done, total: p.progress.total || "…" })}</span>
          {p.progress.current && <span className="text-xs text-faint">{t("dict.learningNow", { table: p.progress.current })}</span>}
          <span aria-hidden="true" className="h-1 min-w-24 flex-1 overflow-hidden rounded-sm bg-border">
            <span className="block h-1 bg-accent" style={{ width: `${pct}%` }} />
          </span>
          <Button size="sm" variant="outline" onClick={p.onStop}>
            {t("dict.learnStop")}
          </Button>
        </div>
      )}
      {p.progress?.finished && p.progress.error && (
        <p role="alert" className="m-0 rounded-lg bg-stg-bg px-3 py-2 text-xs break-words text-stg">
          {t("dict.learnFailed", { error: p.progress.error })}
        </p>
      )}
    </section>
  );
}

function ReviewView({ t, dict, putNote, deleteNote, putTerm, deleteTerm, onLearn, canLearn }: Ctx & { onLearn: () => void; canLearn: boolean }) {
  const d = drafts(dict);
  if (!d.total)
    return (
      <Centered>
        <div className="flex max-w-sm flex-col items-center gap-2">
          <BookOpen size={20} aria-hidden="true" className="text-faint" />
          <p className="m-0 text-text">{t("dict.noDrafts")}</p>
          <p className="m-0 text-xs">{t("dict.noDraftsHint")}</p>
          {canLearn && (
            <Button variant="primary" size="lg" className="mt-2" onClick={onLearn}>
              <Sparkles size={14} aria-hidden="true" />
              {t("dict.learn")}
            </Button>
          )}
        </div>
      </Centered>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-3.5">
      {draftGroups(d.notes).map((g) => (
        <ReviewGroup key={g.table} name={g.table} count={g.notes.length} t={t} mono>
          {g.notes.map((n) => (
            <ReviewRow
              key={`${n.table}.${n.column}`}
              t={t}
              target={n.column || t("dict.tableItself")}
              text={n.note}
              evidence={n.evidence}
              unsure={n.unsure}
              onSave={(note) => void putNote({ ...n, note, status: "verified" })}
              onReject={() => void deleteNote(n.table, n.column)}
            />
          ))}
        </ReviewGroup>
      ))}
      {d.terms.length > 0 && (
        <ReviewGroup name={t("dict.glossary")} count={d.terms.length} t={t}>
          {d.terms.map((term) => (
            <ReviewRow
              key={term.term}
              t={t}
              target={term.term}
              detail={term.mapsTo}
              text={term.meaning}
              evidence={term.evidence}
              unsure={term.unsure}
              onSave={(meaning) => void putTerm({ ...term, meaning, status: "verified" }, term.term)}
              onReject={() => void deleteTerm(term.term)}
            />
          ))}
        </ReviewGroup>
      )}
    </div>
  );
}

function ReviewGroup({ name, count, t, mono, children }: { name: string; count: number; t: Ctx["t"]; mono?: boolean; children: ReactNode }) {
  return (
    <section className="flex shrink-0 flex-col overflow-hidden rounded-lg border border-border">
      <h2 className="m-0 flex h-[34px] items-center gap-2 border-b border-border bg-panel px-3 text-[13px] font-medium">
        <span className={cn(mono && "font-mono text-[12.5px]")}>{name}</span>
        <span className="text-xs font-normal text-faint">{t("dict.draftsCount", { n: count })}</span>
      </h2>
      {children}
    </section>
  );
}

function ReviewRow(p: { t: Ctx["t"]; target: string; detail?: string; text: string; evidence: string; unsure: boolean; onSave: (text: string) => void; onReject: () => void }) {
  const { t } = p;
  const [editing, setEditing] = useState(false);
  return (
    <div className={cn("grid grid-cols-[minmax(120px,190px)_minmax(0,1fr)_84px_auto] items-start gap-3.5 border-b border-border px-3 py-2.5 last:border-b-0", editing && "bg-accent-bg")}>
      <span className="flex min-w-0 flex-col pt-px">
        <span className="font-mono text-[12.5px] break-words">{p.target}</span>
        {p.detail && <code className="font-mono text-[11px] break-words text-faint">→ {p.detail}</code>}
      </span>
      {editing ? (
        <NoteEditor value={p.text} label={t("dict.editNote")} onSave={(v) => (setEditing(false), v.trim() ? p.onSave(v) : p.onReject())} onCancel={() => setEditing(false)} />
      ) : (
        <span className="flex min-w-0 flex-col gap-1">
          <span className="leading-[18px] break-words">{p.text}</span>
          {p.evidence && <span className="text-[11.5px] leading-4 text-faint">{p.evidence}</span>}
        </span>
      )}
      <span className={cn("justify-self-start rounded-full px-[7px] py-px text-[11px]", p.unsure ? "bg-stg-bg text-stg" : "bg-accent-bg text-accent-strong")}>
        {t(p.unsure ? "dict.unsure" : "dict.confident")}
      </span>
      {!editing && (
        <span className="flex justify-end gap-1.5">
          <button type="button" onClick={() => p.onSave(p.text)} className="h-[26px] rounded-md bg-ok-bg px-2 text-xs font-medium text-ok hover:brightness-125">
            {t("dict.approve")}
          </button>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            {t("dict.edit")}
          </Button>
          <IconButton label={`${t("dict.reject")}: ${p.target}`} onClick={p.onReject}>
            <X size={14} aria-hidden="true" />
          </IconButton>
        </span>
      )}
    </div>
  );
}
