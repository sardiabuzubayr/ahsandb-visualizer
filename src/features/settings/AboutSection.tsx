import { ExternalLink } from "lucide-react";
import { version } from "../../../package.json";
import logo from "../../../src-tauri/icons/128x128@2x.png";
import { useT } from "../../i18n";
import { isTauri } from "../../lib/api";

export const REPO_URL = "https://github.com/sardiabuzubayr/ahsandb-visualizer";

const LIBRARIES: [name: string, license: string][] = [
  ["Tauri", "Apache-2.0 / MIT"],
  ["React", "MIT"],
  ["sqlx", "Apache-2.0 / MIT"],
  ["russh", "Apache-2.0"],
  ["CodeMirror", "MIT"],
  ["React Flow", "MIT"],
  ["ECharts", "Apache-2.0"],
  ["Tailwind CSS", "MIT"],
  ["Lucide", "ISC"],
  ["Geist", "OFL-1.1"],
];

/** The webview can't navigate away, so links go to the system browser (only this repo's URLs are allowed). */
async function openLink(url: string) {
  if (!isTauri) return void window.open(url, "_blank", "noopener");
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/** Settings → About: version, license and links. */
export function AboutSection() {
  const t = useT();
  const links: [label: string, url: string][] = [
    [t("settings.about.source"), REPO_URL],
    [t("settings.about.issue"), `${REPO_URL}/issues/new`],
    [t("settings.about.license"), `${REPO_URL}/blob/main/LICENSE`],
  ];
  return (
    <section aria-labelledby="about-h" className="flex flex-col gap-5">
      <div className="flex items-center gap-4">
        <img src={logo} alt="" width={64} height={64} className="rounded-xl" />
        <div>
          <h2 id="about-h" className="m-0 text-base font-semibold">
            AhsanDB Visualizer
          </h2>
          <p className="m-0 mt-0.5 text-[12.5px] text-muted">{t("settings.about.version", { version })}</p>
        </div>
      </div>
      <p className="m-0 max-w-[560px] text-[13px] text-muted">{t("settings.about.desc")}</p>

      <div className="divide-y divide-border rounded-lg border border-border">
        {links.map(([label, url]) => (
          <button
            key={url}
            type="button"
            onClick={() => void openLink(url)}
            className="flex h-10 w-full items-center justify-between px-3 text-left hover:bg-raised"
          >
            <span>{label}</span>
            <ExternalLink size={13} aria-hidden="true" className="text-muted" />
          </button>
        ))}
      </div>

      <div>
        <h3 className="m-0 mb-1.5 text-xs font-normal text-muted">{t("settings.about.libraries")}</h3>
        <div className="divide-y divide-border rounded-lg border border-border">
          {LIBRARIES.map(([name, license]) => (
            <div key={name} className="flex h-9 items-center justify-between px-3">
              <span>{name}</span>
              <span className="font-mono text-[11.5px] text-muted">{license}</span>
            </div>
          ))}
        </div>
      </div>

      <p className="m-0 text-xs text-faint">{t("settings.about.copyright")}</p>
    </section>
  );
}
