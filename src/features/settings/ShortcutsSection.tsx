import { SHORTCUT_LIST } from "../../components/shell/shortcuts";
import { useT } from "../../i18n";
import { Kbd } from "../../components/ui";

/** Settings → Keyboard shortcuts: a reference list (shortcuts aren't rebindable). */
export function ShortcutsSection() {
  const t = useT();
  return (
    <section aria-labelledby="shortcuts-h" className="flex flex-col gap-4">
      <div>
        <h2 id="shortcuts-h" className="m-0 mb-1 text-sm font-semibold">
          {t("settings.nav.shortcuts")}
        </h2>
        <p className="m-0 text-[12.5px] text-muted">{t("settings.shortcuts.desc")}</p>
      </div>
      {(["app", "editor", "data"] as const).map((g) => (
        <div key={g}>
          <h3 className="m-0 mb-1.5 text-xs font-normal text-muted">{t(`settings.shortcuts.${g}`)}</h3>
          <div className="divide-y divide-border rounded-lg border border-border">
            {SHORTCUT_LIST.filter((s) => s.group === g).map((s) => (
              <div key={s.keys + s.label} className="flex h-10 items-center justify-between px-3">
                <span>{t(s.label)}</span>
                <Kbd>{s.keys}</Kbd>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
