import { expect, test } from "vitest";
import { ApiError } from "../../lib/api";
import { translate } from "../../i18n";
import dicts from "./i18n";
import { CUSTOM_MODEL, effectiveModel, modelOptions, selectValue, testText } from "./aiSettings";

const t = (k: string, v?: Record<string, string | number>) => translate(dicts.en, k, v);
const models = [
  { id: "a", name: "Model A" },
  { id: "b", name: "" },
];

test("testText", () => {
  expect(testText(t, { models: 3 })).toBe("Key works · 3 models");
  expect(testText(t, { error: new ApiError("auth", "Invalid API key") })).toBe("Invalid key: Invalid API key");
  expect(testText(t, { error: new ApiError("connection", "Provider unreachable") })).toBe("Provider unreachable");
  expect(testText(t, { error: "boom" })).toBe("boom");
});

test("effectiveModel: saved, then provider default, then first listed", () => {
  expect(effectiveModel("anthropic", "x", models)).toBe("x");
  expect(effectiveModel("anthropic", "", models)).toBe("claude-opus-5-5");
  expect(effectiveModel("openai", "", models)).toBe("a");
  expect(effectiveModel("openai", "", [])).toBe("");
});

test("modelOptions ends with the custom option and falls back to the id", () => {
  expect(modelOptions(t, models)).toEqual([
    { value: "a", label: "Model A" },
    { value: "b", label: "b" },
    { value: CUSTOM_MODEL, label: "Custom model id…" },
  ]);
});

test("selectValue", () => {
  expect(selectValue(models, "a", false)).toBe("a");
  expect(selectValue(models, "a", true)).toBe(CUSTOM_MODEL);
  expect(selectValue(models, "zzz", false)).toBe(CUSTOM_MODEL);
});
