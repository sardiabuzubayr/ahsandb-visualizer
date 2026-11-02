// mock: an in-memory Redis for the browser-only dev mode (db0 with sample keys, db1 with a few).
import type { KvEdit, KvEntry, KvInfoSection, KvKey, KvReply, KvScanPage, KvValue, SchemaNode } from "../types";

type Stored = { value: KvValue; expiresAt?: number };

const dbs: Record<number, Map<string, Stored>> = {
  0: new Map<string, Stored>([
    ["user:1", { value: { kind: "hash", entries: [["name", "Ahmad"], ["city", "Bandung"], ["plan", "pro"]] } }],
    ["user:2", { value: { kind: "hash", entries: [["name", "Siti"], ["city", "Surabaya"], ["plan", "free"]] } }],
    ["session:9f2c", { value: { kind: "string", value: '{"userId":1,"ip":"10.0.0.7"}', binary: false }, expiresAt: Date.now() + 3_540_000 }],
    ["config:feature_flags", { value: { kind: "string", value: "checkout_v2,dark_mode", binary: false } }],
    ["queue:emails", { value: { kind: "list", items: ["welcome:1", "reset:2", "digest:7"] } }],
    ["tags:popular", { value: { kind: "set", members: ["sale", "new", "bundle"] } }],
    ["leaderboard", { value: { kind: "zset", entries: [["siti", 120], ["ahmad", 98], ["budi", 75]] } }],
    ["events:orders", { value: { kind: "stream", entries: [{ id: "1761900000000-0", fields: [["order", "10231"], ["status", "paid"]] }] } }],
  ]),
  1: new Map<string, Stored>([["cache:home", { value: { kind: "string", value: "<html>…</html>", binary: false }, expiresAt: Date.now() + 60_000 }]]),
};

const db = (id: string) => (dbs[Number(id.split("@")[1] ?? 0)] ??= new Map());
const ttlOf = (s: Stored) => (s.expiresAt ? Math.max(0, s.expiresAt - Date.now()) : -1);
const sizeOf = (v: KvValue) =>
  v.kind === "string" ? new TextEncoder().encode(v.value).length
  : v.kind === "hash" || v.kind === "zset" || v.kind === "stream" ? v.entries.length
  : v.kind === "list" ? v.items.length
  : v.kind === "set" ? v.members.length
  : 0;
// Rough MEMORY USAGE stand-in: overhead plus the value as JSON.
const memoryOf = (key: string, v: KvValue) => 56 + key.length + JSON.stringify(v).length;
const glob = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

export function mockKeyspaces(connId: string): SchemaNode[] {
  return Array.from({ length: 16 }, (_, i) => ({ id: `${connId}/db${i}`, label: `db${i}`, kind: "keyspace", count: dbs[i]?.size ?? 0, schema: String(i) }));
}

export function mockScan(id: string, pattern: string, typeFilter: string | null, hasTtl: boolean | null = null): KvScanPage {
  const re = glob(pattern || "*");
  const keys: KvKey[] = [...db(id).entries()]
    .filter(([k, s]) => re.test(k) && (!typeFilter || s.value.kind === typeFilter) && (hasTtl === null || !!s.expiresAt === hasTtl))
    .map(([key, s]) => ({ key, type: s.value.kind, ttlMs: ttlOf(s), memory: memoryOf(key, s.value) }));
  return { cursor: "0", keys };
}

export function mockGet(id: string, key: string): KvEntry {
  const s = db(id).get(key);
  if (!s) return { key, type: "none", ttlMs: -2, length: 0, truncated: false, binary: false, value: { kind: "none" } };
  return { key, type: s.value.kind, ttlMs: ttlOf(s), length: sizeOf(s.value), truncated: false, binary: false, memory: memoryOf(key, s.value), value: structuredClone(s.value) };
}

