import { useEffect, useState, type KeyboardEvent } from "react";
import { Search } from "lucide-react";
import { useT } from "../../i18n";
import { useApp } from "../../state/app";
import { EnvDot, Kbd, cn } from "../../components/ui";
import { useConnect } from "../../components/shell/useConnect";
import { filterItems, type Range } from "./filter";
import { actionItems, connectionItems, tableItems, type PaletteItem } from "./items";

type Row = PaletteItem & { range: Range };
const TABLE_LIMIT = 5;

function Hl({ text, range: [a, b] }: { text: string; range: Range }) {
  if (a === b) return text;
  return (
    <>
      {text.slice(0, a)}
      <b className="font-semibold text-accent">{text.slice(a, b)}</b>
      {text.slice(b)}
    </>
  );
}

export function CommandPalette() {
  const t = useT();
  const { state, dispatch } = useApp();
  // Dev aid for screenshots: ?q=ord prefills the query.
  const [query, setQuery] = useState(() => (import.meta.env.DEV ? (new URLSearchParams(location.search).get("q") ?? "") : ""));
  const [sel, setSel] = useState(0);
  const { connect } = useConnect();

  const tables = filterItems(tableItems(state), query);
  // Best table hits first: earliest match, then the shortest name.
  if (query.trim()) tables.sort((x, y) => x.range[0] - y.range[0] || x.label.length - y.label.length);
  const groups: { key: string; rows: Row[] }[] = [
    { key: "tables", rows: tables.slice(0, TABLE_LIMIT) },
    { key: "actions", rows: filterItems(actionItems(state, t, tables[0] ?? tableItems(state)[0]), query) },
    { key: "connections", rows: filterItems(connectionItems(state, t), query) },
  ].filter((g) => g.rows.length);
  const flat = groups.flatMap((g) => g.rows);
  const active = Math.min(sel, flat.length - 1);

  const close = () => dispatch({ type: "setPalette", open: false });
  const run = (item: Row | undefined) => {
    if (!item) return;
    item.run.forEach(dispatch);
    if (item.connect) void connect(item.connect);
    close();
  };

  useEffect(() => {
    document.getElementById(`pal-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKey = (e: KeyboardEvent) => {
    const n = flat.length;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown" && n) setSel((active + 1) % n);
    else if (e.key === "ArrowUp" && n) setSel((active - 1 + n) % n);
    // ⌘↵ "open in new tab" behaves like ↵ until tabs can be duplicated.
    else if (e.key === "Enter") run(flat[active]);
    else if (e.key !== "Tab") return; // shortcut: ⇥ item actions are not built yet; keep focus in the palette.
    e.preventDefault();
  };

  let i = -1;
  return (
    <div className="fixed inset-0 z-40 bg-[var(--overlay)]" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.label")}
        className="absolute top-24 left-1/2 w-[calc(100%-32px)] max-w-[640px] -translate-x-1/2 overflow-hidden rounded-xl border border-border-strong bg-panel shadow-[0_24px_64px_rgba(0,0,0,.55)]"
      >
        <label className="flex h-[52px] items-center gap-2.5 border-b border-border px-4">
          <Search size={16} strokeWidth={1.8} aria-hidden="true" className="text-muted" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="pal-list"
            aria-activedescendant={active >= 0 ? `pal-${active}` : undefined}
            aria-label={t("palette.input")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKey}
            className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-text"
            style={{ outline: "none" }} // global :focus-visible is unlayered and would win over a utility class
          />
          <Kbd>esc</Kbd>
        </label>

        <div id="pal-list" role="listbox" aria-label={t("palette.results")} className="max-h-[520px] overflow-auto p-1.5">
          {flat.length === 0 && <div className="flex h-[38px] items-center px-2.5 text-muted">{t("common.noResults")}</div>}
          {groups.map((g, gi) => (
            <div key={g.key} role="group" aria-labelledby={`pal-g-${g.key}`}>
              <div
                id={`pal-g-${g.key}`}
                className={cn(
                  "px-2.5 pb-1 text-[11px] font-semibold tracking-[.06em] text-faint uppercase",
                  gi ? "pt-3" : "pt-2",
                )}
              >
                {t(`palette.group.${g.key}`)}
              </div>
              {g.rows.map((r) => {
                const idx = ++i;
                const selected = idx === active;
                return (
                  <div
                    key={r.id}
                    id={`pal-${idx}`}
                    role="option"
                    aria-selected={selected}
                    onMouseMove={() => idx !== active && setSel(idx)}
                    onClick={() => run(r)}
                    className={cn("flex h-[38px] cursor-pointer items-center gap-2.5 rounded-[7px] px-2.5", selected && "bg-accent-bg")}
                  >
                    {r.badge && <span className="w-4 shrink-0 font-mono text-[10px] text-accent">{r.badge}</span>}
                    {r.icon && <r.icon size={15} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-muted" />}
                    {!r.badge && !r.icon && r.env && <EnvDot env={r.env} className="mx-1" />}
                    <span className="truncate" title={r.label}>
                      <Hl text={r.label} range={r.range} />
                    </span>
                    {r.sub && <span className="shrink-0 text-xs text-muted">{r.sub}</span>}
                    <span className="flex-1" />
                    {r.conn && r.env && (
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                        <EnvDot env={r.env} />
                        <span className="truncate">{r.conn}</span>
                      </span>
                    )}
                    {r.hint && <span className="text-xs text-muted">{r.hint}</span>}
                    {r.kbd && <Kbd>{r.kbd}</Kbd>}
                    {selected && !r.kbd && <Kbd>↵</Kbd>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-4 border-t border-border px-4 py-2.5 text-xs text-muted">
          {(
            [
              ["↑↓", "navigate"],
              ["↵", "open"],
              ["⌘↵", "newTab"],
              ["⇥", "actions"],
            ] as const
          ).map(([k, key]) => (
            <span key={key} className="flex items-center gap-1.5">
              <Kbd>{k}</Kbd>
              {t(`palette.hint.${key}`)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
