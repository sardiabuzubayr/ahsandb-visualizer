import { MessageSquareText, Search } from "lucide-react";
import { useT } from "../../i18n";
import { useApp } from "../../state/app";
import { Kbd, cn } from "../ui";

export function TitleBar() {
  const t = useT();
  const { state, dispatch } = useApp();
  return (
    // Left padding leaves room for the native macOS traffic lights (titleBarStyle: Overlay).
    <header
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-panel pr-3.5 pl-[84px]"
    >
      <div data-tauri-drag-region className="w-[120px]" />
      <div data-tauri-drag-region className="flex min-w-0 flex-1 justify-center">
        <button
          type="button"
          onClick={() => dispatch({ type: "setPalette", open: true })}
          className="flex h-7 w-full max-w-[460px] items-center gap-2 rounded-[7px] border border-border bg-surface px-2.5 text-muted hover:border-border-strong"
        >
          <Search size={14} aria-hidden="true" />
          <span className="flex-1 truncate text-left">{t("shell.search")}</span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>
      <div className="flex w-[120px] justify-end">
        <button
          type="button"
          aria-pressed={state.agentOpen}
          onClick={() => dispatch({ type: "toggleAgent" })}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-[7px] border px-2.5",
            state.agentOpen ? "border-accent bg-accent-bg text-text" : "border-border bg-surface text-muted hover:text-text",
          )}
        >
          <MessageSquareText size={14} aria-hidden="true" />
          {t("shell.agent")}
          <Kbd>⌘J</Kbd>
        </button>
      </div>
    </header>
  );
}
