import { Plus, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Checkbox, EnvDot, IconButton, Menu, Switch, cn } from "../../components/ui";
import { Select } from "../../components/ui/Select";
import { useConnectionError } from "../../components/shell/connectionError";
import { previewErrorText } from "../../components/shell/PreviewList";
import { errorText } from "../../components/shell/useConnect";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import { scopedId } from "../../lib/scope";
import { databaseNodes, firstDatabase } from "../editor/treeScope";
import { useApp, useConnection, useTabDirty, useToast } from "../../state/app";
import { PRIVILEGES, ROLE_ATTRS, type PrivilegeRow, type Role, type RoleAttr, type SchemaNode, type Tab } from "../../types";
import { ReviewDialog, type ReviewState } from "../routine/ReviewDialog";
import { diffPrivileges, draftOf, rolePreviewArgs, roleSql, type RoleDraft } from "./diff";

const KIND: Record<PrivilegeRow["kind"], [string, string]> = {
  schema: ["SC", "text-faint"],
  table: ["T", "text-accent"],
  view: ["V", "text-syn-fn"],
  sequence: ["SQ", "text-faint"],
  function: ["ƒ", "text-syn-param"],
};
const CELL = "flex h-[38px] items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3";
const SMALL_INPUT = "h-[26px] rounded-md border border-border-strong bg-bg px-2 font-mono text-xs text-text outline-none placeholder:text-faint focus:border-accent";
const GRID = "grid grid-cols-[minmax(220px,1.6fr)_repeat(9,minmax(64px,1fr))] items-center";
/** Key of the unsaved "New role" draft (can't clash with a real role name). */
const NEW = "\u0000new";
const NEW_ROLE: Role = {
  name: "",
  tag: "login",
  attrs: { login: true, superuser: false, createdb: false, createrole: false, inherit: true, replication: false },
  memberOf: [],
};
const MYSQL_NA: RoleAttr[] = ["superuser", "createdb", "createrole", "replication"];

type PrivEntry = { original: PrivilegeRow[]; draft: PrivilegeRow[] } | { error: string };
const privKey = (role: string, schema: string) => `${role}\u0000${schema}`;

const toggle = (rows: PrivilegeRow[], name: string, i: number): PrivilegeRow[] =>
  rows.map((r) => (r.name === name ? { ...r, cells: r.cells.map((c, j) => (j === i ? (c === "on" ? "off" : "on") : c)) } : r));

const namesOf = (nodes: SchemaNode[], kind: SchemaNode["kind"]): string[] =>
  nodes.flatMap((n) => [...(n.kind === kind ? [n.label] : []), ...namesOf(n.children ?? [], kind)]);

/** Colors uppercase SQL keywords in the summary line. */
const kw = (s: string) =>
  s.split(/(\b[A-Z]{2,}\b)/).map((p, i) => (i % 2 ? <span key={i} className="text-syn-kw">{p}</span> : p));

