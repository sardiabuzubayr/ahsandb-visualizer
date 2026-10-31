import { useState } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { useI18n } from "../../i18n";
import { api } from "../../lib/api";
import { AI_PROVIDERS, clearModelCache, defaultAiAccess, setDefaultAiAccess, providerName, refreshAiKeys, setAiChoice, useAiChoice, useAiKeys, useAiModels } from "../../lib/aiPrefs";
import { useToast } from "../../state/app";
import type { AiAccess, AiProvider } from "../../types";
import { Button, EnvDot, Field, Input, cn } from "../../components/ui";
import { Select } from "../../components/ui/Select";
import { CUSTOM_MODEL, effectiveModel, modelOptions, selectValue, testText, type TestResult } from "./aiSettings";

const AI_ACCESS: AiAccess[] = ["off", "schema", "data"];

/** Settings → AI: provider, stored key, model (choice shared with the agent panel). */
export function AiSection() {
  const { t } = useI18n();
  const { provider } = useAiChoice();
  const keys = useAiKeys();
  const hasKey = !!keys?.includes(provider);
  const [access, setAccess] = useState<{ dev: AiAccess; prod: AiAccess }>(() => ({ dev: defaultAiAccess("dev"), prod: defaultAiAccess("prod") }));
  // Bumped when a key is saved/removed so the model list reloads (cache is cleared by then).
  const [keyRev, setKeyRev] = useState(0);

  return (
    <>
      <div>
        <h2 id="ai-h" className="m-0 mb-1 text-sm font-semibold">
          {t("settings.nav.ai")}
        </h2>
        <p className="m-0 text-[12.5px] text-muted">{t("settings.ai.desc")}</p>
      </div>
      <div>
        <div className="mb-1.5 text-xs text-muted">{t("settings.ai.provider")}</div>
        <div role="radiogroup" aria-label={t("settings.ai.providerLabel")} className="grid grid-cols-5 gap-1.5">
          {AI_PROVIDERS.map((p) => {
            const saved = !!keys?.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={provider === p.id}
                onClick={() => setAiChoice(p.id)}
                className={cn(
                  "flex min-w-0 flex-col items-start gap-1 rounded-lg border p-2.5 text-left",
                  provider === p.id ? "border-accent bg-accent-bg" : "border-border bg-surface hover:border-border-strong",
                )}
              >
                <span className="truncate text-[12.5px] font-medium">{p.name}</span>
                <span className={cn("flex items-center gap-[5px] text-[11px]", saved ? "text-ok" : "text-faint")}>
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                  {t(saved ? "settings.ai.saved" : "settings.ai.notSet")}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {/* keyed by provider: typed key, test result and model list never leak across providers */}
      <div key={provider} className="grid grid-cols-2 items-start gap-3">
        <KeyField provider={provider} hasKey={hasKey} onChanged={() => setKeyRev((n) => n + 1)} />
        <ModelField key={keyRev} provider={provider} hasKey={hasKey} />
      </div>
      <div>
        <div className="mb-1.5 text-xs text-muted">{t("settings.ai.defaults")}</div>
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {(["dev", "prod"] as const).map((e) => (
            <div key={e} className="flex h-10 items-center gap-2.5 px-3">
              <EnvDot env={e} />
              <span className="flex-1">{t(e === "dev" ? "settings.ai.devStaging" : "env.prod")}</span>
              <Select
                compact
                className="w-[170px]"
                aria-label={t(e === "dev" ? "settings.ai.devStaging" : "env.prod")}
                value={access[e]}
                onChange={(ev) => {
                  const v = ev.target.value as AiAccess;
                  setDefaultAiAccess(e, v);
                  setAccess((a) => ({ ...a, [e]: v }));
                }}
              >
                {AI_ACCESS.map((a) => (
                  <option key={a} value={a}>
                    {t(`conn.ai.${a}`)}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function KeyField({ provider, hasKey, onChanged }: { provider: AiProvider; hasKey: boolean; onChanged: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const name = providerName(provider);
  const key = typed.trim();

  const test = async () => {
    setBusy("test");
    setResult(null);
    try {
      setResult({ models: (await api.aiListModels(provider, key || undefined)).length });
    } catch (error) {
      setResult({ error });
    }
    setBusy(null);
  };
  // "" removes the stored key.
  const store = async (k: string) => {
    setBusy("save");
    setResult(null);
    try {
      await api.aiSetKey(provider, k);
      clearModelCache(provider);
      await refreshAiKeys();
      onChanged();
      setTyped("");
      toast(t(k ? "settings.ai.keySaved" : "settings.ai.keyRemoved", { provider: name }));
    } catch (error) {
      setResult({ error });
    }
    setBusy(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Field label={t("settings.ai.key", { provider: name })} hint={hasKey ? undefined : t("settings.ai.keyHint")}>
        <span className="flex gap-2">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={hasKey ? t("settings.ai.replacePh") : undefined}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && key && !busy && void store(key)}
          />
          <Button size="lg" className="h-[34px]" disabled={(!key && !hasKey) || !!busy} onClick={test}>
            {t("settings.ai.test")}
          </Button>
          <Button variant="primary" size="lg" className="h-[34px]" disabled={!key || !!busy} onClick={() => store(key)}>
            {t("common.save")}
          </Button>
        </span>
      </Field>
      {hasKey && (
        <p className="m-0 flex items-center gap-2 text-xs text-ok">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
          {t("settings.ai.storedEncrypted")}
          <Button variant="ghost" size="sm" className="-my-1 ml-auto" disabled={!!busy} onClick={() => store("")}>
            {t("settings.ai.remove")}
          </Button>
        </p>
      )}
      <p aria-live="polite" className={cn("m-0 flex items-start gap-2 text-xs", result && ("models" in result ? "text-ok" : "text-prod"), !result && "text-muted")}>
        {busy === "test" && (
          <>
            <Loader2 size={13} className="mt-px shrink-0 animate-spin" aria-hidden="true" />
            {t("settings.ai.testing")}
          </>
        )}
        {result && (
          <>
            {"models" in result ? (
              <Check size={13} strokeWidth={2.4} className="mt-px shrink-0" aria-hidden="true" />
            ) : (
              <AlertCircle size={13} className="mt-px shrink-0" aria-hidden="true" />
            )}
            {testText(t, result)}
          </>
        )}
      </p>
    </div>
  );
}

function ModelField({ provider, hasKey }: { provider: AiProvider; hasKey: boolean }) {
  const { t } = useI18n();
  const { model: saved } = useAiChoice();
  const { models, error, reload } = useAiModels(provider, hasKey);
  const [customOn, setCustomOn] = useState(false);
  const list = models ?? [];
  const model = effectiveModel(provider, saved, list);
  const loading = hasKey && !models && !error;
  const value = selectValue(list, model, customOn);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Field label={t("settings.ai.model")}>
        {!hasKey || loading ? (
          <Select disabled value="">
            <option value="">{t(loading ? "settings.ai.loadingModels" : "settings.ai.noModels")}</option>
          </Select>
        ) : (
          <Select
            value={value}
            onChange={(e) => {
              const v = e.target.value;
              setCustomOn(v === CUSTOM_MODEL);
              if (v !== CUSTOM_MODEL) setAiChoice(provider, v);
            }}
          >
            {modelOptions(t, list).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {hasKey && !loading && value === CUSTOM_MODEL && (
        <Input
          mono
          aria-label={t("settings.ai.customLabel")}
          placeholder={t("settings.ai.customLabel")}
          spellCheck={false}
          value={customOn ? saved : model}
          onChange={(e) => setAiChoice(provider, e.target.value.trim())}
        />
      )}
      {error && hasKey && (
        <p className="m-0 flex items-center gap-2 text-xs text-prod">
          <AlertCircle size={13} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{t("settings.ai.modelsError", { msg: error })}</span>
          <Button variant="ghost" size="sm" className="-my-1" onClick={reload}>
            {t("settings.ai.retry")}
          </Button>
        </p>
      )}
      <p className="m-0 text-xs text-faint">{t("settings.ai.modelHint")}</p>
    </div>
  );
}