export function mockEdit(id: string, e: KvEdit): void {
  const m = db(id);
  const get = (key: string) => m.get(key)?.value;
  switch (e.op) {
    case "setString":
      m.set(e.key, { ...m.get(e.key), value: { kind: "string", value: e.value, binary: false } });
      return;
    case "hashSet": {
      const v = get(e.key);
      if (v?.kind !== "hash") return;
      v.entries = v.entries.filter(([f]) => f !== e.replace && f !== e.field);
      v.entries.push([e.field, e.value]);
      return;
    }
    case "hashDel": {
      const v = get(e.key);
      if (v?.kind === "hash") v.entries = v.entries.filter(([f]) => f !== e.field);
      return;
    }
    case "listSet": {
      const v = get(e.key);
      if (v?.kind === "list") v.items[e.index] = e.value;
      return;
    }
    case "listPush": {
      const v = get(e.key);
      if (v?.kind === "list") (e.head ? v.items.unshift(e.value) : v.items.push(e.value));
      return;
    }
    case "listRemove": {
      const v = get(e.key);
      if (v?.kind === "list") v.items.splice(v.items.indexOf(e.value), 1);
      return;
    }
    case "setAdd": {
      const v = get(e.key);
      if (v?.kind === "set") v.members = [...new Set([...v.members.filter((x) => x !== e.replace), e.member])];
      return;
    }
    case "setRemove": {
      const v = get(e.key);
      if (v?.kind === "set") v.members = v.members.filter((x) => x !== e.member);
      return;
    }
    case "zsetAdd": {
      const v = get(e.key);
      if (v?.kind !== "zset") return;
      v.entries = v.entries.filter(([x]) => x !== e.replace && x !== e.member);
      v.entries.push([e.member, e.score]);
      v.entries.sort((a, b) => a[1] - b[1]);
      return;
    }
    case "zsetRemove": {
      const v = get(e.key);
      if (v?.kind === "zset") v.entries = v.entries.filter(([x]) => x !== e.member);
      return;
    }
    case "streamAdd": {
      const v = get(e.key);
      if (v?.kind === "stream") v.entries.push({ id: `${Date.now()}-0`, fields: e.fields });
      return;
    }
    case "streamDel": {
      const v = get(e.key);
      if (v?.kind === "stream") v.entries = v.entries.filter((x) => x.id !== e.id);
      return;
    }
    case "expire": {
      const s = m.get(e.key);
      if (s) s.expiresAt = e.ttlSecs === null ? undefined : Date.now() + e.ttlSecs * 1000;
      return;
    }
    case "rename": {
      const s = m.get(e.key);
      if (m.has(e.to)) throw new Error(`A key named ${e.to} already exists`);
      if (s) (m.delete(e.key), m.set(e.to, s));
      return;
    }
    case "delete":
      e.keys.forEach((k) => m.delete(k));
      return;
    case "create": {
      if (m.has(e.key)) throw new Error(`A key named ${e.key} already exists`);
      const value: KvValue =
        e.kind === "string" ? { kind: "string", value: e.value, binary: false }
        : e.kind === "hash" ? { kind: "hash", entries: [[e.field ?? "", e.value]] }
        : e.kind === "list" ? { kind: "list", items: [e.value] }
        : e.kind === "set" ? { kind: "set", members: [e.value] }
        : e.kind === "zset" ? { kind: "zset", entries: [[e.value, e.score ?? 0]] }
        : { kind: "stream", entries: [{ id: `${Date.now()}-0`, fields: [[e.field ?? "", e.value]] }] };
      m.set(e.key, { value, expiresAt: e.ttlSecs ? Date.now() + e.ttlSecs * 1000 : undefined });
    }
  }
}

export function mockCommand(id: string, line: string): KvReply {
  const [name = "", ...args] = line.trim().split(/\s+/);
  const cmd = name.toUpperCase();
  const reply = (text: string, error = false): KvReply => ({ text, error, elapsedMs: 1 });
  if (cmd === "PING") return reply("PONG");
  if (cmd === "DBSIZE") return reply(`(integer) ${db(id).size}`);
  if (cmd === "GET") {
    const v = db(id).get(args[0] ?? "")?.value;
    return v?.kind === "string" ? reply(JSON.stringify(v.value)) : reply(v ? "(error) WRONGTYPE Operation against a key holding the wrong kind of value" : "(nil)", !!v);
  }
  if (cmd === "KEYS" || cmd === "SCAN") {
    const keys = mockScan(id, cmd === "KEYS" ? (args[0] ?? "*") : "*", null).keys.map((k, i) => `${i + 1}) "${k.key}"`);
    return reply(keys.join("\n") || "(empty array)");
  }
  return reply(`(error) ERR unknown command '${name}' (the browser mock knows PING, DBSIZE, GET, KEYS, SCAN)`, true);
}

export const mockInfo: KvInfoSection[] = [
  { name: "Server", fields: [["redis_version", "7.2.4"], ["redis_mode", "standalone"], ["os", "Linux 6.1.0 x86_64"], ["uptime_in_seconds", "864210"], ["tcp_port", "6379"]] },
  { name: "Clients", fields: [["connected_clients", "12"], ["blocked_clients", "0"]] },
  { name: "Memory", fields: [["used_memory", "4194304"], ["used_memory_human", "4.00M"], ["used_memory_peak_human", "6.12M"], ["maxmemory_human", "0B"], ["maxmemory_policy", "noeviction"]] },
  { name: "Stats", fields: [["total_connections_received", "1840"], ["total_commands_processed", "922133"], ["instantaneous_ops_per_sec", "37"], ["keyspace_hits", "81233"], ["keyspace_misses", "1220"]] },
  { name: "Persistence", fields: [["rdb_last_save_time", "1761900000"], ["aof_enabled", "0"]] },
  { name: "Keyspace", fields: [["db0", "keys=8,expires=1,avg_ttl=3540000"], ["db1", "keys=1,expires=1,avg_ttl=60000"]] },
];
