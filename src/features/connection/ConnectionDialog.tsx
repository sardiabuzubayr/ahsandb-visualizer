import { useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, ChevronRight, KeyRound, Loader2, Lock } from "lucide-react";
import { useT } from "../../i18n";
import { api, isApiError, isTauri } from "../../lib/api";
import { defaultAiAccess } from "../../lib/aiPrefs";
import { useApp, useToast } from "../../state/app";
import type { AiAccess, Driver, Env, SshTestResult, SslMode, TestResult } from "../../types";
import { Button, DB_META, DbIcon, Dialog, DialogHeader, EnvDot, Field, Input, Segmented, Switch, cn } from "../../components/ui";
import { errorText, folderLabel, useConnect } from "../../components/shell/useConnect";
import { hostKeyStep, withHostKey } from "../../components/shell/hostKey";
import { applyDriverChange, emptyForm, fromConnection, secretsOf, toConnection, validate, type ConnForm, type FormField } from "./form";
import { Select } from "../../components/ui/Select";

type TestState = { s: "idle" } | { s: "testing" } | { s: "ok"; r: TestResult } | { s: "error"; message: string };

const DRIVERS: Driver[] = ["postgres", "mysql", "mariadb", "sqlite", "redis"];
const ENVS: Env[] = ["dev", "staging", "prod"];
const ENV_ON: Record<Env, string> = { dev: "bg-dev-bg text-dev", staging: "bg-stg-bg text-stg", prod: "bg-prod-bg text-prod" };
const SSL_MODES: SslMode[] = ["disable", "prefer", "require", "verify-full"];
const AI_ACCESS: AiAccess[] = ["off", "schema", "data"];


