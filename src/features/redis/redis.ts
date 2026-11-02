import type { KvType } from "../../types";

export const KV_TYPES: KvType[] = ["string", "hash", "list", "set", "zset", "stream"];

/** Short badge per key type; module types fall back to their own name. */
export const TYPE_BADGE: Record<string, { label: string; color: string }> = {
  string: { label: "STR", color: "text-accent" },
  hash: { label: "HASH", color: "text-syn-fn" },
  list: { label: "LIST", color: "text-syn-param" },
  set: { label: "SET", color: "text-ok" },
  zset: { label: "ZSET", color: "text-stg" },
  stream: { label: "STRM", color: "text-dev" },
};

export const typeBadge = (type: string) => TYPE_BADGE[type] ?? { label: type.slice(0, 4).toUpperCase(), color: "text-faint" };

/** Remaining TTL as "45s", "12m", "3h 5m", "2d 4h"; "" = no expiry (-1); -2 = the key is gone. */
export function formatTtl(ms: number): string {
  if (ms === -1) return "";
  if (ms < 0) return "—";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** TTL typed by the user: "90", "90s", "5m", "2h", "1d" → seconds; "" → null (no expiry); anything else → undefined. */
export function parseTtl(text: string): number | null | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const m = /^(\d+)\s*([smhd]?)$/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "" | "s" | "m" | "h" | "d"];
  return n > 0 ? n : undefined;
}

/** JSON text pretty-printed with 2 spaces, or null when it isn't a JSON object/array. */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}
