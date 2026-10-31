export type ShortcutAction = "palette" | "agent" | "sidebar" | "newSql" | "openSql";

/** Maps a keydown to an app shortcut. ⌘K is ignored while a modal is open. */
export function shortcutFor(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  modalOpen: boolean,
): ShortcutAction | null {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return null;
  switch (e.key.toLowerCase()) {
    case "k":
      return modalOpen ? null : "palette";
    case "j":
      return "agent";
    case "b":
      return "sidebar";
    case "t":
      return modalOpen ? null : "newSql";
    case "o":
      return modalOpen ? null : "openSql";
    default:
      return null;
  }
}

/** Every keyboard shortcut, for Settings → Keyboard shortcuts (labels are i18n keys). */
export const SHORTCUT_LIST: { group: "app" | "editor" | "data"; keys: string; label: string }[] = [
  { group: "app", keys: "⌘K", label: "shortcut.palette" },
  { group: "app", keys: "⌘J", label: "shortcut.agent" },
  { group: "app", keys: "⌘B", label: "shortcut.sidebar" },
  { group: "app", keys: "⌘T", label: "shortcut.newSql" },
  { group: "app", keys: "⌘O", label: "shortcut.openSql" },
  { group: "app", keys: "Esc", label: "shortcut.close" },
  { group: "editor", keys: "⌘↵", label: "shortcut.run" },
  { group: "editor", keys: "⇧⌘↵", label: "shortcut.runScript" },
  { group: "editor", keys: "⇧⌥F", label: "shortcut.format" },
  { group: "editor", keys: "⌘S", label: "shortcut.save" },
  { group: "editor", keys: "⇧⌘S", label: "shortcut.saveAs" },
  { group: "editor", keys: "⌘Z / ⇧⌘Z", label: "shortcut.undo" },
  { group: "editor", keys: "⌘F", label: "shortcut.find" },
  { group: "editor", keys: "⌃Space", label: "shortcut.complete" },
  { group: "data", keys: "Enter / F2", label: "shortcut.editCell" },
  { group: "data", keys: "Esc", label: "shortcut.cancelEdit" },
];
