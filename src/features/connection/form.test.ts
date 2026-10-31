import { expect, test } from "vitest";
import { mockConnections } from "../../mock/connections";
import { applyDriverChange, defaultPort, duplicateOf, emptyForm, fromConnection, secretsOf, toConnection, validate } from "./form";

const valid = { ...emptyForm, name: "orders-prod", host: "10.0.12.4" };

test("defaultPort per driver", () => {
  expect(defaultPort("postgres")).toBe("5432");
  expect(defaultPort("mysql")).toBe("3306");
  expect(defaultPort("mariadb")).toBe("3306");
  expect(defaultPort("sqlite")).toBe("");
});

test("switching driver updates the port unless the user edited it", () => {
  expect(applyDriverChange(emptyForm, "mysql").port).toBe("3306");
  const edited = { ...emptyForm, port: "6543", portTouched: true };
  expect(applyDriverChange(edited, "mysql").port).toBe("6543");
  expect(applyDriverChange(edited, "mysql").driver).toBe("mysql");
});

test("validate: required fields per driver", () => {
  expect(validate(valid)).toEqual({});
  expect(validate({ ...valid, name: "  " })).toEqual({ name: "conn.err.name" });
  expect(validate({ ...valid, host: "" })).toEqual({ host: "conn.err.host" });
  // SQLite needs a file, not a host/port.
  const sqlite = applyDriverChange({ ...valid, host: "" }, "sqlite");
  expect(validate(sqlite)).toEqual({ file: "conn.err.file" });
  expect(validate({ ...sqlite, file: "~/notes.db" })).toEqual({});
});

test("validate: port must be an integer 1–65535", () => {
  for (const port of ["0", "65536", "54.3", "abc", ""]) expect(validate({ ...valid, port }).port).toBe("conn.err.port");
  expect(validate({ ...valid, port: "65535" })).toEqual({});
});

test("toConnection builds a disconnected entry without a server version", () => {
  const c = toConnection({ ...valid, ssh: true, sshHost: "bastion", sshUser: "deploy" }, "");
  expect(c).toMatchObject({ id: "", port: 5432, connected: false, timeoutSecs: 10 });
  expect(c.serverVersion).toBeUndefined();
  expect(c.ssh).toMatchObject({ host: "bastion", auth: "key", port: 22 });
  expect(toConnection({ ...valid, driver: "sqlite", file: "a.db" }, "x").host).toBeUndefined();
});

test("edit prefill round-trips back to the same connection", () => {
  const conn = mockConnections[0]; // has ssh + key
  const f = fromConnection(conn);
  expect(f).toMatchObject({ name: "orders-prod", host: "10.0.12.4", port: "5432", ssh: true, sshHost: "bastion-01.example.net", password: "" });
  const { connected: _c, serverVersion: _v, ...rest } = conn;
  expect(toConnection(f, conn.id)).toEqual({ ...rest, connected: false, timeoutSecs: 10 });
  const sqlite = mockConnections.find((c) => c.driver === "sqlite")!;
  expect(toConnection(fromConnection(sqlite), sqlite.id).file).toBe(sqlite.file);
});

test("blank password means unchanged (undefined); typed value is sent", () => {
  expect(secretsOf({ ...valid, password: "" })).toEqual({ password: undefined, sshPassword: undefined, sshPassphrase: undefined });
  expect(secretsOf({ ...valid, password: "pw" }).password).toBe("pw");
  expect(secretsOf({ ...valid, ssh: true, sshAuth: "key", passphrase: "pp" }).sshPassphrase).toBe("pp");
  // Hidden fields never leak: SSH off → no SSH secrets; SQLite → no password.
  expect(secretsOf({ ...valid, ssh: false, passphrase: "pp" }).sshPassphrase).toBeUndefined();
  expect(secretsOf({ ...valid, driver: "sqlite", password: "pw" }).password).toBeUndefined();
});

test("SSH secrets follow the auth mode; blank (edit) = unchanged", () => {
  const ssh = { ...valid, ssh: true, sshPassword: "spw", passphrase: "pp" };
  expect(secretsOf({ ...ssh, sshAuth: "password" })).toEqual({ password: undefined, sshPassword: "spw", sshPassphrase: undefined });
  expect(secretsOf({ ...ssh, sshAuth: "key" })).toEqual({ password: undefined, sshPassword: undefined, sshPassphrase: "pp" });
  expect(secretsOf({ ...ssh, sshAuth: "agent" })).toEqual({ password: undefined, sshPassword: undefined, sshPassphrase: undefined });
  expect(secretsOf({ ...ssh, sshAuth: "password", sshPassword: "" }).sshPassword).toBeUndefined();
  // Edit prefill never carries secrets, so saving untouched sends nothing.
  expect(secretsOf(fromConnection(mockConnections[0]))).toEqual({ password: undefined, sshPassword: undefined, sshPassphrase: undefined });
  expect(secretsOf({ ...ssh, sshAuth: "password", driver: "sqlite" }).sshPassword).toBeUndefined();
});

test("TLS file paths map both ways and are dropped for SQLite", () => {
  const f = { ...valid, sslMode: "verify-full" as const, sslCaPath: " ~/ca.pem ", sslCertPath: "/c.crt", sslKeyPath: "" };
  const c = toConnection(f, "x");
  expect(c).toMatchObject({ sslCaPath: "~/ca.pem", sslCertPath: "/c.crt", sslMode: "verify-full" });
  expect(c.sslKeyPath).toBeUndefined();
  expect(fromConnection(c)).toMatchObject({ sslCaPath: "~/ca.pem", sslCertPath: "/c.crt", sslKeyPath: "" });
  expect(toConnection({ ...f, driver: "sqlite", file: "a.db" }, "x").sslCaPath).toBeUndefined();
});

test("duplicateOf names the copy and drops id and runtime state", () => {
  const d = duplicateOf(mockConnections[0]);
  expect(d).toMatchObject({ id: "", name: "orders-prod (copy)", connected: false, host: "10.0.12.4" });
  expect(d.serverVersion).toBeUndefined();
});
