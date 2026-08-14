import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** One canonical location for the daemon-owned state, secrets and Bridge token files. */
export function engineDaemonStateRoot(engineStorageRoot: string): string {
  return path.join(path.resolve(engineStorageRoot), "state");
}

export class DaemonStateStore {
  readonly root: string;
  private readonly statePath: string;
  private readonly secretsPath: string;
  private state: Record<string, unknown>;
  private secrets: Record<string, string>;

  constructor(root: string) {
    this.root = path.resolve(root);
    ensurePrivateDirectory(this.root);
    this.statePath = path.join(this.root, "state.json");
    this.secretsPath = path.join(this.root, "secrets.json");
    this.state = readObject(this.statePath, false) as Record<string, unknown>;
    this.secrets = readObject(this.secretsPath, true) as Record<string, string>;
  }

  getState<T>(key: string): T | undefined {
    validateKey(key);
    const value = this.state[key];
    return value === undefined ? undefined : cloneJson(value) as T;
  }

  setState(key: string, value: unknown): void {
    validateKey(key);
    const next = nullRecord<unknown>(this.state);
    if (value === undefined) delete next[key];
    else next[key] = cloneJson(value);
    writeObject(this.statePath, next);
    this.state = next;
  }

  getSecret(key: string): string | undefined {
    validateKey(key);
    return this.secrets[key];
  }

  setSecret(key: string, value: string): void {
    validateKey(key);
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
      throw new Error("daemon secret must be a bounded string");
    }
    const next = nullRecord<string>(this.secrets);
    next[key] = value;
    writeObject(this.secretsPath, next);
    this.secrets = next;
  }
}

function ensurePrivateDirectory(root: string): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`daemon state root is unsafe: ${root}`);
  if (process.platform === "win32") return;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new Error(`daemon state root is unsafe: ${root}`);
  }
}

function readObject(file: string, stringsOnly: boolean): Record<string, unknown> | Record<string, string> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null) as Record<string, unknown>;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`daemon store is not a regular file: ${file}`);
  if (process.platform !== "win32") {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
      throw new Error(`daemon store has unsafe ownership or permissions: ${file}`);
    }
  }
  if (stat.size > MAX_STORE_BYTES) throw new Error(`daemon store exceeds the size limit: ${file}`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`daemon store must contain one JSON object: ${file}`);
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(parsed)) {
    validateKey(key);
    if (stringsOnly && typeof value !== "string") throw new Error(`daemon secret store contains a non-string value: ${file}`);
    result[key] = cloneJson(value);
  }
  return result;
}

function writeObject(file: string, value: Record<string, unknown>): void {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_STORE_BYTES) throw new Error(`daemon store exceeds the size limit: ${file}`);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed or already absent */ }
  }
}

function validateKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > 512 || key.includes("\0") || FORBIDDEN_KEYS.has(key)) {
    throw new Error("invalid daemon state key");
  }
}

function nullRecord<T>(source: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, source);
}

function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
