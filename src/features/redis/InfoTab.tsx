import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import { useConnection } from "../../state/app";
import type { KvInfoSection, Tab } from "../../types";
import { Button, IconButton } from "../../components/ui";
import { useConnectionError } from "../../components/shell/connectionError";
import { formatTtl } from "./redis";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Server info: a few headline numbers, then every INFO section as a table. */
export function InfoTab({ tab }: { tab: Tab }) {
  const t = useT();
  const conn = useConnection(tab.connectionId);
  const markLost = useConnectionError();
  const [sections, setSections] = useState<KvInfoSection[] | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    setError("");
    try {
      setSections(await api.kvInfo(conn.id));
    } catch (e) {
      markLost(conn.id, e);
      setError(errText(e));
    }
  };
  useEffect(() => {
    if (conn.connected) void load();
    else setError(t("kv.notConnected"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id, conn.connected]);

  const field = (name: string) => sections?.flatMap((s) => s.fields).find(([k]) => k === name)?.[1];
  const hits = Number(field("keyspace_hits") ?? 0);
  const misses = Number(field("keyspace_misses") ?? 0);
  const keys = (sections?.find((s) => s.name === "Keyspace")?.fields ?? []).reduce((n, [, v]) => n + Number(/keys=(\d+)/.exec(v)?.[1] ?? 0), 0);
  const uptime = Number(field("uptime_in_seconds") ?? NaN);
  const stats: [string, string | undefined][] = [
    [t("kv.info.version"), field("valkey_version") ?? field("redis_version")],
    [t("kv.info.mode"), field("redis_mode")],
    [t("kv.info.uptime"), Number.isFinite(uptime) ? formatTtl(uptime * 1000) : undefined],
    [t("kv.info.clients"), field("connected_clients")],
    [t("kv.info.memory"), field("used_memory_human")],
    [t("kv.info.ops"), field("instantaneous_ops_per_sec")],
    [t("kv.info.hitRate"), hits + misses > 0 ? `${((hits / (hits + misses)) * 100).toFixed(1)}%` : undefined],
    [t("kv.info.keys"), sections ? keys.toLocaleString() : undefined],
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[46px] shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[12.5px] font-medium">{conn.name}</span>
        {conn.serverVersion && <span className="text-xs text-muted">{conn.serverVersion}</span>}
        <span className="flex-1" />
        <IconButton label={t("data.refresh")} onClick={() => void load()} disabled={!conn.connected}>
          <RotateCw size={14} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 text-[12.5px]">
        {error ? (
          <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="m-0 text-prod">{error}</p>
            {conn.connected && <Button onClick={() => void load()}>{t("data.retry")}</Button>}
          </div>
        ) : !sections ? (
          <p className="m-0 py-10 text-center text-muted">{t("kv.loadingInfo")}</p>
        ) : (
          <>
            <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
              {stats.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-surface px-3 py-2.5">
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="m-0 mt-1 font-mono text-[15px] font-medium">{value ?? "—"}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-start gap-3">
              {sections.map((s) => (
                <section key={s.name} aria-label={s.name} className="overflow-hidden rounded-lg border border-border">
                  <h2 className="m-0 border-b border-border bg-panel px-3 py-2 text-xs font-semibold">{s.name || "—"}</h2>
                  <table className="w-full table-fixed border-collapse">
                    <tbody>
                      {s.fields.map(([k, v]) => (
                        <tr key={k} className="border-b border-border last:border-0">
                          <th scope="row" className="w-1/2 truncate px-3 py-1 text-left font-mono text-[11.5px] font-normal text-muted" title={k}>
                            {k}
                          </th>
                          <td className="truncate px-3 py-1 font-mono text-[11.5px] select-text" title={v}>
                            {v}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
