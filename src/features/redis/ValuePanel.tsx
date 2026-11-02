import { useEffect, useState, type ReactNode } from "react";
import { Braces, Clock, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useT } from "../../i18n";
import { api, isApiError } from "../../lib/api";
import { useToast } from "../../state/app";
import type { Connection, KvEdit, KvEntry } from "../../types";
import { Button, Dialog, IconButton, Input, cn } from "../../components/ui";
import { Select } from "../../components/ui/Select";
import { useConnectionError } from "../../components/shell/connectionError";
import { formatBytes } from "../../components/shell/tree";
import { Cancelled } from "./useProdConfirm";
import { formatTtl, parseTtl, prettyJson, typeBadge } from "./redis";

export type Change = { kind: "updated" } | { kind: "renamed"; to: string } | { kind: "deleted" };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One key: header (type, TTL, size, rename, delete) and its value, editable per type. */
export function ValuePanel({
  sid,
  conn,
  keyName,
  run,
  onChange,
}: {
  sid: string;
  conn: Connection;
  keyName: string;
  run: <T>(fn: (confirmed: boolean) => Promise<T>) => Promise<T>;
  onChange: (c: Change) => void;
}) {
  const t = useT();
  const toast = useToast();
  const markLost = useConnectionError();
  const [entry, setEntry] = useState<KvEntry | null>(null);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [ttlDraft, setTtlDraft] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    setError("");
    try {
      setEntry(await api.kvGet(sid, keyName));
    } catch (e) {
      markLost(conn.id, e);
      setError(errText(e));
    }
  };
  useEffect(() => {
    setEntry(null);
    setRenaming(null);
    setTtlDraft(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, keyName]);

  /** Runs an edit (with the production confirmation); true = it ran. */
  const apply = async (edit: KvEdit, after: Change = { kind: "updated" }) => {
    try {
      await run((confirmed) => api.kvEdit(sid, edit, confirmed));
    } catch (e) {
      if (e instanceof Cancelled) return false;
      markLost(conn.id, e);
      toast(isApiError(e, "readOnly") ? t("kv.readOnlyConn") : errText(e));
      return false;
    }
    if (after.kind === "updated") void load();
    onChange(after);
    return true;
  };

  if (error) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="m-0 max-w-[480px] text-prod">{error}</p>
        <Button onClick={() => void load()}>{t("data.retry")}</Button>
      </div>
    );
  }
  if (!entry) return <p className="m-0 py-10 text-center text-muted">{t("kv.loadingValue")}</p>;
  if (entry.value.kind === "none") {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="m-0 text-muted">{t("kv.gone", { key: keyName })}</p>
        <Button onClick={() => onChange({ kind: "deleted" })}>{t("kv.refreshList")}</Button>
      </div>
    );
  }

  const editable = !conn.readOnly && !entry.binary;
  const badge = typeBadge(entry.type);
  const key = entry.key;
  const submitTtl = async () => {
    const secs = parseTtl(ttlDraft ?? "");
    if (secs === undefined) return toast(t("kv.badTtl"));
    if (await apply({ op: "expire", key, ttlSecs: secs })) setTtlDraft(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className={cn("font-mono text-[10.5px] font-semibold", badge.color)}>{badge.label}</span>
        {renaming === null ? (
          <h2 className="m-0 min-w-0 truncate font-mono text-[13px] font-medium select-text" title={key}>
            {key}
          </h2>
        ) : (
          <Input
            mono
            autoFocus
            aria-label={t("kv.rename")}
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRenaming(null);
              if (e.key === "Enter" && renaming.trim() && renaming !== key) void apply({ op: "rename", key, to: renaming }, { kind: "renamed", to: renaming });
            }}
            className="h-[28px] max-w-[420px] flex-1"
          />
        )}
        {editable && renaming === null && (
          <IconButton label={t("kv.rename")} size={24} onClick={() => setRenaming(key)}>
            <Pencil size={12} />
          </IconButton>
        )}
        <span className="flex-1" />
        <span className="text-xs text-muted">
          {t(entry.type === "string" ? "kv.bytes" : "kv.items", { n: entry.length.toLocaleString() })}
          {entry.memory !== undefined && (
            <span title={t("kv.memoryHint")}>
              {" · "}
              {formatBytes(entry.memory)}
            </span>
          )}
        </span>
        {ttlDraft === null ? (
          <button
            type="button"
            disabled={!editable}
            title={t("kv.ttlHint")}
            onClick={() => setTtlDraft(entry.ttlMs > 0 ? String(Math.ceil(entry.ttlMs / 1000)) : "")}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted enabled:hover:text-text"
          >
            <Clock size={12} aria-hidden="true" />
            {entry.ttlMs > 0 ? t("kv.ttlLeft", { ttl: formatTtl(entry.ttlMs) }) : t("kv.noExpiry")}
          </button>
        ) : (
          <span className="flex items-center gap-1.5">
            <Input
              mono
              autoFocus
              aria-label={t("kv.ttl")}
              placeholder={t("kv.ttlPlaceholder")}
              value={ttlDraft}
              onChange={(e) => setTtlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setTtlDraft(null);
                if (e.key === "Enter") void submitTtl();
              }}
              className="h-[26px] w-[150px] text-xs"
            />
            <Button size="sm" onClick={() => void submitTtl()}>
              {t("kv.setTtl")}
            </Button>
          </span>
        )}
        <IconButton label={t("kv.reload")} size={26} onClick={() => void load()}>
          <RefreshCw size={13} />
        </IconButton>
        <IconButton label={t("kv.delete")} size={26} disabled={conn.readOnly} onClick={() => setDeleting(true)} className="hover:text-prod">
          <Trash2 size={13} />
        </IconButton>
      </div>
      {(entry.truncated || entry.binary || conn.readOnly) && (
        <p role="note" className="m-0 shrink-0 border-b border-border bg-stg-bg px-3 py-1.5 text-xs text-stg">
          {[
            entry.truncated && t(entry.type === "string" ? "kv.truncatedBytes" : "kv.truncatedItems", { n: entry.length.toLocaleString() }),
            entry.binary && t("kv.binary"),
            conn.readOnly && t("kv.readOnlyConn"),
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto text-[12.5px]">
        <ValueBody entry={entry} editable={editable} apply={apply} />
      </div>
      <Dialog open={deleting} onClose={() => setDeleting(false)} labelledBy="kv-del-title" className="top-[30%] max-w-[420px]">
        <div className="p-5">
          <h1 id="kv-del-title" className="m-0 text-[15px] font-semibold">
            {t("kv.deleteTitle")}
          </h1>
          <p className="mt-2 mb-0 break-all text-muted">{t("kv.deleteBody", { key })}</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
          <Button variant="outline" size="lg" onClick={() => setDeleting(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            size="lg"
            onClick={() => {
              setDeleting(false);
              void apply({ op: "delete", keys: [key] }, { kind: "deleted" });
            }}
          >
            {t("kv.delete")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

type Apply = (edit: KvEdit) => Promise<boolean>;

function ValueBody({ entry, editable, apply }: { entry: KvEntry; editable: boolean; apply: Apply }) {
  const t = useT();
  const key = entry.key;
  const v = entry.value;
  switch (v.kind) {
    case "string":
      return <StringEditor key={`${key}\n${v.value}`} value={v.value} editable={editable} onSave={(value) => apply({ op: "setString", key, value })} />;
    case "hash":
      return (
        <ItemTable
          cols={[t("kv.col.field"), t("kv.col.value")]}
          rows={v.entries}
          editable={editable}
          onEdit={(r, c, text) =>
            c === 0
              ? apply({ op: "hashSet", key, field: text, value: v.entries[r][1], replace: v.entries[r][0] })
              : apply({ op: "hashSet", key, field: v.entries[r][0], value: text })
          }
          onDelete={(r) => apply({ op: "hashDel", key, field: v.entries[r][0] })}
          add={{ fields: [t("kv.col.field"), t("kv.col.value")], onAdd: ([field, value]) => apply({ op: "hashSet", key, field, value }) }}
        />
      );
    case "list":
      return (
        <ItemTable
          cols={["#", t("kv.col.value")]}
          rows={v.items.map((x, i) => [String(i), x])}
          readOnlyCols={[0]}
          editable={editable}
          onEdit={(r, _c, text) => apply({ op: "listSet", key, index: r, value: text })}
          onDelete={(r) => apply({ op: "listRemove", key, value: v.items[r] })}
          add={{
            fields: [t("kv.col.value")],
            choice: { label: t("kv.pushWhere"), options: [["tail", t("kv.tail")], ["head", t("kv.head")]] },
            onAdd: ([value], where) => apply({ op: "listPush", key, value, head: where === "head" }),
          }}
        />
      );
    case "set":
      return (
        <ItemTable
          cols={[t("kv.col.member")]}
          rows={v.members.map((m) => [m])}
          editable={editable}
          onEdit={(r, _c, text) => apply({ op: "setAdd", key, member: text, replace: v.members[r] })}
          onDelete={(r) => apply({ op: "setRemove", key, member: v.members[r] })}
          add={{ fields: [t("kv.col.member")], onAdd: ([member]) => apply({ op: "setAdd", key, member }) }}
        />
      );
    case "zset":
      return (
        <ItemTable
          cols={[t("kv.col.score"), t("kv.col.member")]}
          rows={v.entries.map(([m, s]) => [String(s), m])}
          numericCols={[0]}
          editable={editable}
          onEdit={(r, c, text) => {
            const [member, score] = v.entries[r];
            if (c === 1) return apply({ op: "zsetAdd", key, member: text, score, replace: member });
            const n = Number(text);
            return Number.isFinite(n) && text.trim() ? apply({ op: "zsetAdd", key, member, score: n }) : Promise.resolve(false);
          }}
          onDelete={(r) => apply({ op: "zsetRemove", key, member: v.entries[r][0] })}
          add={{
            fields: [t("kv.col.member"), t("kv.col.score")],
            onAdd: ([member, score]) => (Number.isFinite(Number(score)) && score.trim() ? apply({ op: "zsetAdd", key, member, score: Number(score) }) : Promise.resolve(false)),
          }}
        />
      );
    case "stream":
      return (
        <ItemTable
          cols={[t("kv.col.id"), t("kv.col.fields")]}
          rows={v.entries.map((x) => [x.id, x.fields.map(([f, val]) => `${f}=${val}`).join("  ")])}
          readOnlyCols={[0, 1]}
          editable={editable}
          onEdit={() => Promise.resolve(false)}
          onDelete={(r) => apply({ op: "streamDel", key, id: v.entries[r].id })}
          add={{ fields: [t("kv.col.field"), t("kv.col.value")], onAdd: ([field, value]) => apply({ op: "streamAdd", key, fields: [[field, value]] }) }}
        />
      );
    default:
      return <p className="m-0 p-6 text-center text-muted">{t("kv.otherType", { type: entry.type })}</p>;
  }
}

function StringEditor({ value, editable, onSave }: { value: string; editable: boolean; onSave: (v: string) => Promise<boolean> }) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const pretty = prettyJson(draft);
  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <textarea
        aria-label={t("kv.col.value")}
        readOnly={!editable}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        className="min-h-[160px] flex-1 resize-none rounded-lg border border-border bg-surface p-3 font-mono text-[12.5px] leading-[19px] text-text outline-none focus:border-accent"
      />
      <div className="flex items-center gap-2">
        {pretty !== null && pretty !== draft && (
          <Button variant="ghost" onClick={() => setDraft(pretty)} disabled={!editable}>
            <Braces size={13} aria-hidden="true" />
            {t("kv.formatJson")}
          </Button>
        )}
        <span className="flex-1" />
        {draft !== value && (
          <Button variant="ghost" onClick={() => setDraft(value)}>
            {t("kv.discard")}
          </Button>
        )}
        {editable && (
          <Button
            variant="primary"
            disabled={draft === value || saving}
            onClick={async () => {
              setSaving(true);
              await onSave(draft);
              setSaving(false);
            }}
          >
            {t("kv.save")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Rows of a collection: double-click a cell to edit (Enter saves, Esc cancels), trash to remove, a form to add. */
function ItemTable({
  cols,
  rows,
  editable,
  readOnlyCols = [],
  numericCols = [],
  onEdit,
  onDelete,
  add,
}: {
  cols: string[];
  rows: string[][];
  editable: boolean;
  readOnlyCols?: number[];
  numericCols?: number[];
  onEdit: (row: number, col: number, text: string) => Promise<boolean>;
  onDelete: (row: number) => Promise<boolean>;
  add: { fields: string[]; choice?: { label: string; options: [string, string][] }; onAdd: (values: string[], choice: string) => Promise<boolean> };
}) {
  const t = useT();
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [draft, setDraft] = useState<string[]>(() => add.fields.map(() => ""));
  const [choice, setChoice] = useState(add.choice?.options[0][0] ?? "");
  const cell = (r: number, c: number, text: string): ReactNode => {
    const mono = numericCols.includes(c) || cols[c] === "#";
    if (editing?.r === r && editing.c === c) {
      return (
        <td key={c} className="p-0">
          <input
            autoFocus
            aria-label={cols[c]}
            defaultValue={text}
            onBlur={() => setEditing(null)}
            onKeyDown={async (e) => {
              if (e.key === "Escape") setEditing(null);
              if (e.key !== "Enter") return;
              const next = e.currentTarget.value;
              setEditing(null);
              if (next !== text) await onEdit(r, c, next);
            }}
            className="h-7 w-full border-0 bg-surface px-3 font-mono text-text shadow-[inset_0_0_0_1.5px_var(--accent)] outline-none"
          />
        </td>
      );
    }
    const canEdit = editable && !readOnlyCols.includes(c);
    return (
      <td
        key={c}
        title={text}
        tabIndex={canEdit ? 0 : undefined}
        onDoubleClick={() => canEdit && setEditing({ r, c })}
        onKeyDown={(e) => canEdit && (e.key === "Enter" || e.key === "F2") && setEditing({ r, c })}
        className={cn("truncate px-3 font-mono select-text", mono && "text-faint")}
      >
        {text}
      </td>
    );
  };
  const submit = async () => {
    if (draft.some((d, i) => !d && i === 0)) return;
    if (await add.onAdd(draft, choice)) setDraft(add.fields.map(() => ""));
  };
  return (
    <div>
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          {cols.map((c, i) => (
            <col key={c} style={{ width: cols.length > 1 && i === 0 ? (c === "#" ? 64 : "36%") : undefined }} />
          ))}
          <col style={{ width: 36 }} />
        </colgroup>
        <thead className="sticky top-0 z-[1] bg-panel text-xs">
          <tr className="h-8 shadow-[inset_0_-1px_0_var(--border-strong)]">
            {cols.map((c) => (
              <th key={c} scope="col" className="px-3 text-left font-medium">
                {c}
              </th>
            ))}
            <th scope="col">
              <span className="sr-only">{t("kv.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={`${r}:${row[0]}`} className="group h-[29px] border-b border-border hover:bg-surface">
              {row.map((text, c) => cell(r, c, text))}
              <td className="px-1 text-right">
                {editable && (
                  <IconButton
                    label={t("kv.removeItem")}
                    size={22}
                    onClick={() => void onDelete(r)}
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-prod"
                  >
                    <Trash2 size={12} />
                  </IconButton>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="m-0 py-6 text-center text-muted">{t("kv.empty")}</p>}
      {editable && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5"
        >
          {add.fields.map((label, i) => (
            <Input
              key={label}
              mono
              aria-label={label}
              placeholder={label}
              value={draft[i]}
              onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? e.target.value : x)))}
              className="h-[30px] min-w-[140px] flex-1"
            />
          ))}
          {add.choice && (
            <Select compact aria-label={add.choice.label} value={choice} onChange={(e) => setChoice(e.target.value)} className="w-[120px]">
              {add.choice.options.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </Select>
          )}
          <Button type="submit" disabled={!draft[0]}>
            <Plus size={13} aria-hidden="true" />
            {t("kv.add")}
          </Button>
        </form>
      )}
    </div>
  );
}
