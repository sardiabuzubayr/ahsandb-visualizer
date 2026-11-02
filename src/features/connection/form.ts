import { DB_META } from "../../components/ui";
import type { AiAccess, Connection, Driver, Env, Secrets, SshAuth, SslMode } from "../../types";

export interface ConnForm {
  driver: Driver;
  name: string;
  host: string;
  /** Kept as typed text; validated on save. */
  port: string;
  /** True once the user edits the port, so driver changes stop overwriting it. */
  portTouched: boolean;
  database: string;
  user: string;
  password: string;
  file: string;
  env: Env;
  readOnly: boolean;
  ssh: boolean;
  sshHost: string;
  sshPort: string;
  /** Seconds between SSH keep-alives; "" = default (15). */
  sshKeepalive: string;
  sshUser: string;
  sshAuth: SshAuth;
  sshPassword: string;
  keyPath: string;
  passphrase: string;
  sslMode: SslMode;
  sslCaPath: string;
  sslCertPath: string;
  sslKeyPath: string;
  folder: string;
  timeout: string;
  aiAccess: AiAccess;
}

export type FormField = "name" | "host" | "port" | "file" | "database";
/** Values are i18n keys. */
export type FormErrors = Partial<Record<FormField, string>>;

export const defaultPort = (driver: Driver): string => String(DB_META[driver].port ?? "");

export const emptyForm: ConnForm = {
  driver: "postgres",
  name: "",
  host: "",
  port: defaultPort("postgres"),
  portTouched: false,
  database: "",
  user: "",
  password: "",
  file: "",
  env: "dev",
  readOnly: false,
  ssh: false,
  sshHost: "",
  sshPort: "22",
  sshKeepalive: "",
  sshUser: "",
  sshAuth: "key",
  sshPassword: "",
  keyPath: "~/.ssh/id_ed25519",
  passphrase: "",
  sslMode: "prefer",
  sslCaPath: "",
  sslCertPath: "",
  sslKeyPath: "",
  folder: "Local",
  timeout: "10",
  aiAccess: "schema",
};

export function applyDriverChange(form: ConnForm, driver: Driver): ConnForm {
  // Redis can't negotiate TLS, so "prefer" has no meaning there.
  const sslMode = driver === "redis" && form.sslMode === "prefer" ? "disable" : form.sslMode;
  return { ...form, driver, sslMode, port: form.portTouched ? form.port : defaultPort(driver) };
}

export function validate(f: ConnForm): FormErrors {
  const e: FormErrors = {};
  if (!f.name.trim()) e.name = "conn.err.name";
  if (f.driver === "sqlite") {
    if (!f.file.trim()) e.file = "conn.err.file";
    return e;
  }
  if (!f.host.trim()) e.host = "conn.err.host";
  const port = Number(f.port);
  if (!/^\d+$/.test(f.port.trim()) || port < 1 || port > 65535) e.port = "conn.err.port";
  if (f.driver === "redis" && !/^\d*$/.test(f.database.trim())) e.database = "conn.err.redisDb";
  return e;
}

/** Connection to save/test; `id` is "" for a new connection (the backend assigns one). */
export function toConnection(f: ConnForm, id: string): Connection {
  const server = f.driver !== "sqlite";
  return {
    id,
    name: f.name.trim(),
    folder: f.folder.trim() || "Local",
    driver: f.driver,
    env: f.env,
    host: server ? f.host.trim() : undefined,
    port: server ? Number(f.port) : undefined,
    database: server ? f.database.trim() || undefined : undefined,
    user: server ? f.user.trim() || undefined : undefined,
    file: server ? undefined : f.file.trim(),
    readOnly: f.readOnly,
    connected: false,
    ssh:
      server && f.ssh
        ? {
            host: f.sshHost.trim(),
            port: Number(f.sshPort) || 22,
            user: f.sshUser.trim(),
            auth: f.sshAuth,
            keyPath: f.sshAuth === "key" ? f.keyPath.trim() : undefined,
            keepaliveSecs: f.sshKeepalive.trim() === "" ? undefined : Math.max(0, Math.min(600, Math.round(Number(f.sshKeepalive) || 0))),
          }
        : undefined,
    sslMode: f.sslMode,
    aiAccess: f.aiAccess,
    timeoutSecs: Number(f.timeout) || undefined,
    sslCaPath: (server && f.sslCaPath.trim()) || undefined,
    sslCertPath: (server && f.sslCertPath.trim()) || undefined,
    sslKeyPath: (server && f.sslKeyPath.trim()) || undefined,
  };
}

/** Form prefilled from a saved connection; secret fields stay empty ("unchanged"). */
export function fromConnection(c: Connection): ConnForm {
  return {
    ...emptyForm,
    driver: c.driver,
    name: c.name,
    host: c.host ?? "",
    port: c.port !== undefined ? String(c.port) : defaultPort(c.driver),
    portTouched: true,
    database: c.database ?? "",
    user: c.user ?? "",
    file: c.file ?? "",
    env: c.env,
    readOnly: c.readOnly,
    ssh: !!c.ssh,
    sshHost: c.ssh?.host ?? "",
    sshPort: String(c.ssh?.port ?? 22),
    sshKeepalive: c.ssh?.keepaliveSecs === undefined ? "" : String(c.ssh.keepaliveSecs),
    sshUser: c.ssh?.user ?? "",
    sshAuth: c.ssh?.auth ?? emptyForm.sshAuth,
    keyPath: c.ssh?.keyPath ?? emptyForm.keyPath,
    sslMode: c.sslMode,
    sslCaPath: c.sslCaPath ?? "",
    sslCertPath: c.sslCertPath ?? "",
    sslKeyPath: c.sslKeyPath ?? "",
    folder: c.folder,
    timeout: String(c.timeoutSecs ?? 10),
    aiAccess: c.aiAccess,
  };
}

/** Blank secret fields are sent as undefined = keep the stored value (or none for a new connection). */
export function secretsOf(f: ConnForm): Secrets {
  const server = f.driver !== "sqlite";
  const ssh = server && f.ssh;
  return {
    password: (server && f.password) || undefined,
    sshPassword: (ssh && f.sshAuth === "password" && f.sshPassword) || undefined,
    sshPassphrase: (ssh && f.sshAuth === "key" && f.passphrase) || undefined,
  };
}

/** Copy saved as a new connection (no secrets are copied). */
export function duplicateOf(c: Connection): Connection {
  return { ...c, id: "", name: `${c.name} (copy)`, connected: false, serverVersion: undefined };
}
