// OS file dialogs for .sql files (Tauri dialog plugin). In the browser mock they return a fixed path.
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./api";

const FILTERS = [{ name: "SQL", extensions: ["sql"] }];

export async function pickSqlToOpen(): Promise<string | null> {
  if (!isTauri) return "~/Documents/query.sql";
  return invoke<string | null>("plugin:dialog|open", { options: { multiple: false, directory: false, filters: FILTERS } });
}

export async function pickSqlToSave(defaultName: string): Promise<string | null> {
  if (!isTauri) return `~/Documents/${defaultName}`;
  const path = await invoke<string | null>("plugin:dialog|save", { options: { defaultPath: defaultName, filters: FILTERS } });
  return path && !/\.sql$/i.test(path) ? `${path}.sql` : path;
}

/** "orders report.sql" from a path. */
export const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/** Save dialog for any file type; adds the extension when the user left it off. */
export async function pickFileToSave(defaultName: string, filter: { name: string; extension: string }): Promise<string | null> {
  if (!isTauri) return `~/Documents/${defaultName}`;
  const path = await invoke<string | null>("plugin:dialog|save", {
    options: { defaultPath: defaultName, filters: [{ name: filter.name, extensions: [filter.extension] }] },
  });
  return path && !path.toLowerCase().endsWith(`.${filter.extension}`) ? `${path}.${filter.extension}` : path;
}
