import { CodeEditor } from "../editor/CodeEditor";
import { FONT_SIZES, PAGE_SIZES, setEditorPrefs, useEditorPrefs, type KeywordCase } from "../../lib/editorPrefs";
import { useT } from "../../i18n";
import { Segmented, Switch } from "../../components/ui";
import { Select } from "../../components/ui/Select";

const SAMPLE = `-- Revenue per customer, last 30 days
SELECT c.id, c.name, SUM(o.total) AS revenue
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.created_at >= now() - interval '30 days' AND o.status <> 'cancelled' AND o.total > 0
GROUP BY c.id, c.name
ORDER BY revenue DESC
LIMIT 50;`;

/** Settings → Editor: applies to every SQL/routine editor right away. */
export function EditorSection() {
  const t = useT();
  const p = useEditorPrefs();
  const row = "flex min-h-11 items-center justify-between gap-4 px-3 py-2";
  return (
    <section aria-labelledby="editor-h" className="flex flex-col gap-3">
      <div>
        <h2 id="editor-h" className="m-0 mb-1 text-sm font-semibold">
          {t("settings.nav.editor")}
        </h2>
        <p className="m-0 text-[12.5px] text-muted">{t("settings.editor.desc")}</p>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border">
        <div className={row}>
          <span>{t("settings.editor.fontSize")}</span>
          <Select compact className="w-[110px]" aria-label={t("settings.editor.fontSize")} value={String(p.fontSize)} onChange={(e) => setEditorPrefs({ fontSize: Number(e.target.value) })}>
            {FONT_SIZES.map((s) => (
              <option key={s} value={s}>
                {s} px
              </option>
            ))}
          </Select>
        </div>
        <div className={row}>
          <span>
            {t("settings.editor.pageSize")}
            <span className="block text-xs text-muted">{t("settings.editor.pageSizeHint")}</span>
          </span>
          <Select compact className="w-[110px]" aria-label={t("settings.editor.pageSize")} value={String(p.pageSize)} onChange={(e) => setEditorPrefs({ pageSize: Number(e.target.value) })}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </div>
        <div className={row}>
          <span>{t("settings.editor.tabSize")}</span>
          <Segmented
            label={t("settings.editor.tabSize")}
            value={String(p.tabSize) as "2" | "4"}
            onChange={(v) => setEditorPrefs({ tabSize: v === "4" ? 4 : 2 })}
            options={[
              { value: "2", label: t("settings.editor.spaces", { n: 2 }) },
              { value: "4", label: t("settings.editor.spaces", { n: 4 }) },
            ]}
          />
        </div>
        <div className={row}>
          <span>
            {t("settings.editor.wordWrap")}
            <span className="block text-xs text-muted">{t("settings.editor.wordWrapHint")}</span>
          </span>
          <Switch checked={p.wordWrap} onChange={(v) => setEditorPrefs({ wordWrap: v })} label={t("settings.editor.wordWrap")} />
        </div>
        <div className={row}>
          <span>
            {t("settings.editor.keywordCase")}
            <span className="block text-xs text-muted">{t("settings.editor.keywordCaseHint")}</span>
          </span>
          <Segmented<KeywordCase>
            label={t("settings.editor.keywordCase")}
            value={p.keywordCase}
            onChange={(v) => setEditorPrefs({ keywordCase: v })}
            options={[
              { value: "upper", label: "SELECT" },
              { value: "lower", label: "select" },
              { value: "preserve", label: t("settings.editor.asTyped") },
            ]}
          />
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-xs text-muted">{t("settings.editor.preview")}</div>
        <div className="h-[190px] overflow-hidden rounded-lg border border-border bg-bg">
          <CodeEditor value={SAMPLE} label={t("settings.editor.preview")} />
        </div>
      </div>
    </section>
  );
}
