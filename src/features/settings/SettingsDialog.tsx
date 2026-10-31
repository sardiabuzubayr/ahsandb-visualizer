import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { LANG_PREFS, resolveLang, useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { THEME_PREFS, useTheme } from "../../theme/ThemeProvider";
import { Dialog, IconButton, cn } from "../../components/ui";
import { AboutSection } from "./AboutSection";
import { AiSection } from "./AiSection";
import { EditorSection } from "./EditorSection";
import { ShortcutsSection } from "./ShortcutsSection";

const NAV = ["general", "editor", "ai", "shortcuts", "about"] as const;

export function SettingsDialog() {
  const { t, pref: langPref, setPref: setLang } = useI18n();
  const theme = useTheme();
  const { state, dispatch } = useApp();
  const [nav, setNav] = useState<(typeof NAV)[number]>(() => state.dialogContext?.section ?? "general");
  const content = useRef<HTMLDivElement>(null);
  const aiRef = useRef<HTMLElement>(null);
  const close = () => dispatch({ type: "closeDialog" });

  const go = (n: (typeof NAV)[number]) => {
    setNav(n);
    // "AI agent" lives on the General page; jump to it after render.
    requestAnimationFrame(() => (n === "ai" ? aiRef.current?.scrollIntoView({ block: "start" }) : content.current?.scrollTo(0, 0)));
  };
  const showGeneral = nav === "general" || nav === "ai";
  // Opened from the agent panel's "add a key" link: start at the AI section.
  useEffect(() => {
    if (state.dialogContext?.section === "ai") requestAnimationFrame(() => aiRef.current?.scrollIntoView({ block: "start" }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open onClose={close} labelledBy="set-title" className="h-[min(780px,calc(100vh-60px))] max-w-[880px] open:flex">
      <nav aria-label={t("settings.sections")} className="flex w-[210px] shrink-0 flex-col gap-0.5 border-r border-border bg-surface px-2.5 py-4">
        <h1 id="set-title" className="m-0 mb-3 px-2 text-[15px] font-semibold">
          {t("settings.title")}
        </h1>
        {NAV.map((n) => (
          <button
            key={n}
            type="button"
            aria-current={nav === n ? "page" : undefined}
            onClick={() => go(n)}
            className={cn("h-8 rounded-md px-2.5 text-left", nav === n ? "bg-raised text-text" : "text-muted hover:text-text")}
          >
            {t(`settings.nav.${n}`)}
          </button>
        ))}
      </nav>

      <IconButton label={t("common.close")} size={28} onClick={close} className="absolute top-3 right-3">
        <X size={14} />
      </IconButton>

      <div ref={content} className="flex min-w-0 flex-1 flex-col *:shrink-0 gap-[26px] overflow-auto px-6 py-[22px]">
        {nav === "editor" && <EditorSection />}
        {nav === "shortcuts" && <ShortcutsSection />}
        {nav === "about" && <AboutSection />}

        {showGeneral && (
          <>
            <Section id="lang-h" title={t("settings.lang")} desc={t("settings.lang.desc")}>
              <Cards label={t("settings.lang.label")}>
                {LANG_PREFS.map((p) => (
                  <Card key={p} on={langPref === p} onClick={() => setLang(p)} className="gap-0.5 p-3">
                    <span className="font-medium" lang={p === "system" ? undefined : p}>
                      {t(`settings.lang.${p}`)}
                    </span>
                    <span className="text-xs text-muted">
                      {p === "system"
                        ? t("settings.lang.current", { lang: t(`settings.lang.name.${resolveLang("system", navigator.language)}`) })
                        : t(`settings.lang.${p}.alt`)}
                    </span>
                  </Card>
                ))}
              </Cards>
            </Section>

            <Section id="theme-h" title={t("settings.theme")} desc={t("settings.theme.desc")}>
              <Cards label={t("settings.theme")}>
                {THEME_PREFS.map((p) => (
                  <Card key={p} on={theme.pref === p} onClick={() => theme.setPref(p)} className="gap-2 p-2.5">
                    <ThemePreview kind={p} />
                    <span className="font-medium">{t(`settings.theme.${p}`)}</span>
                  </Card>
                ))}
              </Cards>
            </Section>

            <section ref={aiRef} aria-labelledby="ai-h" className="flex scroll-mt-4 flex-col gap-3">
              <AiSection />
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}

function Section({ id, title, desc, children }: { id: string; title: string; desc: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="m-0 mb-1 text-sm font-semibold">
        {title}
      </h2>
      <p className="m-0 mb-3 text-[12.5px] text-muted">{desc}</p>
      {children}
    </section>
  );
}

function Cards({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-3 gap-2">
      {children}
    </div>
  );
}

function Card({ on, onClick, className, children }: { on: boolean; onClick: () => void; className: string; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        "flex flex-col items-stretch rounded-lg border text-left",
        on ? "border-accent bg-accent-bg" : "border-border bg-surface hover:border-border-strong",
        className,
      )}
    >
      {children}
    </button>
  );
}

// Previews show each theme's own colors regardless of the active theme, so they use fixed values.
function ThemePreview({ kind }: { kind: "system" | "dark" | "light" }) {
  if (kind === "system")
    return (
      <span aria-hidden="true" className="flex h-14 overflow-hidden rounded-md border border-border-strong">
        <span className="flex-1" style={{ background: "#0E0E11" }} />
        <span className="flex-1" style={{ background: "#F6F6F8" }} />
      </span>
    );
  const [bg, bar, accent] = kind === "dark" ? ["#0E0E11", "#2A2A31", "#8EA2FF"] : ["#F6F6F8", "#D9D9DF", "#4F63D9"];
  return (
    <span aria-hidden="true" className="flex h-14 flex-col gap-1.5 rounded-md border border-border-strong p-2" style={{ background: bg }}>
      <span className="h-1.5 w-3/5 rounded-[3px]" style={{ background: bar }} />
      <span className="h-1.5 w-2/5 rounded-[3px]" style={{ background: accent }} />
    </span>
  );
}
