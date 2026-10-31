import { createContext, useContext, useState, type ReactNode } from "react";
import { readPref, writePref } from "../lib/storage";

// Every feature keeps its strings in its own `i18n.ts` ({ en, id }); they are merged here
// so parallel work never edits one shared dictionary.
export type Dict = Record<string, string>;
export interface DictModule {
  en: Dict;
  id: Dict;
}

const modules = import.meta.glob<DictModule>("/src/**/i18n.ts", { eager: true, import: "default" });

export function mergeModules(mods: Record<string, DictModule>): DictModule {
  const out: DictModule = { en: {}, id: {} };
  for (const m of Object.values(mods)) {
    Object.assign(out.en, m.en);
    Object.assign(out.id, m.id);
  }
  return out;
}

export const dictionaries = mergeModules(modules);
export { modules as dictModules };

export const LANG_PREFS = ["system", "en", "id"] as const;
export type LangPref = (typeof LANG_PREFS)[number];
export type Lang = "en" | "id";

export function resolveLang(pref: LangPref, systemLang: string): Lang {
  if (pref !== "system") return pref;
  return systemLang.toLowerCase().startsWith("id") ? "id" : "en";
}

export function translate(dict: Dict, key: string, vars?: Record<string, string | number>): string {
  const s = dict[key] ?? dictionaries.en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : s;
}

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

interface I18nCtx {
  pref: LangPref;
  lang: Lang;
  setPref: (p: LangPref) => void;
  t: TFn;
}

const Ctx = createContext<I18nCtx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<LangPref>(() => readPref("lang", LANG_PREFS, "system"));
  const lang = resolveLang(pref, navigator.language);
  const t: TFn = (key, vars) => translate(dictionaries[lang], key, vars);
  const setPref = (p: LangPref) => {
    setPrefState(p);
    writePref("lang", p);
  };
  document.documentElement.lang = lang;
  return <Ctx.Provider value={{ pref, lang, setPref, t }}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useI18n outside I18nProvider");
  return c;
}

export function useT(): TFn {
  return useI18n().t;
}
