import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowUp, Check, ChevronDown, Ellipsis, KeyRound, Loader2, Maximize2, MessageSquare, Minimize2, Square, X } from "lucide-react";
import { writePref } from "../../lib/storage";
import { useT } from "../../i18n";
import { api, isApiError } from "../../lib/api";
import { AI_PROVIDERS, providerName, setAiChoice, useAiChoice, useAiKeys, useAiModels } from "../../lib/aiPrefs";
import { scopedId } from "../../lib/scope";
import { useConnectionError } from "../../components/shell/connectionError";
import { errorText } from "../../components/shell/useConnect";
import { queueSql } from "../editor/pendingSql";
import { useApp, useConnection, useToast } from "../../state/app";
import type { AgentDecision, AgentEvent, AgentMessage, AiAccess, AiProvider, Env } from "../../types";
import { Button, EnvDot, IconButton, Menu, cn } from "../../components/ui";
import { Markdown } from "./Markdown";
import { ApprovalCard } from "./ApprovalCard";
import { AuditDialog, ClearChatDialog } from "./ChatDialogs";
import { ResultView } from "./ResultView";
import { applyAgentEvent, bareId, upsertMessage } from "./messages";

const envChip: Record<Env, string> = { prod: "bg-prod-bg text-prod", staging: "bg-stg-bg text-stg", dev: "bg-dev-bg text-dev" };
// shortcut: the shared Menu has no scroll, so each provider shows a few models + a link to Settings; add scrolling to Menu if users want all here.
const MENU_MODELS = 6;

type Fail = { kind: "auth" | "other"; text: string };

export function AgentPanel() {
  const { state } = useApp();
  return state.connections.length ? <Panel /> : null;
}

const AGENT_DEFAULT = 460;
/** Full-width mode: keep the conversation a readable column in the middle. */
const WIDE = "px-[max(0.875rem,calc((100%-960px)/2))]";
const clampAgent = (w: number) => Math.round(Math.min(Math.max(w, 340), Math.max(340, window.innerWidth - 420)));

