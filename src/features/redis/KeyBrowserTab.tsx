import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { KeyRound, Plus, RotateCw, Search, Terminal } from "lucide-react";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import { writePref } from "../../lib/storage";
import { scopedId } from "../../lib/scope";
import { useApp, useConnection, useToast } from "../../state/app";
import type { KvKey, KvType, Tab } from "../../types";
import { Button, Dialog, DialogHeader, Field, IconButton, Input, cn } from "../../components/ui";
import { Select } from "../../components/ui/Select";
import { useConnectionError } from "../../components/shell/connectionError";
import { formatBytes, redisTab } from "../../components/shell/tree";
import { Cancelled, useProdConfirm } from "./useProdConfirm";
import { ValuePanel, type Change } from "./ValuePanel";
import { KV_TYPES, formatTtl, parseTtl, typeBadge } from "./redis";

const PAGE = 200;
// Width of the key list, shared by every key browser tab and kept across restarts.
const LIST_PREF = "redis.keyListWidth";
const LIST_DEFAULT = 380;
const clampList = (w: number) => Math.min(1000, Math.max(200, Math.round(w)));
const readListWidth = () => {
  try {
    return clampList(Number(localStorage.getItem(LIST_PREF)) || LIST_DEFAULT);
  } catch {
    return LIST_DEFAULT;
  }
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Redis key browser for one database: SCAN with a glob pattern and type filter, the value on the right. */
export function KeyBrowserTab({ tab }: { tab: Tab }) {
  const t = useT();
  const toast = useToast();
  const app = useApp();
  const conn = useConnection(tab.connectionId);
  const db = tab.database ?? "0";
  const sid = scopedId(conn.id, db);
  const markLost = useConnectionError();
  const { run, dialog } = useProdConfirm(conn);
  const [pattern, setPattern] = useState("");
  const [applied, setApplied] = useState({ pattern: "", type: "", ttl: "" });
  const [keys, setKeys] = useState<KvKey[]>([]);
  const [cursor, setCursor] = useState("0");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [bySize, setBySize] = useState(false);
  const req = useRef(0);
  const [listWidth, setListWidth] = useState(readListWidth);
  const saveListWidth = (w: number) => {
    setListWidth(clampList(w));
    writePref(LIST_PREF, String(clampList(w)));
  };
  const startResize = (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = listWidth;
    let latest = startW;
    const move = (ev: PointerEvent) => {
      latest = clampList(startW + ev.clientX - startX);
      setListWidth(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      writePref(LIST_PREF, String(latest));
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const load = async (from: string) => {
    const n = ++req.current;
    if (from === "0") setStatus("loading");
    try {
      const page = await api.kvScan(sid, from, applied.pattern, applied.type || null, applied.ttl ? applied.ttl === "with" : null, PAGE);
      if (n !== req.current) return;
      setKeys((prev) => (from === "0" ? page.keys : [...prev, ...page.keys.filter((k) => !prev.some((p) => p.key === k.key))]));
      setCursor(page.cursor);
      setStatus("ready");
    } catch (e) {
      if (n !== req.current) return;
      markLost(conn.id, e);
      if (from !== "0") toast(errText(e));
      else (setError(errText(e)), setStatus("error"));
    }
  };
  // Waits for the connection: a restored tab mounts while it is still reconnecting.
  useEffect(() => {
    if (conn.connected) void load("0");
    else (setError(t("kv.notConnected")), setStatus("error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, conn.connected, applied]);

  const onChange = (c: Change) => {
    if (c.kind === "renamed") setSelected(c.to);
    if (c.kind === "deleted") setSelected(null);
    // TTL/type shown in the list may have changed; the list is cheap to reload.
    void load("0");
  };
  const search = () => setApplied((a) => ({ ...a, pattern: pattern.trim() }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[46px] shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-[12.5px] text-faint">
          {conn.name}
          <span>›</span>
          <span className="font-medium text-text">db{db}</span>
        </span>
        <span aria-hidden="true" className="h-5 w-px bg-border" />
        <label className="flex h-[28px] min-w-[220px] flex-[0_1_360px] items-center gap-2 rounded-md border border-border-strong bg-surface px-2.5 text-faint focus-within:border-accent">
          <Search size={13} aria-hidden="true" />
          <input
            aria-label={t("kv.pattern")}
            placeholder={t("kv.patternPlaceholder")}
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            className="min-w-0 flex-1 border-0 bg-transparent font-mono text-xs text-text outline-none"
          />
        </label>
        <Select compact aria-label={t("kv.typeFilter")} value={applied.type} onChange={(e) => setApplied((a) => ({ ...a, type: e.target.value }))} className="w-[130px]">
          <option value="">{t("kv.allTypes")}</option>
          {KV_TYPES.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <Select compact aria-label={t("kv.ttlFilter")} value={applied.ttl} onChange={(e) => setApplied((a) => ({ ...a, ttl: e.target.value }))} className="w-[150px]">
          <option value="">{t("kv.anyTtl")}</option>
          <option value="with">{t("kv.withTtl")}</option>
          <option value="without">{t("kv.withoutTtl")}</option>
        </Select>
        <span className="flex-1" />
        <span className="text-xs text-muted">{t(cursor === "0" ? "kv.keysLoaded" : "kv.keysLoadedMore", { n: keys.length })}</span>
        <IconButton label={t("data.refresh")} onClick={() => void load("0")} disabled={status === "loading"}>
          <RotateCw size={14} />
        </IconButton>
        <Button onClick={() => setCreating(true)} disabled={conn.readOnly || !conn.connected}>
          <Plus size={14} aria-hidden="true" />
          {t("kv.newKey")}
        </Button>
        <Button variant="ghost" className="px-2" onClick={() => app.dispatch(redisTab("console", conn.id, db))}>
          <Terminal size={14} aria-hidden="true" />
          {t("kv.console")}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div style={{ width: listWidth }} className="relative flex max-w-[75%] shrink-0 flex-col border-r border-border">
          <span
            role="separator"
            aria-orientation="vertical"
            aria-label={t("kv.resizeList")}
            aria-valuenow={listWidth}
            title={t("kv.resizeList")}
            tabIndex={0}
            onPointerDown={startResize}
            onDoubleClick={() => saveListWidth(LIST_DEFAULT)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") (e.preventDefault(), saveListWidth(listWidth - 24));
              if (e.key === "ArrowRight") (e.preventDefault(), saveListWidth(listWidth + 24));
            }}
            className="absolute top-0 -right-[3px] z-10 h-full w-1.5 cursor-col-resize outline-none hover:bg-[var(--accent-ring)] focus-visible:bg-[var(--accent-ring)]"
          />
          <div className="flex h-[30px] shrink-0 items-center justify-between border-b border-border px-3 text-[11px] text-muted">
            <span>{t("kv.keys")}</span>
            <button
              type="button"
              aria-pressed={bySize}
              title={t("kv.sortBySizeHint")}
              onClick={() => setBySize((v) => !v)}
              className={cn("rounded px-1.5 py-0.5", bySize ? "bg-accent-bg text-text" : "hover:text-text")}
            >
              {t(bySize ? "kv.sortedBySize" : "kv.sortBySize")}
            </button>
          </div>
          <div role="listbox" aria-label={t("kv.keys")} className={cn("min-h-0 flex-1 overflow-auto py-1", status === "loading" && "opacity-60")}>
            {(bySize ? [...keys].sort((a, b) => (b.memory ?? -1) - (a.memory ?? -1)) : keys).map((k) => {
              const badge = typeBadge(k.type);
              return (
                <button
                  key={k.key}
                  type="button"
                  role="option"
                  aria-selected={selected === k.key}
                  onClick={() => setSelected(k.key)}
                  title={k.key}
                  className={cn(
                    "flex h-[28px] w-full items-center gap-2 px-3 text-left text-[12.5px]",
                    selected === k.key ? "bg-[var(--accent-sel)]" : "hover:bg-surface",
                  )}
                >
                  <span className={cn("w-9 shrink-0 font-mono text-[9.5px] font-semibold", badge.color)}>{badge.label}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{k.key}</span>
                  {k.ttlMs >= 0 && <span className="shrink-0 font-mono text-[11px] text-faint">{formatTtl(k.ttlMs)}</span>}
                  {k.memory !== undefined && <span className="w-[58px] shrink-0 text-right font-mono text-[11px] text-faint">{formatBytes(k.memory)}</span>}
                </button>
              );
            })}
            {status === "error" && (
              <div role="alert" className="flex flex-col items-center gap-3 px-4 py-10 text-center">
                <p className="m-0 text-prod">{error}</p>
                {conn.connected && <Button onClick={() => void load("0")}>{t("data.retry")}</Button>}
              </div>
            )}
            {status === "loading" && keys.length === 0 && <p className="m-0 py-10 text-center text-muted">{t("kv.scanning")}</p>}
            {status === "ready" && keys.length === 0 && <p className="m-0 px-4 py-10 text-center text-muted">{t("kv.noKeys")}</p>}
            {status === "ready" && cursor !== "0" && (
              <div className="p-2">
                <Button className="w-full" onClick={() => void load(cursor)}>
                  {t("kv.loadMore")}
                </Button>
              </div>
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <ValuePanel key={selected} sid={sid} conn={conn} keyName={selected} run={run} onChange={onChange} />
          ) : (
            <div className="grid flex-1 place-items-center text-center text-muted">
              <div className="flex flex-col items-center gap-2">
                <KeyRound size={22} aria-hidden="true" className="text-faint" />
                <p className="m-0">{t("kv.pickKey")}</p>
              </div>
            </div>
          )}
        </div>
      </div>
      {creating && (
        <NewKeyDialog
          onClose={() => setCreating(false)}
          onCreate={async (edit) => {
            try {
              await run((confirmed) => api.kvEdit(sid, edit, confirmed));
            } catch (e) {
              if (!(e instanceof Cancelled)) toast(errText(e));
              return;
            }
            setCreating(false);
            setSelected(edit.key);
            void load("0");
          }}
        />
      )}
      {dialog}
    </div>
  );
}

type CreateEdit = { op: "create"; key: string; kind: KvType; field?: string; value: string; score?: number; ttlSecs?: number };

function NewKeyDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (e: CreateEdit) => Promise<void> }) {
  const t = useT();
  const [f, setF] = useState({ key: "", kind: "string" as KvType, field: "", value: "", score: "0", ttl: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const needsField = f.kind === "hash" || f.kind === "stream";
  const ttl = parseTtl(f.ttl);
  const score = Number(f.score);
  const valid = !!f.key.trim() && (!needsField || !!f.field.trim()) && ttl !== undefined && (f.kind !== "zset" || (f.score.trim() !== "" && Number.isFinite(score)));
  const valueLabel = f.kind === "set" || f.kind === "zset" ? t("kv.col.member") : t("kv.col.value");
  return (
    <Dialog open onClose={onClose} labelledBy="kv-new-title" className="max-w-[520px]">
      <DialogHeader id="kv-new-title" title={t("kv.newKeyTitle")} onClose={onClose} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          setBusy(true);
          await onCreate({
            op: "create",
            key: f.key,
            kind: f.kind,
            field: needsField ? f.field : undefined,
            value: f.value,
            score: f.kind === "zset" ? score : undefined,
            ttlSecs: ttl ?? undefined,
          });
          setBusy(false);
        }}
      >
        <div className="grid grid-cols-6 gap-3 px-5 py-4">
          <Field label={t("kv.keyName")} className="col-span-4">
            <Input mono autoFocus value={f.key} onChange={set("key")} />
          </Field>
          <Field label={t("kv.type")} className="col-span-2">
            <Select value={f.kind} onChange={set("kind")}>
              {KV_TYPES.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
          {needsField && (
            <Field label={t("kv.col.field")} className="col-span-2">
              <Input mono value={f.field} onChange={set("field")} />
            </Field>
          )}
          {f.kind === "zset" && (
            <Field label={t("kv.col.score")} className="col-span-2">
              <Input mono inputMode="decimal" value={f.score} onChange={set("score")} />
            </Field>
          )}
          <Field label={valueLabel} className={needsField || f.kind === "zset" ? "col-span-4" : "col-span-6"}>
            {f.kind === "string" ? (
              <textarea
                value={f.value}
                onChange={set("value")}
                rows={4}
                className="w-full resize-y rounded-[7px] border border-border-strong bg-surface px-2.5 py-2 font-mono text-[12.5px] text-text outline-none focus:border-accent"
              />
            ) : (
              <Input mono value={f.value} onChange={set("value")} />
            )}
          </Field>
          <Field label={t("kv.ttl")} hint={t("kv.ttlOptional")} error={ttl === undefined ? t("kv.badTtl") : undefined} className="col-span-3">
            <Input mono placeholder={t("kv.ttlPlaceholder")} value={f.ttl} onChange={set("ttl")} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
          <Button variant="ghost" size="lg" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="lg" disabled={!valid || busy}>
            {t("kv.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
