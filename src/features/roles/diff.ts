import { PRIVILEGES, ROLE_ATTRS, type Privilege, type PrivilegeRow, type Role } from "../../types";

export interface PrivChange {
  object: string;
  kind: PrivilegeRow["kind"];
  privilege: Privilege;
}

/** Compares saved vs edited matrix rows (same order); "na" cells never count. */
export function diffPrivileges(original: PrivilegeRow[], current: PrivilegeRow[]) {
  const grants: PrivChange[] = [];
  const revokes: PrivChange[] = [];
  current.forEach((row, r) =>
    row.cells.forEach((cell, i) => {
      const was = original[r]?.cells[i];
      if (cell === was || cell === "na" || was === "na" || was === undefined) return;
      (cell === "on" ? grants : revokes).push({ object: row.name, kind: row.kind, privilege: PRIVILEGES[i] });
    }),
  );
  return { grants, revokes };
}

/** Editable role state shown in the Roles tab. */
export interface RoleDraft {
  attrs: Role["attrs"];
  connLimit: string;
  validUntil: string;
  memberOf: string[];
  privs: PrivilegeRow[];
}

const target = (c: PrivChange, schema: string) =>
  c.kind === "schema"
    ? `SCHEMA ${c.object}`
    : `${c.kind === "sequence" ? "SEQUENCE " : c.kind === "function" ? "FUNCTION " : ""}${schema}.${c.object}`;

// Action-bar summary only (PG-style wording); the SQL that runs comes from previewRole in Rust.
export function roleSql(role: string, from: RoleDraft, to: RoleDraft, schema = "public"): string[] {
  const out: string[] = [];
  for (const a of ROLE_ATTRS)
    if (from.attrs[a] !== to.attrs[a]) out.push(`ALTER ROLE ${role} ${to.attrs[a] ? "" : "NO"}${a.toUpperCase()};`);
  if (from.connLimit !== to.connLimit) out.push(`ALTER ROLE ${role} CONNECTION LIMIT ${to.connLimit || -1};`);
  if (from.validUntil !== to.validUntil) out.push(`ALTER ROLE ${role} VALID UNTIL '${to.validUntil || "infinity"}';`);
  for (const g of to.memberOf) if (!from.memberOf.includes(g)) out.push(`GRANT ${g} TO ${role};`);
  for (const g of from.memberOf) if (!to.memberOf.includes(g)) out.push(`REVOKE ${g} FROM ${role};`);
  const { grants, revokes } = diffPrivileges(from.privs, to.privs);
  for (const c of grants) out.push(`GRANT ${c.privilege} ON ${target(c, schema)} TO ${role};`);
  for (const c of revokes) out.push(`REVOKE ${c.privilege} ON ${target(c, schema)} FROM ${role};`);
  return out;
}

/** Form state for a loaded role; `privs` are the rows of the schema being shown. Negative limits (PG -1) show as none. */
export function draftOf(r: Role, privs: PrivilegeRow[]): RoleDraft {
  const limit = r.connLimit !== undefined && r.connLimit >= 0 ? String(r.connLimit) : "";
  return { attrs: r.attrs, connLimit: limit, validUntil: r.validUntil ?? "", memberOf: r.memberOf, privs };
}

/**
 * Arguments after `id` for `api.previewRole`. original null = create, draft null = drop (no
 * privilege rows). Untouched limit/expiry keep the loaded values; the password goes only when typed.
 */
export function rolePreviewArgs(
  original: Role | null,
  draft: RoleDraft | null,
  name: string,
  password: string | undefined,
  schema: string,
  privsOriginal: PrivilegeRow[],
): [Role | null, Role | null, string | null, string, PrivilegeRow[], PrivilegeRow[]] {
  const was = original && draftOf(original, []);
  const target: Role | null = draft && {
    name,
    tag: original?.tag ?? (draft.attrs.login ? "login" : "group"),
    attrs: draft.attrs,
    connLimit: draft.connLimit === was?.connLimit ? original?.connLimit : draft.connLimit === "" ? undefined : Number(draft.connLimit),
    validUntil: draft.validUntil === was?.validUntil ? original?.validUntil : draft.validUntil || undefined,
    memberOf: draft.memberOf,
  };
  return [original, target, draft && password ? password : null, schema, draft ? privsOriginal : [], draft ? draft.privs : []];
}