export function ConnectionDialog() {
  const t = useT();
  const toast = useToast();
  const { state, dispatch } = useApp();
  const { connect } = useConnect();
  const editing = state.connections.find((c) => c.id === state.editingConnectionId);
  const [f, setF] = useState<ConnForm>(() =>
    editing ? fromConnection(editing) : { ...emptyForm, aiAccess: defaultAiAccess(emptyForm.env) },
  );
  // A new connection follows Settings' default AI access for its environment until the user picks one here.
  const aiPicked = useRef(false);
  const [touched, setTouched] = useState<Set<FormField>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [test, setTestState] = useState<TestState>({ s: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Bumped on every edit so a test result for older settings is dropped.
  const testSeq = useRef(0);
  const setTest = (v: TestState) => {
    testSeq.current++;
    setTestState(v);
  };

  const errors = validate(f);
  const valid = Object.keys(errors).length === 0;
  const server = f.driver !== "sqlite";
  const redis = f.driver === "redis";
  const folders = [...new Set(["Production", "Staging", "Local", ...state.connections.map((c) => c.folder)])];
  const close = () => dispatch({ type: "closeDialog" });

  const set = <K extends keyof ConnForm>(k: K, v: ConnForm[K]) => {
    if (k === "aiAccess") aiPicked.current = true;
    const followEnv = k === "env" && !editing && !aiPicked.current;
    setF((p) => ({ ...p, [k]: v, ...(followEnv ? { aiAccess: defaultAiAccess(v as Env) } : {}) }));
    setTest({ s: "idle" });
    setSaveError(null);
  };
  const text = (k: keyof ConnForm) => ({
    value: f[k] as string,
    onChange: (e: ChangeEvent<HTMLInputElement>) => set(k, e.target.value),
  });
  const check = (k: FormField) => ({ onBlur: () => setTouched((s) => new Set(s).add(k)), "aria-invalid": touched.has(k) && !!errors[k] });
  const err = (k: FormField) => {
    const e = errors[k];
    return touched.has(k) && e ? t(e) : undefined;
  };
  const toggle = (key: string) =>
    setExpanded((s) => {
      const x = new Set(s);
      if (!x.delete(key)) x.add(key);
      return x;
    });

  const runTest = async () => {
    setTest({ s: "testing" });
    const seq = testSeq.current;
    let next: TestState;
    try {
      const conn = toConnection(f, editing?.id ?? "");
      const secrets = secretsOf(f);
      next = { s: "ok", r: await withHostKey(() => api.testConnection(conn, secrets)) };
    } catch (e) {
      // A cancelled trust prompt just ends the test; a changed key keeps its message next to the button.
      next = hostKeyStep(e) === "trust" ? { s: "idle" } : { s: "error", message: errorText(e) };
    }
    if (seq === testSeq.current) setTestState(next);
  };
  // "Test SSH" (like DBeaver's "Test tunnel"): only the SSH part, shown inside the SSH section.
  const [sshTest, setSshTest] = useState<{ s: "idle" | "testing" } | { s: "ok"; r: SshTestResult } | { s: "error"; message: string }>({ s: "idle" });
  const runSshTest = async () => {
    setSshTest({ s: "testing" });
    try {
      const r = await withHostKey(() => api.testSsh(toConnection(f, editing?.id ?? ""), secretsOf(f)));
      setSshTest({ s: "ok", r });
    } catch (e) {
      setSshTest(hostKeyStep(e) === "trust" ? { s: "idle" } : { s: "error", message: errorText(e) });
    }
  };
  const testLine =
    test.s === "ok" &&
    t(f.ssh && server ? "conn.test.okVia" : "conn.test.ok", {
      ms: test.r.elapsedMs,
      server: test.r.serverVersion,
      via: f.sshHost.split(".")[0],
    });

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api.saveConnection({ ...toConnection(f, editing?.id ?? ""), defaultDatabase: editing?.defaultDatabase }, secretsOf(f));
      dispatch({ type: "addConnection", connection: saved }); // closes the dialog
      void connect(saved.id);
    } catch (e) {
      setSaving(false);
      if (!isApiError(e, "secrets")) return setSaveError(errorText(e));
      setSaveError(t("conn.secretNotSaved", { message: e.message }));
      // The settings were stored before the password could be stored: switch to editing that entry so a
      // second Save updates it instead of creating a duplicate. Both dispatches land in one render, so the
      // dialog stays mounted with the typed values.
      const saved = editing
        ? toConnection(f, editing.id)
        : (await api.listConnections().catch(() => [])).find((c) => !state.connections.some((o) => o.id === c.id));
      if (saved) {
        dispatch({ type: "addConnection", connection: saved });
        dispatch({ type: "openDialog", dialog: "connection", connectionId: saved.id });
      }
    }
  };

  const pickFile = async (mode: "open" | "new") => {
    if (!isTauri) return; // file dialogs exist only in the desktop app
    try {
      const path =
        mode === "open"
          ? await invoke<string | null>("plugin:dialog|open", {
              options: { multiple: false, directory: false, filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }] },
            })
          : await invoke<string | null>("plugin:dialog|save", { options: { defaultPath: "database.db" } });
      if (!path) return;
      if (mode === "new") await api.createSqliteFile(path);
      set("file", path);
    } catch (e) {
      toast(errorText(e));
    }
  };
  const PEM = [{ name: "PEM", extensions: ["pem", "crt", "cer", "key"] }];
  // SSH keys like `id_ed25519` have no extension, so the key picker has no filter.
  const pickPath = async (k: "sslCaPath" | "sslCertPath" | "sslKeyPath" | "keyPath") => {
    if (!isTauri) return; // file dialogs exist only in the desktop app
    try {
      const path = await invoke<string | null>("plugin:dialog|open", {
        options: { multiple: false, directory: false, filters: k === "keyPath" ? undefined : PEM },
      });
      if (path) set(k, path);
    } catch (e) {
      toast(errorText(e));
    }
  };
  const pemField = (k: "sslCaPath" | "sslCertPath" | "sslKeyPath", label: string) => (
    <Field label={label} hint={t("common.optional")} className="col-span-6">
      <span className="flex gap-2">
        <Input mono placeholder="~/certs/…" {...text(k)} />
        <Button size="lg" className="h-[34px]" onClick={() => pickPath(k)}>
          {t("common.choose")}
        </Button>
      </span>
    </Field>
  );
  const unchanged = editing ? t("conn.unchanged") : undefined;

  return (
    <Dialog open onClose={close} labelledBy="conn-title" className="max-h-[min(820px,calc(100vh-60px))] max-w-[680px] open:flex open:flex-col">
      <DialogHeader id="conn-title" title={t(editing ? "conn.editTitle" : "conn.title")} onClose={close} />

      <div className="flex min-h-0 flex-auto flex-col *:shrink-0 gap-[18px] overflow-auto px-5 py-[18px]">
        <div role="radiogroup" aria-label={t("conn.driver")} className="grid grid-cols-5 gap-2">
          {DRIVERS.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={f.driver === d}
              onClick={() => {
                setF((p) => applyDriverChange(p, d));
                setTest({ s: "idle" });
              }}
              className={cn(
                "flex h-[84px] min-w-0 flex-col items-center justify-center gap-1.5 rounded-lg border px-2 text-center",
                f.driver === d ? "border-accent bg-accent-bg" : "border-border bg-surface hover:border-border-strong",
              )}
            >
              <DbIcon driver={d} size={32} />
              <span className="flex max-w-full min-w-0 flex-col gap-px">
                <span className="truncate font-medium">{DB_META[d].name}</span>
                <span className={cn("text-[11px] text-muted", d !== "sqlite" && "font-mono")}>
                  {d === "sqlite" ? t("conn.localFile") : `:${DB_META[d].port}`}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-6 gap-3">
          <Field label={t("conn.name")} error={err("name")} className="col-span-6">
            <Input {...text("name")} {...check("name")} />
          </Field>
          {server ? (
            <>
              <Field label={t("conn.host")} error={err("host")} className="col-span-4">
                <Input mono {...text("host")} {...check("host")} />
              </Field>
              <Field label={t("conn.port")} error={err("port")} className="col-span-2">
                <Input
                  mono
                  inputMode="numeric"
                  value={f.port}
                  onChange={(e) => setF((p) => ({ ...p, port: e.target.value, portTouched: true }))}
                  {...check("port")}
                />
              </Field>
              {redis ? (
                <Field label={t("conn.database")} hint={t("conn.redisDbHint")} error={err("database")} className="col-span-2">
                  <Input mono inputMode="numeric" placeholder="0" title={t("conn.redisDbTitle")} {...text("database")} {...check("database")} />
                </Field>
              ) : (
                <Field label={t("conn.database")} hint={t("conn.databaseHint")} className="col-span-2">
                  <Input mono placeholder={t("conn.databasePlaceholder")} title={t("conn.databaseTitle")} {...text("database")} />
                </Field>
              )}
              <Field label={t("conn.user")} hint={redis ? t("common.optional") : undefined} className="col-span-2">
                <Input mono {...text("user")} />
              </Field>
              <Field label={t("conn.password")} hint={t("common.storedEncrypted")} className="col-span-2">
                <Input type="password" placeholder={unchanged} {...text("password")} />
              </Field>
            </>
          ) : (
            <Field label={t("conn.file")} error={err("file")} className="col-span-6">
              <span className="flex gap-2">
                <Input mono placeholder="~/data/app.db" {...text("file")} {...check("file")} />
                <Button size="lg" className="h-[34px]" onClick={() => pickFile("open")}>
                  {t("conn.fileOpen")}
                </Button>
                <Button size="lg" className="h-[34px]" onClick={() => pickFile("new")}>
                  {t("conn.fileNew")}
                </Button>
              </span>
            </Field>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div>
            <div className="mb-1.5 text-xs text-muted">{t("conn.env")}</div>
            <div role="radiogroup" aria-label={t("conn.env")} className="flex rounded-[7px] border border-border bg-surface p-0.5">
              {ENVS.map((e) => (
                <button
                  key={e}
                  type="button"
                  role="radio"
                  aria-checked={f.env === e}
                  onClick={() => set("env", e)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-[5px] px-3",
                    f.env === e ? cn(ENV_ON[e], "font-medium") : "text-muted hover:text-text",
                  )}
                >
                  <EnvDot env={e} />
                  {t(`env.${e}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex h-[34px] min-w-[220px] flex-1 items-center justify-between rounded-[7px] border border-border bg-surface px-3">
            <span>
              {t("conn.readOnly")} <span className="text-xs text-muted">· {t("conn.readOnlyHint")}</span>
            </span>
            <Switch checked={f.readOnly} onChange={(v) => set("readOnly", v)} label={t("conn.readOnly")} />
          </div>
        </div>
        <p className="-mt-2 mb-0 text-xs text-muted">{t("conn.prodHelp")}</p>

        {server && (
          <section aria-label={t("conn.ssh")} className="overflow-hidden rounded-[10px] border border-border-strong">
            <div className="flex items-center gap-2.5 bg-surface px-3.5 py-3">
              {f.ssh ? <ChevronDown size={14} className="text-faint" aria-hidden="true" /> : <ChevronRight size={14} className="text-faint" aria-hidden="true" />}
              <span className="font-medium">{t("conn.ssh")}</span>
              <span className="truncate text-xs text-muted">{t("conn.sshHint")}</span>
              <span className="flex-1" />
              <Switch checked={f.ssh} onChange={(v) => set("ssh", v)} label={t("conn.sshUse")} />
            </div>
            {f.ssh && (
              <div className="grid grid-cols-6 gap-3 border-t border-border p-3.5">
                <Field label={t("conn.sshHost")} className="col-span-4">
                  <Input mono {...text("sshHost")} />
                </Field>
                <Field label={t("conn.port")} className="col-span-2">
                  <Input mono inputMode="numeric" {...text("sshPort")} />
                </Field>
                <Field label={t("conn.sshUser")} className="col-span-2">
                  <Input mono {...text("sshUser")} />
                </Field>
                <div className="col-span-4">
                  <div className="mb-1.5 text-xs text-muted">{t("conn.sshAuth")}</div>
                  <Segmented
                    label={t("conn.sshAuthLabel")}
                    value={f.sshAuth}
                    onChange={(v) => set("sshAuth", v)}
                    options={[
                      { value: "password", label: t("conn.auth.password") },
                      { value: "key", label: t("conn.auth.key") },
                      { value: "agent", label: t("conn.auth.agent") },
                    ]}
                  />
                </div>
                {f.sshAuth === "key" && (
                  <>
                    <Field label={t("conn.keyFile")} hint={t("conn.keyFileHint")} className="col-span-4">
                      <span className="flex gap-2">
                        <Input mono {...text("keyPath")} />
                        <Button size="lg" className="h-[34px]" onClick={() => pickPath("keyPath")}>
                          {t("common.browse")}
                        </Button>
                      </span>
                    </Field>
                    <Field label={t("conn.passphrase")} hint={t("common.optional")} className="col-span-2">
                      <Input type="password" placeholder={unchanged} {...text("passphrase")} />
                    </Field>
                  </>
                )}
                {f.sshAuth === "password" && (
                  <Field label={t("conn.password")} hint={t("common.storedEncrypted")} className="col-span-3">
                    <Input type="password" placeholder={unchanged} {...text("sshPassword")} />
                  </Field>
                )}
                {f.sshAuth === "agent" && (
                  <Note icon={<KeyRound size={13} aria-hidden="true" />}>{t("conn.agentNote")}</Note>
                )}
                <Field label={t("conn.sshKeepalive")} hint={t("conn.sshKeepaliveHint")} className="col-span-2">
                  <Input mono inputMode="numeric" placeholder="15" {...text("sshKeepalive")} />
                </Field>
                <div className="col-span-4 flex flex-wrap items-center gap-2.5">
                  <Button onClick={() => void runSshTest()} disabled={sshTest.s === "testing" || !f.sshHost.trim() || !f.sshUser.trim()}>
                    {sshTest.s === "testing" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                    {t(sshTest.s === "testing" ? "conn.sshTesting" : "conn.sshTest")}
                  </Button>
                  <span role="status" className="min-w-0 flex-1 text-xs">
                    {sshTest.s === "ok" &&
                      (sshTest.r.targetReachable ? (
                        <span className="text-ok">{t("conn.sshTest.ok", { ms: sshTest.r.elapsedMs, target: sshTest.r.target })}</span>
                      ) : (
                        <span className="text-stg">
                          {t("conn.sshTest.noTarget", { ms: sshTest.r.elapsedMs, target: sshTest.r.target, error: sshTest.r.targetError ?? "" })}
                        </span>
                      ))}
                    {sshTest.s === "error" && <span className="text-prod">{sshTest.message}</span>}
                  </span>
                </div>
                <Note icon={<Lock size={13} aria-hidden="true" />}>{t("conn.hostKeyNote")}</Note>
              </div>
            )}
          </section>
        )}

        {server && (
          <Collapsible title={t("conn.ssl")} summary={t(`conn.ssl.${f.sslMode}`)} open={expanded.has("ssl")} onToggle={() => toggle("ssl")}>
            <Field label={t("conn.sslMode")} className="col-span-3">
              <Select value={f.sslMode} onChange={(e) => set("sslMode", e.target.value as SslMode)}>
                {SSL_MODES.filter((m) => !redis || m !== "prefer").map((m) => (
                  <option key={m} value={m}>
                    {t(`conn.ssl.${m}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {pemField("sslCaPath", t("conn.sslCa"))}
            {pemField("sslCertPath", t("conn.sslCert"))}
            {pemField("sslKeyPath", t("conn.sslKey"))}
          </Collapsible>
        )}
        <Collapsible
          title={t("conn.advanced")}
          summary={`${folderLabel(t, f.folder)} · ${t("conn.timeoutShort", { n: f.timeout || "—" })}`}
          open={expanded.has("adv")}
          onToggle={() => toggle("adv")}
        >
          <Field label={t("conn.folder")} className="col-span-3">
            <Input list="conn-folders" {...text("folder")} />
            <datalist id="conn-folders">
              {folders.map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
          </Field>
          <Field label={t("conn.timeout")} hint={t("conn.seconds")} className="col-span-3">
            <Input mono inputMode="numeric" {...text("timeout")} />
          </Field>
        </Collapsible>
        <Collapsible title={t("conn.ai")} summary={t(`conn.aiSummary.${f.aiAccess}`)} open={expanded.has("ai")} onToggle={() => toggle("ai")}>
          <Field label={t("conn.aiAccess")} className="col-span-3">
            <Select value={f.aiAccess} onChange={(e) => set("aiAccess", e.target.value as AiAccess)}>
              {AI_ACCESS.map((a) => (
                <option key={a} value={a}>
                  {t(`conn.ai.${a}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Note>{t("conn.aiNote")}</Note>
        </Collapsible>
      </div>

      <div className="flex flex-wrap items-center gap-2.5 border-t border-border px-5 py-3.5">
        <span aria-live="polite" className="flex min-w-[240px] flex-1 items-center gap-2 text-[12.5px]">
          {saveError && <span className="text-prod">{saveError}</span>}
          {!saveError && test.s === "error" && <span className="text-prod">{test.message}</span>}
          {test.s === "testing" && (
            <span className="flex items-center gap-2 text-muted">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              {t("conn.testing")}
            </span>
          )}
          {test.s === "ok" && (
            <span className="flex items-center gap-2 text-ok">
              <Check size={14} strokeWidth={2.2} aria-hidden="true" />
              {testLine}
            </span>
          )}
        </span>
        <Button size="lg" disabled={!valid || test.s === "testing"} onClick={runTest}>
          {t("conn.test")}
        </Button>
        <Button variant="ghost" size="lg" onClick={close}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          size="lg"
          className="font-semibold"
          disabled={!valid || saving}
          onClick={save}
        >
          {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          {t("conn.save")}
        </Button>
      </div>
    </Dialog>
  );
}

function Note({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <p className="col-span-6 m-0 flex items-start gap-2 text-xs text-muted">
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      {children}
    </p>
  );
}

function Collapsible({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-border">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-2.5 bg-surface px-3.5 py-3 text-left">
        {open ? <ChevronDown size={14} className="text-faint" aria-hidden="true" /> : <ChevronRight size={14} className="text-faint" aria-hidden="true" />}
        <span className="font-medium">{title}</span>
        <span className="flex-1" />
        <span className="truncate text-xs text-muted">{summary}</span>
      </button>
      {open && <div className="grid grid-cols-6 gap-3 border-t border-border p-3.5">{children}</div>}
    </div>
  );
}
