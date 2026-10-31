import { expect, test } from "vitest";
import { analystPrivileges } from "../../mock/objects";
import type { PrivState, PrivilegeRow } from "../../types";
import { diffPrivileges, draftOf, rolePreviewArgs, roleSql, type RoleDraft } from "./diff";

const set = (rows: PrivilegeRow[], name: string, i: number, v: PrivState) =>
  rows.map((r) => (r.name === name ? { ...r, cells: r.cells.map((c, j) => (j === i ? v : c)) } : r));

test("toggle on → grant, toggle off → revoke", () => {
  const cur = set(set(analystPrivileges, "payments", 0, "on"), "orders", 2, "off");
  expect(diffPrivileges(analystPrivileges, cur)).toEqual({
    grants: [{ object: "payments", kind: "table", privilege: "SELECT" }],
    revokes: [{ object: "orders", kind: "table", privilege: "UPDATE" }],
  });
});

test("back to original → empty", () => {
  const cur = set(set(analystPrivileges, "payments", 0, "on"), "payments", 0, "off");
  expect(diffPrivileges(analystPrivileges, cur)).toEqual({ grants: [], revokes: [] });
});

test("na cells are ignored", () => {
  const cur = set(analystPrivileges, "public", 0, "on"); // SELECT on a schema is n/a
  expect(diffPrivileges(analystPrivileges, cur)).toEqual({ grants: [], revokes: [] });
});

test("roleSql builds one GRANT and one REVOKE", () => {
  const base: RoleDraft = { attrs: { login: true, superuser: false, createdb: false, createrole: false, inherit: true, replication: false }, connLimit: "10", validUntil: "", memberOf: ["reporting"], privs: analystPrivileges };
  const cur = { ...base, privs: set(set(analystPrivileges, "payments", 0, "on"), "orders", 2, "off") };
  expect(roleSql("analyst", base, cur)).toEqual([
    "GRANT SELECT ON public.payments TO analyst;",
    "REVOKE UPDATE ON public.orders FROM analyst;",
  ]);
  expect(roleSql("analyst", base, { ...base, memberOf: [], attrs: { ...base.attrs, login: false } })).toEqual([
    "ALTER ROLE analyst NOLOGIN;",
    "REVOKE reporting FROM analyst;",
  ]);
});

const analyst = { name: "analyst", tag: "login" as const, attrs: { login: true, superuser: false, createdb: false, createrole: false, inherit: true, replication: false }, connLimit: -1, validUntil: "", memberOf: ["reporting"] };

test("rolePreviewArgs: unchanged role round-trips, schema and privileges passed, no password", () => {
  const cur = set(analystPrivileges, "payments", 0, "on");
  const args = rolePreviewArgs(analyst, { ...draftOf(analyst, analystPrivileges), privs: cur }, "analyst", undefined, "sales", analystPrivileges);
  expect(args).toEqual([analyst, analyst, null, "sales", analystPrivileges, cur]);
  expect(draftOf(analyst, []).connLimit).toBe(""); // -1 = no limit
});

test("rolePreviewArgs: password only when typed; edits become the target", () => {
  const d = { ...draftOf(analyst, []), connLimit: "5", validUntil: "2027-01-01" };
  const [, target, password] = rolePreviewArgs(analyst, d, "analyst", "s3cret", "public", []);
  expect(password).toBe("s3cret");
  expect(target).toMatchObject({ connLimit: 5, validUntil: "2027-01-01" });
  expect(rolePreviewArgs(analyst, d, "analyst", "", "public", [])[2]).toBeNull();
});

test("rolePreviewArgs: create and drop", () => {
  const fresh = { ...analyst, name: "", connLimit: undefined, memberOf: [] };
  const [orig, target] = rolePreviewArgs(null, draftOf(fresh, []), "etl", "pw", "public", []);
  expect(orig).toBeNull();
  expect(target).toEqual({ name: "etl", tag: "login", attrs: analyst.attrs, connLimit: undefined, validUntil: undefined, memberOf: [] });
  expect(rolePreviewArgs(analyst, null, "analyst", "pw", "public", analystPrivileges)).toEqual([analyst, null, null, "public", [], []]);
});
