// AI provider/model choice (per user, localStorage) and the stored-key list (via api).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { readPref, writePref } from "./storage";
import type { AiAccess, AiModel, AiProvider, Env } from "../types";

export const AI_PROVIDERS: { id: AiProvider; name: string }[] = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "gemini", name: "Gemini" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "deepseek", name: "DeepSeek" },
];
const IDS = AI_PROVIDERS.map((p) => p.id);
export const providerName = (p: AiProvider) => AI_PROVIDERS.find((x) => x.id === p)?.name ?? p;

/** Default model per provider before the user picks one ("" = first listed model). */
export const DEFAULT_MODEL: Record<AiProvider, string> = {
  anthropic: "claude-opus-5-5",
  openai: "",
  gemini: "",
  openrouter: "",
  deepseek: "deepseek-chat",
};

export interface AiChoice {
  provider: AiProvider;
  /** Model id; "" = use the first model the provider lists. */
  model: string;
}

let choice: AiChoice = (() => {
  const provider = readPref("ai.provider", IDS, "anthropic");
  return { provider, model: localStorageGet(`ai.model.${provider}`) ?? DEFAULT_MODEL[provider] };
})();
const subs = new Set<() => void>();

function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The provider/model used for the next agent message (shared by Settings and the agent panel). */
export const useAiChoice = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => choice,
  );

export function setAiChoice(provider: AiProvider, model?: string) {
  const m = model ?? localStorageGet(`ai.model.${provider}`) ?? DEFAULT_MODEL[provider];
  writePref("ai.provider", provider);
  try {
    localStorage.setItem(`ai.model.${provider}`, m);
  } catch {
    // shortcut: private mode keeps the choice for this session only.
  }
  choice = { provider, model: m };
  subs.forEach((f) => f());
}

/** Providers with a saved key; `refresh` after saving/removing one. null = loading. */
let keys: AiProvider[] | null = null;
const keySubs = new Set<() => void>();
export async function refreshAiKeys() {
  keys = await api.aiKeyStatus().catch(() => []);
  keySubs.forEach((f) => f());
}
export function useAiKeys(): AiProvider[] | null {
  const k = useSyncExternalStore(
    (f) => (keySubs.add(f), () => void keySubs.delete(f)),
    () => keys,
  );
  useEffect(() => {
    if (keys === null) void refreshAiKeys();
  }, []);
  return k;
}

/** Tool-capable models of a provider with a saved key. Cached in localStorage (not secret): listing models
 *  calls the provider's API, so it only happens without a cache, on reload, or after the key changed. */
const modelCache = new Map<AiProvider, AiModel[]>();
const storedModels = (p: AiProvider): AiModel[] | undefined => {
  try {
    const v = JSON.parse(localStorage.getItem(`ai.models.${p}`) ?? "null");
    return Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
};
const cachedModels = (p: AiProvider) => modelCache.get(p) ?? storedModels(p);
export function useAiModels(provider: AiProvider, enabled: boolean) {
  const [models, setModels] = useState<AiModel[] | null>(() => (enabled ? (cachedModels(provider) ?? null) : null));
  const [error, setError] = useState<string | null>(null);
  const req = useRef(0);
  const load = useCallback(
    async (force = false) => {
      const n = ++req.current; // a late answer for an earlier provider/request is ignored
      setError(null);
      if (!enabled) return setModels(null);
      const cached = cachedModels(provider);
      if (!force && cached) return setModels(cached);
      setModels(null);
      try {
        const list = await api.aiListModels(provider);
        modelCache.set(provider, list);
        try {
          localStorage.setItem(`ai.models.${provider}`, JSON.stringify(list));
        } catch {
          // shortcut: without storage the list is fetched again next session.
        }
        if (n === req.current) setModels(list);
      } catch (e) {
        if (n === req.current) setError(e instanceof Error ? e.message : String(e));
      }
    },
    [provider, enabled],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return { models, error, reload: () => load(true) };
}

/** Drops cached model lists (after a key changes). */
export function clearModelCache(p?: AiProvider) {
  for (const id of p ? [p] : AI_PROVIDERS.map((x) => x.id)) {
    modelCache.delete(id);
    try {
      localStorage.removeItem(`ai.models.${id}`);
    } catch {
      // nothing cached
    }
  }
}

/** AI access a new connection starts with, per environment group (Settings → AI → Default access). */
const ACCESS: AiAccess[] = ["off", "schema", "data"];
export const defaultAiAccess = (env: Env): AiAccess =>
  env === "prod" ? readPref("ai.access.prod", ACCESS, "schema") : readPref("ai.access.dev", ACCESS, "data");
export const setDefaultAiAccess = (group: "dev" | "prod", access: AiAccess) => writePref(`ai.access.${group}`, access);
