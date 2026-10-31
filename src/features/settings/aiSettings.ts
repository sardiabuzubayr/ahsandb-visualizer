// Pure helpers for Settings → AI (key test status, model select options).
import type { TFn } from "../../i18n";
import { ApiError } from "../../lib/api";
import { DEFAULT_MODEL } from "../../lib/aiPrefs";
import type { AiModel, AiProvider } from "../../types";

/** Select value of the "Custom model id" option (not a valid model id). */
export const CUSTOM_MODEL = "\u0000custom";

export type TestResult = { models: number } | { error: unknown };

/** "Key works · N models", or the error; `auth` reads as an invalid key. */
export function testText(t: TFn, r: TestResult): string {
  if ("models" in r) return t("settings.ai.keyWorks", { n: r.models });
  const e = r.error;
  if (e instanceof ApiError && e.kind === "auth") return t("settings.ai.badKey", { msg: e.message });
  return e instanceof Error ? e.message : String(e);
}

/** Model shown for a provider: the saved choice, else the provider default, else the first listed model. */
export function effectiveModel(provider: AiProvider, saved: string, models: AiModel[]): string {
  return saved || DEFAULT_MODEL[provider] || models[0]?.id || "";
}

/** Listed models plus the custom option. */
export function modelOptions(t: TFn, models: AiModel[]): { value: string; label: string }[] {
  return [...models.map((m) => ({ value: m.id, label: m.name || m.id })), { value: CUSTOM_MODEL, label: t("settings.ai.customModel") }];
}

/** Select value: the model if it is listed (and custom was not picked), else the custom option. */
export function selectValue(models: AiModel[], model: string, customOn: boolean): string {
  return !customOn && models.some((m) => m.id === model) ? model : CUSTOM_MODEL;
}
