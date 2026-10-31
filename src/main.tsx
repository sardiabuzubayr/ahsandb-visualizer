import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { writePref } from "./lib/storage";

// Hide the webview's Reload/Inspect menu (the inspector stays on ⌘⌥I in dev); text fields and the editor
// keep theirs for copy/paste. App context menus call preventDefault themselves.
document.addEventListener("contextmenu", (e) => {
  if (!(e.target as HTMLElement).closest("input, textarea, .cm-editor")) e.preventDefault();
});

// Dev aid for screenshots: ?theme=light&lang=id
if (import.meta.env.DEV) {
  const q = new URLSearchParams(location.search);
  for (const k of ["theme", "lang"]) if (q.get(k)) writePref(k, q.get(k)!);
}

createRoot(document.getElementById("root")!, {
  // A render error outside the per-tab boundaries would otherwise leave an empty window.
  onUncaughtError: (error) => {
    const root = document.getElementById("root")!;
    root.innerHTML = "";
    const pre = document.createElement("pre");
    pre.style.cssText = "margin:48px 24px;white-space:pre-wrap;font:12px ui-monospace,monospace;color:#f87171";
    pre.textContent = `AhsanDB failed to start\n\n${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`;
    root.appendChild(pre);
  },
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