export function RolesTab({ tab }: { tab: Tab }) {
  const t = useT();
  const toast = useToast();
  const conn = useConnection(tab.connectionId);
  // Roles are cluster-wide (conn.id); privileges and their previews belong to the tab's database.
  const sid = scopedId(conn.id, tab.database);
  const database = tab.database ?? firstDatabase(conn.database);
  const { state } = useApp();
  const markLost = useConnectionError();
  const isMy = conn.driver === "mysql" || conn.driver === "mariadb";
  const tree = state.trees[conn.id];
  // Schemas (PG) or databases (MySQL/MariaDB) from the navigator tree, when it's loaded.
  const treeNames = tree?.status === "ready" ? namesOf(databaseNodes(tree.nodes, tab.database), isMy ? "database" : "schema") : [];

  const [roles, setRoles] = useState<Role[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [schema, setSchema] = useState(() => (isMy ? (firstDatabase(conn.database) ?? treeNames[0] ?? "") : "public"));
  // Per-role edits survive switching roles; their `privs` field is unused (privileges live in `privs`, per role+schema).
  const [drafts, setDrafts] = useState<Record<string, RoleDraft>>({});
  const [privs, setPrivs] = useState<Record<string, PrivEntry>>({});
  // undefined = keep the current password; a string = the Change… field is open.
  const [passwords, setPasswords] = useState<Record<string, string | undefined>>({});
  const [newName, setNewName] = useState("");
  const [review, setReview] = useState<(ReviewState & { drop?: boolean }) | null>(null);

  useEffect(() => {
    let live = true;
    api.loadRoles(conn.id).then(
      (rs) => {
        if (!live) return;
        setRoles(rs);
        setLoadError(null);
        setSelected((s) => (s === NEW || rs.some((r) => r.name === s) ? s : (rs[0]?.name ?? "")));
      },
      (e) => {
        if (!live) return;
        markLost(conn.id, e);
        setLoadError(errorText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [conn.id, reload, markLost]);

  const isNew = selected === NEW;
  const role = isNew ? undefined : roles?.find((r) => r.name === selected);
  const pk = privKey(selected, schema);
  const entry = role ? privs[pk] : undefined;
  const loaded = entry && "draft" in entry ? entry : undefined;
  const hasEntry = !!entry;
  const roleName = role?.name;

  useEffect(() => {
    if (!roleName || hasEntry) return;
    let live = true;
    api.loadPrivileges(sid, roleName, schema).then(
      (rows) => live && setPrivs((p) => ({ ...p, [privKey(roleName, schema)]: { original: rows, draft: rows } })),
      (e) => {
        if (!live) return;
        markLost(conn.id, e);
        setPrivs((p) => ({ ...p, [privKey(roleName, schema)]: { error: errorText(e) } }));
      },
    );
    return () => {
      live = false;
    };
  }, [sid, roleName, schema, hasEntry, markLost]);

  const changed = (k: string, d: RoleDraft) => {
    const r = roles?.find((x) => x.name === k);
    return k === NEW || (!!r && roleSql(k, draftOf(r, []), { ...d, privs: [] }).length > 0);
  };
  useTabDirty(
    tab.id,
    Object.entries(drafts).some(([k, d]) => changed(k, d)) ||
      Object.values(privs).some((e) => "draft" in e && diffPrivileges(e.original, e.draft).grants.length + diffPrivileges(e.original, e.draft).revokes.length > 0) ||
      Object.values(passwords).some(Boolean),
  );

  if (loadError || !roles)
    return (
      <div className="grid flex-1 place-items-center p-6 text-center">
        {loadError ? (
          <div role="alert" className="max-w-md">
            <p className="m-0 font-medium">{t("roles.loadFailed")}</p>
            <p className="mt-1 mb-0 text-xs whitespace-pre-wrap text-muted">{loadError}</p>
            <Button className="mt-3" onClick={() => (setLoadError(null), setReload((n) => n + 1))}>
              {t("roles.retry")}
            </Button>
          </div>
        ) : (
          <p className="m-0 text-muted">{t("roles.loading")}</p>
        )}
      </div>
    );

  const base = draftOf(role ?? NEW_ROLE, loaded?.original ?? []);
  const draft: RoleDraft = { ...(drafts[selected] ?? base), privs: loaded?.draft ?? [] };
  const password = passwords[selected];
  const name = isNew ? newName.trim() : selected;
  const update = (patch: Partial<RoleDraft>) => {
    const { privs: p, ...rest } = patch;
    if (Object.keys(rest).length) setDrafts((d) => ({ ...d, [selected]: { ...draft, ...rest } }));
    if (p && loaded) setPrivs((x) => ({ ...x, [pk]: { ...loaded, draft: p } }));
  };
  const setPassword = (v: string | undefined) => setPasswords((p) => ({ ...p, [selected]: v }));
  const sql = [...(isNew ? [`CREATE ROLE ${name};`] : []), ...roleSql(name, base, draft, schema)];
  const count = sql.length + (password ? 1 : 0);

  const startNew = () => {
    setDrafts((d) => (d[NEW] ? d : { ...d, [NEW]: draftOf(NEW_ROLE, []) }));
    setSelected(NEW);
  };
  const discard = () => {
    setDrafts(({ [selected]: _, ...rest }) => rest);
    setPassword(undefined);
    if (loaded) setPrivs((x) => ({ ...x, [pk]: { ...loaded, draft: loaded.original } }));
    if (isNew) {
      setNewName("");
      setSelected(roles[0]?.name ?? "");
    }
  };

  const openReview = async (drop: boolean) => {
    setReview({ busy: true, drop });
    try {
      const args = rolePreviewArgs(role ?? null, drop ? null : draft, name, password, schema, loaded?.original ?? []);
      setReview({ preview: await api.previewRole(sid, ...args), drop });
    } catch (e) {
      markLost(conn.id, e);
      setReview({ error: previewErrorText(t, e), drop });
    }
  };
  const apply = async () => {
    if (!review?.preview) return;
    const { preview, drop } = review;
    const key = selected;
    setReview({ preview, drop, busy: true });
    try {
      const report = await api.applyPreview(sid, preview.id, true);
      if (report.failed) {
        setReview({ preview, drop, report });
        return;
      }
      setReview(null);
      toast(t(drop ? "roles.deleted" : "roles.applied", { name }));
      // Forget this role's edits and cached matrices so everything reloads from the server.
      setDrafts(({ [key]: _, ...rest }) => rest);
      setPasswords(({ [key]: _, ...rest }) => rest);
      setPrivs((p) => Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith(privKey(key, "")) && !k.startsWith(privKey(name, "")))));
      if (isNew) setNewName("");
      setSelected(drop ? "" : name);
      setReload((n) => n + 1);
    } catch (e) {
      markLost(conn.id, e);
      setReview({ preview, drop, error: previewErrorText(t, e) });
    }
  };

  const visible = roles.filter((r) => r.name.toLowerCase().includes(query.trim().toLowerCase()));
  const candidates = roles.filter((r) => r.name !== name && !draft.memberOf.includes(r.name));
  const schemas = [...new Set([schema, ...treeNames])];
  const [inhPre, inhPost] = t("roles.inherited", { roles: "{roles}" }).split("{roles}");

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label={t("roles.title")} className="flex w-[250px] shrink-0 flex-col border-r border-border bg-panel">
        <div className="flex items-center justify-between pt-3.5 pr-2.5 pb-2 pl-3.5">
          <span className="flex min-w-0 flex-col">
            <span className="font-semibold">{t("roles.title")}</span>
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <EnvDot env={conn.env} />
              <span className="truncate">{conn.name}</span>
            </span>
          </span>
          <IconButton label={t("roles.new")} size={28} onClick={startNew} className="border! border-border-strong! bg-surface!">
            <Plus size={13} />
          </IconButton>
        </div>
        <div className="px-3 pb-2.5">
          <label className="flex h-[30px] items-center gap-2 rounded-[7px] border border-border bg-surface px-2.5 text-faint">
            <Search size={13} aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t("roles.filterLabel")}
              placeholder={t("roles.filter")}
              className="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-faint"
            />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-1.5">
          {drafts[NEW] && (
            <button
              type="button"
              aria-current={isNew}
              onClick={() => setSelected(NEW)}
              className={cn("flex h-[34px] w-full items-center gap-2 rounded-md px-2.5 text-left", isNew ? "bg-accent-bg" : "hover:bg-raised")}
            >
              <span className="flex-1 truncate font-mono text-[12.5px] italic">{newName.trim() || t("roles.new")}</span>
              <span className="text-[11px] text-accent">{t("roles.tag.new")}</span>
            </button>
          )}
          {visible.length === 0 && <div className="px-2.5 py-2 text-xs text-faint">{t("common.noResults")}</div>}
          {visible.map((r) => (
            <button
              key={r.name}
              type="button"
              aria-current={r.name === selected}
              onClick={() => setSelected(r.name)}
              className={cn("flex h-[34px] w-full items-center gap-2 rounded-md px-2.5 text-left", r.name === selected ? "bg-accent-bg" : "hover:bg-raised")}
            >
              <span className="flex-1 truncate font-mono text-[12.5px]" title={r.name}>
                {r.name}
              </span>
              <span className={cn("text-[11px]", r.tag === "superuser" ? "text-stg" : "text-faint")}>{t(`roles.tag.${r.tag}`)}</span>
            </button>
          ))}
        </div>
      </aside>

      {!role && !isNew ? (
        <main className="grid min-w-0 flex-1 place-items-center text-muted">{t("roles.empty")}</main>
      ) : (
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-6 py-5">
            <div className="flex flex-wrap items-center gap-3">
              {isNew ? (
                <input
                  value={newName}
                  autoFocus
                  onChange={(e) => setNewName(e.target.value)}
                  aria-label={t("roles.newName")}
                  placeholder={t(isMy ? "roles.newNameMysql" : "roles.newName")}
                  className="h-9 min-w-[240px] rounded-[7px] border border-border-strong bg-surface px-2.5 font-mono text-lg outline-none placeholder:text-faint focus:border-accent"
                />
              ) : (
                <h1 className="m-0 truncate font-mono text-xl font-medium" title={selected}>
                  {selected}
                </h1>
              )}
              <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-muted">
                {role ? t(`roles.kind.${role.tag}`) : t("roles.new")}
              </span>
              <span className="flex-1" />
              {role && (
                <button type="button" onClick={() => void openReview(true)} className="h-[30px] rounded-[7px] border border-border-strong px-3 text-prod hover:bg-prod-bg">
                  {t("roles.delete")}
                </button>
              )}
            </div>

            <section aria-label={t("roles.attributes")} className="flex flex-col gap-2">
              <div className="grid grid-cols-3 gap-2">
                {ROLE_ATTRS.map((a) =>
                  isMy && MYSQL_NA.includes(a) ? (
                    <div key={a} className={cn(CELL, "text-faint")} title={t("roles.mysqlNa")}>
                      <span>{t(`roles.attr.${a}`)}</span>
                      <span className="text-xs">{t("roles.na")}</span>
                    </div>
                  ) : (
                    <div key={a} className={CELL}>
                      <span>{t(`roles.attr.${a}`)}</span>
                      <Switch checked={draft.attrs[a]} onChange={(v) => update({ attrs: { ...draft.attrs, [a]: v } })} label={t(`roles.attr.${a}`)} />
                    </div>
                  ),
                )}
                <label className={CELL}>
                  <span>{t("roles.connLimit")}</span>
                  <input
                    value={draft.connLimit}
                    inputMode="numeric"
                    placeholder={t("roles.noLimit")}
                    onChange={(e) => update({ connLimit: e.target.value.replace(/\D/g, "") })}
                    className={cn(SMALL_INPUT, "w-14 text-right")}
                  />
                </label>
                <label className={CELL}>
                  <span>{t("roles.validUntil")}</span>
                  <input
                    value={draft.validUntil}
                    placeholder={t("roles.never")}
                    onChange={(e) => update({ validUntil: e.target.value })}
                    className={cn(SMALL_INPUT, "w-[110px]")}
                  />
                </label>
                <div className={CELL}>
                  <span>{t("roles.password")}</span>
                  {password === undefined ? (
                    <button type="button" onClick={() => setPassword("")} className="h-[26px] rounded-md border border-border-strong bg-bg px-2.5 text-xs hover:bg-raised">
                      {t("roles.passwordChange")}
                    </button>
                  ) : (
                    <span className="flex min-w-0 items-center gap-1">
                      <input
                        type="password"
                        autoComplete="new-password"
                        autoFocus
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        aria-label={t("roles.newPassword")}
                        placeholder={t("roles.newPassword")}
                        className={cn(SMALL_INPUT, "w-[120px] min-w-0")}
                      />
                      <IconButton label={t("roles.passwordKeep")} size={24} onClick={() => setPassword(undefined)}>
                        <X size={11} />
                      </IconButton>
                    </span>
                  )}
                </div>
              </div>
              {isMy && <p className="m-0 text-xs text-faint">{t("roles.mysqlNa")}</p>}
            </section>

            <section aria-label={t("roles.memberOf")} className="flex flex-wrap items-center gap-2">
              <span className="mr-1 text-xs text-muted">{t("roles.memberOf")}</span>
              {draft.memberOf.map((g) => (
                <span key={g} className="inline-flex h-[26px] items-center gap-1 rounded-full border border-border-strong bg-surface pr-1 pl-2.5 font-mono text-xs">
                  {g}
                  <button
                    type="button"
                    aria-label={t("roles.removeMember", { role: g })}
                    title={t("roles.removeMember", { role: g })}
                    onClick={() => update({ memberOf: draft.memberOf.filter((m) => m !== g) })}
                    className="grid size-5 place-items-center rounded-full text-muted hover:bg-raised hover:text-text"
                  >
                    <X size={10} strokeWidth={2.2} />
                  </button>
                </span>
              ))}
              <Menu
                items={candidates.map((r) => ({
                  key: r.name,
                  label: <span className="font-mono text-xs">{r.name}</span>,
                  onSelect: () => update({ memberOf: [...draft.memberOf, r.name] }),
                }))}
                trigger={(p) => (
                  <button
                    type="button"
                    {...p}
                    disabled={candidates.length === 0}
                    className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-dashed border-border-strong px-2.5 text-xs text-muted hover:text-text disabled:opacity-50"
                  >
                    <Plus size={11} aria-hidden="true" />
                    {t("roles.addToRole")}
                  </button>
                )}
              />
            </section>

            <section aria-label={t("roles.privileges")}>
              <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
                <h2 className="m-0 text-sm font-semibold">{t("roles.privileges")}</h2>
                {!isMy && database && <span className="text-muted">{database} /</span>}
                <Select compact mono aria-label={t("roles.scope")} value={schema} onChange={(e) => setSchema(e.target.value)} className="w-[180px]">
                  {schemas.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </Select>
                <span className="flex-1" />
                <span className="flex gap-3.5 text-xs text-muted">
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden="true" className="size-2.5 rounded-[3px] shadow-[0_0_0_2px_var(--accent)]" />
                    {t("roles.legendGrant")}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden="true" className="size-2.5 rounded-[3px] shadow-[0_0_0_2px_var(--prod)]" />
                    {t("roles.legendRevoke")}
                  </span>
                  <span>{t("roles.legendNa")}</span>
                </span>
              </div>
              {isNew ? (
                <p className="m-0 rounded-lg border border-dashed border-border-strong px-3 py-2.5 text-xs text-muted">{t("roles.newPrivs")}</p>
              ) : entry && "error" in entry ? (
                <div role="alert" className="rounded-lg bg-prod-bg px-3 py-2.5 text-prod">
                  <p className="m-0 font-medium">{t("roles.privsFailed")}</p>
                  <p className="mt-1 mb-0 text-xs whitespace-pre-wrap">{entry.error}</p>
                  <Button size="sm" className="mt-2" onClick={() => setPrivs(({ [pk]: _, ...rest }) => rest)}>
                    {t("roles.retry")}
                  </Button>
                </div>
              ) : !loaded ? (
                <p className="m-0 text-xs text-muted">{t("roles.privsLoading")}</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <div role="table" aria-label={t("roles.privileges")} className="min-w-[900px]">
                    <div role="row" className={cn(GRID, "h-[34px] border-b border-border-strong bg-panel text-center font-mono text-[10.5px] text-muted")}>
                      <span role="columnheader" className="px-3 text-left font-sans text-xs">
                        {t("roles.object")}
                      </span>
                      {PRIVILEGES.map((p) => (
                        <span key={p} role="columnheader">
                          {p === "REFERENCES" ? "REFS" : p}
                        </span>
                      ))}
                    </div>
                    {draft.privs.length === 0 && <div className="px-3 py-2.5 text-xs text-faint">{t("roles.noObjects")}</div>}
                    {draft.privs.map((row, r) => (
                      <div key={`${row.kind}:${row.name}`} role="row" className={cn(GRID, "h-9 border-b border-border last:border-b-0")}>
                        <span role="rowheader" className="flex min-w-0 items-center gap-2 px-3">
                          <span className={cn("w-[18px] shrink-0 font-mono text-[10px]", KIND[row.kind][1])}>{KIND[row.kind][0]}</span>
                          <span className="truncate font-mono text-[12.5px]" title={row.name}>
                            {row.name}
                          </span>
                        </span>
                        {row.cells.map((c, i) => {
                          const was = base.privs[r]?.cells[i];
                          return (
                            <span key={i} role="cell" className="grid place-items-center">
                              {c === "na" ? (
                                <span aria-hidden="true" className="text-border-strong">
                                  —
                                </span>
                              ) : (
                                <Checkbox
                                  state={c === "on" ? "on" : "off"}
                                  mark={c === was ? undefined : c === "on" ? "grant" : "revoke"}
                                  label={t("roles.cell", { priv: PRIVILEGES[i], object: row.name })}
                                  onChange={() => update({ privs: toggle(draft.privs, row.name, i) })}
                                />
                              )}
                            </span>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="mt-2 mb-0 text-xs text-faint">
                {t("roles.direct")}{" "}
                {draft.memberOf.length > 0 && (
                  <>
                    {inhPre}
                    <span className="font-mono">{draft.memberOf.join(", ")}</span>
                    {inhPost}
                  </>
                )}
              </p>
            </section>
          </div>

          {count > 0 && (
            <div className="flex min-h-[60px] shrink-0 flex-wrap items-center gap-3 border-t border-border bg-panel px-6 py-2.5">
              <span className="font-medium">{count === 1 ? t("roles.oneChange") : t("roles.changes", { n: count })}</span>
              <code className="min-w-[280px] flex-1 truncate font-mono text-[11.5px] text-muted" title={sql.join("\n")}>
                {kw(sql.join(" "))}
              </code>
              <Button variant="ghost" size="lg" onClick={discard}>
                {t("common.discard")}
              </Button>
              <Button variant={conn.env === "prod" ? "danger" : "primary"} size="lg" disabled={!name} onClick={() => void openReview(false)}>
                {t("roles.review")}
              </Button>
            </div>
          )}
        </main>
      )}

      <ReviewDialog
        id={`${tab.id}-review`}
        title={t(review?.drop ? "roles.reviewDelete" : "roles.reviewTitle", { name: name || t("roles.new") })}
        state={review}
        prod={conn.env === "prod"}
        onApply={() => void apply()}
        onClose={() => setReview(null)}
      />
    </div>
  );
}