function Panel() {
  const t = useT();
  // Drag the left edge to resize (double-click: default); kept across restarts.
  const [width, setWidthState] = useState(() => {
    try {
      return clampAgent(Number(localStorage.getItem("agent.width")) || AGENT_DEFAULT);
    } catch {
      return AGENT_DEFAULT;
    }
  });
  const setWidth = (w: number) => {
    const v = clampAgent(w);
    setWidthState(v);
    writePref("agent.width", String(v));
  };
  const startResize = (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let latest = startW;
    const move = (ev: PointerEvent) => {
      latest = clampAgent(startW - (ev.clientX - startX)); // the edge is on the left: dragging left widens
      setWidthState(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      writePref("agent.width", String(latest));
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const toast = useToast();
  const { state, dispatch } = useApp();
  const markLost = useConnectionError();
  const conn = useConnection(state.activeConnectionId);
  // The active tab's database scopes the agent when that tab belongs to this connection.
  const tab = state.tabs.find((x) => x.id === state.activeTabId);
  const database = tab?.connectionId === conn.id ? tab.database : undefined;
  const sid = scopedId(conn.id, database);

  const choice = useAiChoice();
  const keys = useAiKeys();
  // AI_PROVIDERS is a constant list, so the hook order is stable.
  const lists = Object.fromEntries(AI_PROVIDERS.map((p) => [p.id, useAiModels(p.id, !!keys?.includes(p.id))])) as Record<
    AiProvider,
    ReturnType<typeof useAiModels>
  >;
  const models = lists[choice.provider].models;
  const model = choice.model || models?.[0]?.id || "";
  const modelName = models?.find((m) => m.id === model)?.name ?? model;

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [fail, setFail] = useState<Fail | null>(null);
  const [draft, setDraft] = useState("");
  const [dialog, setDialog] = useState<"clear" | "audit" | null>(null);
  const end = useRef<HTMLDivElement>(null);

  // The event listener is registered once; it reads where the panel is now through this ref.
  const here = useRef({ connId: conn.id, database });
  here.current = { connId: conn.id, database };

  const openSql = (sql: string) => {
    const { connId, database } = here.current;
    queueSql(connId, sql);
    dispatch({ type: "openTab", kind: "sql", connectionId: connId, title: "agent.sql", database });
  };

  useEffect(() => {
    let live = true;
    let off: (() => void) | undefined;
    const onEvent = (e: AgentEvent) => {
      const { connId } = here.current;
      if (bareId(e.connId) !== connId) return;
      setMessages((ms) => applyAgentEvent(ms, e, connId));
      if (e.type === "status") setRunning(e.running);
      else if (e.type === "error") setFail({ kind: "other", text: e.message });
      else if (e.type === "openSql") openSql(e.sql);
    };
    void api.onAgentEvent(onEvent).then((u) => (live ? (off = u) : u()));
    return () => {
      live = false;
      off?.();
    };
  }, []); // openSql only reads the ref and the stable dispatch

  useEffect(() => {
    let live = true;
    setMessages([]);
    setRunning(false);
    setFail(null);
    // Events that arrive while loading win over the stored copy of the same entry.
    api.agentHistory(sid).then(
      (h) => live && setMessages((cur) => cur.reduce(upsertMessage, h)),
      (e: unknown) => live && (markLost(conn.id, e), setFail({ kind: "other", text: errorText(e) })),
    );
    return () => void (live = false);
  }, [conn.id]); // history is per bare connection; sid only adds the database

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" }); // braces: newer Chromium returns a Promise here, which React would take as a cleanup
  }, [messages, running, fail]);

  const accessOff = conn.aiAccess === "off";
  // AI access is a per-connection setting; changing it here saves the connection like the connection dialog does.
  const setAccess = async (aiAccess: AiAccess) => {
    if (aiAccess === conn.aiAccess) return;
    try {
      dispatch({ type: "addConnection", connection: await api.saveConnection({ ...conn, aiAccess }, {}) });
      toast(t("agent.accessSaved", { level: t(`agent.access.${aiAccess}`) }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  const noKeys = keys !== null && keys.length === 0;
  const canSend = !accessOff && !running && !!model && !!draft.trim();

  const send = async () => {
    const text = draft.trim();
    if (!canSend) return;
    if (keys && !keys.includes(choice.provider)) return setFail({ kind: "auth", text: "" });
    setFail(null);
    setDraft("");
    try {
      await api.agentSend(sid, choice.provider, model, text);
    } catch (e) {
      setDraft((d) => d || text);
      if (isApiError(e, "auth")) return setFail({ kind: "auth", text: e.message });
      markLost(conn.id, e);
      setFail({ kind: "other", text: errorText(e) });
    }
  };

  const stop = () => void api.agentStop(sid).catch((e: unknown) => setFail({ kind: "other", text: errorText(e) }));

  const decide = (id: string) => (d: AgentDecision) =>
    api.agentDecide(id, d).catch((e: unknown) => {
      markLost(conn.id, e);
      throw e;
    });

  const openSettings = () => dispatch({ type: "openDialog", dialog: "settings", context: { section: "ai" } });

  const modelItems = (keys ?? []).flatMap((p) => {
    const { models: ms, error } = lists[p];
    const head = <span className="w-[76px] shrink-0 truncate text-faint">{providerName(p)}</span>;
    if (error || !ms)
      return [
        {
          key: `${p}:state`,
          disabled: true,
          onSelect: () => {},
          label: (
            <>
              {head}
              <span className={cn("flex-1 truncate", error && "text-prod")}>{t(error ? "agent.models.error" : "agent.models.loading")}</span>
            </>
          ),
        },
      ];
    const current = p === choice.provider ? model : "";
    const shown = ms.filter((m, i) => i < MENU_MODELS || m.id === current);
    const items = shown.map((m) => ({
      key: `${p}:${m.id}`,
      onSelect: () => setAiChoice(p, m.id),
      label: (
        <>
          {head}
          <span className="flex-1 truncate">{m.name}</span>
          {m.id === current && <Check size={13} aria-hidden="true" className="shrink-0 text-accent" />}
        </>
      ),
    }));
    if (ms.length > shown.length)
      items.push({ key: `${p}:more`, onSelect: openSettings, label: <span className="pl-[84px] text-muted">{t("agent.models.more", { n: ms.length })}</span> });
    return items;
  });

  return (
    <aside
      aria-label={t("agent.label")}
      style={state.agentMaximized ? undefined : { width }}
      className={cn("relative flex h-full flex-col border-l border-border bg-panel", state.agentMaximized ? "min-w-0 flex-1" : "shrink-0")}
    >
      {!state.agentMaximized && (
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label={t("agent.resize")}
          title={t("agent.resize")}
          onPointerDown={startResize}
          onDoubleClick={() => setWidth(AGENT_DEFAULT)}
          className="absolute top-0 -left-[3px] z-10 h-full w-1.5 cursor-col-resize hover:bg-[var(--accent-ring)]"
        />
      )}
      <div className="flex flex-col gap-2 border-b border-border px-3.5 py-3">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-accent text-on-accent">
            <MessageSquare size={13} strokeWidth={2.2} />
          </span>
          <h2 className="m-0 text-sm font-semibold">{t("agent.title")}</h2>
          {!noKeys && (
            <Menu
              trigger={(p) => (
                <button
                  type="button"
                  aria-label={t("agent.changeModel")}
                  {...p}
                  className="inline-flex h-6 max-w-[230px] min-w-0 items-center gap-1.5 rounded-xl border border-border-strong px-2 text-[11.5px] text-muted hover:text-text"
                >
                  <span className="shrink-0 text-faint">{providerName(choice.provider)}</span>
                  <span className="truncate">{modelName || t("agent.models.loading")}</span>
                  <ChevronDown size={10} aria-hidden="true" className="shrink-0" />
                </button>
              )}
              items={modelItems}
            />
          )}
          <span className="flex-1" />
          <Menu
            align="right"
            trigger={(p) => (
              <IconButton label={t("agent.chatMenu")} size={28} {...p}>
                <Ellipsis size={15} strokeWidth={1.8} />
              </IconButton>
            )}
            items={[
              { key: "clear", label: t("agent.clear.menu"), disabled: running || messages.length === 0, onSelect: () => setDialog("clear") },
              { key: "audit", label: t("agent.audit.menu"), onSelect: () => setDialog("audit") },
            ]}
          />
          <IconButton
            label={t(state.agentMaximized ? "agent.restore" : "agent.maximize")}
            size={28}
            onClick={() => dispatch({ type: "toggleAgentMaximized" })}
          >
            {state.agentMaximized ? <Minimize2 size={13} strokeWidth={2} /> : <Maximize2 size={13} strokeWidth={2} />}
          </IconButton>
          <IconButton label={t("agent.close")} size={28} onClick={() => dispatch({ type: "toggleAgent" })}>
            <X size={13} strokeWidth={2} />
          </IconButton>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={cn("inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 font-medium", envChip[conn.env])}>
            <EnvDot env={conn.env} />
            <span className="truncate" title={conn.name}>
              {t("agent.workingOn", { name: database ? `${conn.name} · ${conn.driver === "redis" ? `db${database}` : database}` : conn.name })}
            </span>
          </span>
          <Menu
            trigger={(p) => (
              <button
                type="button"
                {...p}
                title={t("agent.accessChange")}
                className="inline-flex items-center gap-1 rounded-md px-1 text-muted hover:text-text"
              >
                {t("agent.access", { level: t(`agent.access.${conn.aiAccess}`) })}
                <ChevronDown size={10} aria-hidden="true" />
              </button>
            )}
            items={(["off", "schema", "data"] as const).map((a) => ({
              key: a,
              label: (
                <span className="flex items-center gap-2">
                  <Check size={12} aria-hidden="true" className={a === conn.aiAccess ? "" : "invisible"} />
                  {t(`agent.access.${a}`)}
                </span>
              ),
              onSelect: () => void setAccess(a),
            }))}
          />
        </div>
      </div>

      {noKeys ? (
        <div className="grid flex-1 place-items-center p-6">
          <div className="flex max-w-[300px] flex-col items-center gap-3 text-center">
            <KeyRound size={20} aria-hidden="true" className="text-muted" />
            <div>
              <h3 className="m-0 text-[15px] font-semibold">{t("agent.noKey.title")}</h3>
              <p className="mt-1 mb-0 text-muted">{t("agent.noKey.body")}</p>
            </div>
            <Button variant="primary" size="lg" onClick={openSettings}>
              {t("agent.noKey.open")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div
            aria-label={t("agent.conversation")}
            aria-live="polite"
            className={cn("flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto p-3.5 *:shrink-0", state.agentMaximized && WIDE)}
          >
            {messages.length === 0 && <p className="m-0 text-muted">{t("agent.intro")}</p>}
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="max-w-[88%] self-end rounded-[12px_12px_4px_12px] bg-raised px-3 py-2.5 whitespace-pre-wrap">
                  {m.text}
                </div>
              ) : m.role === "agent" ? (
                <div key={m.id} className="flex flex-col gap-2.5">
                  {m.steps.length > 0 && (
                    <details open className="group text-xs text-muted">
                      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-faint hover:text-muted">
                        <ChevronDown size={12} aria-hidden="true" className="-rotate-90 transition-transform group-open:rotate-0" />
                        {t("agent.steps", { n: m.steps.length })}
                      </summary>
                      <ol className="m-0 mt-1.5 flex list-none flex-col gap-1.5 p-0">
                        {m.steps.map((s, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <Check size={12} strokeWidth={2.4} aria-hidden="true" className="mt-[3px] shrink-0 text-ok" />
                            <span className="flex min-w-0 flex-col">
                              <span>{s.label}</span>
                              {s.detail && <code className="font-mono text-[11.5px] break-words whitespace-pre-wrap text-faint">{s.detail}</code>}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                  {m.text && <Markdown text={m.text} />}
                </div>
              ) : m.role === "action" ? (
                <ApprovalCard key={m.id} msg={m} onDecide={decide(m.id)} />
              ) : (
                <ResultView key={m.id} msg={m} onOpen={openSql} />
              ),
            )}
            {running && (
              <p role="status" className="m-0 flex items-center gap-2 text-xs text-muted">
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                {t("agent.working")}
              </p>
            )}
            {fail?.kind === "auth" ? (
              <div role="alert" className="flex flex-wrap items-center gap-2 rounded-[10px] border border-border-strong bg-surface px-3 py-2.5">
                <KeyRound size={14} aria-hidden="true" className="shrink-0 text-stg" />
                <span className="min-w-0 flex-1">{fail.text || t("agent.noKeyFor", { provider: providerName(choice.provider) })}</span>
                <Button size="sm" variant="primary" onClick={openSettings}>
                  {t("agent.noKey.open")}
                </Button>
              </div>
            ) : (
              fail && (
                <p role="alert" className="m-0 rounded-[10px] border border-prod/40 bg-prod-bg px-3 py-2.5 break-words text-prod">
                  {fail.text}
                </p>
              )
            )}
            <div ref={end} />
          </div>

          <div className={cn("flex flex-col gap-2 border-t border-border px-3.5 py-3", state.agentMaximized && WIDE)}>
            {accessOff ? (
              <div className="flex flex-col items-start gap-2 rounded-[10px] border border-border-strong bg-surface px-3 py-2.5">
                <p className="m-0 text-muted">{t("agent.accessOff")}</p>
                <Button size="sm" onClick={() => dispatch({ type: "openDialog", dialog: "connection", connectionId: conn.id })}>
                  {t("agent.editConnection")}
                </Button>
              </div>
            ) : (
              <div className="flex items-end gap-2 rounded-[10px] border border-border-strong bg-surface py-2 pr-2 pl-3 focus-within:border-accent">
                <textarea
                  aria-label={t("agent.message")}
                  rows={2}
                  value={draft}
                  disabled={running}
                  placeholder={t("agent.placeholder")}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  className="min-w-0 flex-1 resize-none border-0 bg-transparent leading-[1.45] text-text placeholder:text-faint disabled:opacity-60"
                  style={{ outline: "none" }} // the box shows focus via focus-within; global :focus-visible would win over a class
                />
                {running ? (
                  <button
                    type="button"
                    aria-label={t("agent.stop")}
                    title={t("agent.stop")}
                    onClick={stop}
                    className="grid size-8 shrink-0 place-items-center rounded-lg border border-border-strong bg-raised text-text hover:brightness-110"
                  >
                    <Square size={11} fill="currentColor" aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={t("agent.send")}
                    disabled={!canSend}
                    onClick={() => void send()}
                    className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-on-accent hover:brightness-110 disabled:opacity-50"
                  >
                    <ArrowUp size={14} strokeWidth={2.2} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
            <span className="text-[11.5px] text-faint">{t("agent.hint")}</span>
            {choice.provider === "openrouter" && <span className="text-[11.5px] text-stg">{t("agent.openrouterNote")}</span>}
          </div>
        </>
      )}

      {dialog === "clear" && (
        <ClearChatDialog
          name={conn.name}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.agentClear(sid);
            setMessages([]);
            setFail(null);
          }}
        />
      )}
      {dialog === "audit" && <AuditDialog id={sid} name={conn.name} onClose={() => setDialog(null)} />}
    </aside>
  );
}
