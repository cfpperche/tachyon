import {
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { open, lstat, link, mkdir, readdir, realpath, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { AGENT_NAME_PATTERN, isValidAgentName } from "../config/nameValidation.js";

export const SOUL_MAX_BYTES = 64 * 1024;
export const SOUL_MAX_CHARS = 20_000;
export const SOUL_PROFILE_SCHEMA_VERSION = 1;
export const SOUL_PROFILE_SCHEMA_VERSION_V2 = 2;
export const SOUL_FILE_NAME = "SOUL.md";
export const SOUL_MANIFEST_FILE_NAME = "profile.json";
export const SOUL_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;
/** Random per module process: stable for this Extension Host instance, different after a restart. */
export const SOUL_LAUNCH_RESERVATION_BOOT_ID = randomUUID();

const RETRYABLE_FS_CODES = new Set(["EIO", "EBUSY", "EMFILE", "ENFILE"]);
const profileAdmissions = new Map<string, Promise<void>>();

function profileAdmissionKey(workspaceRoot: string, name: string): string {
  return `${path.resolve(workspaceRoot)}\0${name.toLowerCase()}`;
}

/** Serialize lifecycle reads and canonical profile mutations for one case-folded principal. */
export async function withSoulProfileAdmission<T>(workspaceRoot: string, name: string, operation: () => Promise<T>): Promise<T> {
  validateSoulAgentName(name);
  const key = profileAdmissionKey(workspaceRoot, name);
  const prior = profileAdmissions.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const queued = prior.then(() => held);
  profileAdmissions.set(key, queued);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (profileAdmissions.get(key) === queued) profileAdmissions.delete(key);
  }
}

/** Reconciliation never queues behind a live mutation: it either owns the same admission boundary now or defers. */
export async function tryWithSoulProfileAdmission<T>(
  workspaceRoot: string,
  name: string,
  operation: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  validateSoulAgentName(name);
  const key = profileAdmissionKey(workspaceRoot, name);
  if (profileAdmissions.has(key)) return { acquired: false };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  profileAdmissions.set(key, held);
  try {
    return { acquired: true, value: await operation() };
  } finally {
    release();
    if (profileAdmissions.get(key) === held) profileAdmissions.delete(key);
  }
}

export async function resolveSoulWithRetry<T>(operation: () => Promise<T>, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof SoulError) || !error.retryable || attempt >= SOUL_RETRY_DELAYS_MS.length) throw error;
      await wait(SOUL_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

export function soulLaunchReservationsDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".tachyon", "agent-profile-transactions", "launch-reservations");
}

function assertReservationDirContainedSync(workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  const rootReal = realpathSync(root);
  const dir = soulLaunchReservationsDir(root);
  const components = [path.join(root, ".tachyon"), path.join(root, ".tachyon", "agent-profile-transactions"), dir];
  for (const component of components) {
    const stat = lstatSync(component);
    const expected = path.join(rootReal, path.relative(root, component));
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(component) !== expected) {
      throw new SoulError("soul/outside-workspace", `Soul launch reservation parent escapes workspace: ${component}`);
    }
  }
  return dir;
}

export function ensureSoulLaunchReservationsDirSync(workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  const rootReal = realpathSync(root);
  const components = [path.join(root, ".tachyon"), path.join(root, ".tachyon", "agent-profile-transactions"), soulLaunchReservationsDir(root)];
  for (const component of components) {
    try { mkdirSync(component, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(component);
    const expected = path.join(rootReal, path.relative(root, component));
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(component) !== expected) {
      throw new SoulError("soul/outside-workspace", `Soul launch reservation parent escapes workspace: ${component}`);
    }
  }
  return components.at(-1)!;
}

async function assertReservationDirContained(workspaceRoot: string): Promise<string> {
  const root = path.resolve(workspaceRoot);
  const rootReal = await realpath(root);
  const dir = soulLaunchReservationsDir(root);
  for (const component of [path.join(root, ".tachyon"), path.join(root, ".tachyon", "agent-profile-transactions"), dir]) {
    const stat = await lstat(component);
    const expected = path.join(rootReal, path.relative(root, component));
    if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(component) !== expected) {
      throw new SoulError("soul/outside-workspace", `Soul launch reservation parent escapes workspace: ${component}`);
    }
  }
  return dir;
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface ReservationOwner {
  ownerPid?: unknown;
  ownerBootId?: unknown;
}

function reservationOwner(raw: string): ReservationOwner | undefined {
  try {
    return JSON.parse(raw) as ReservationOwner;
  } catch {
    return undefined;
  }
}

function reservationHasLiveCurrentOwner(raw: string): boolean {
  const owner = reservationOwner(raw);
  return owner?.ownerBootId === SOUL_LAUNCH_RESERVATION_BOOT_ID
    && typeof owner.ownerPid === "number"
    && pidIsAlive(owner.ownerPid);
}

/** Extension-host startup sweep: only a live reservation from this exact module process survives. */
export function cleanupStaleSoulLaunchReservationsSync(workspaceRoot: string): string[] {
  let dir: string;
  try { dir = assertReservationDirContainedSync(workspaceRoot); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let entries: string[];
  try { entries = readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(dir, entry);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (reservationHasLiveCurrentOwner(readFileSync(file, "utf8"))) continue;
      unlinkSync(file);
      removed.push(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}

export async function assertNoActiveLaunchReservation(workspaceRoot: string, principal: string): Promise<void> {
  let dir: string;
  try { dir = await assertReservationDirContained(workspaceRoot); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let entries: string[];
  try { entries = await readdir(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${principal.toLowerCase()}--`) || !entry.endsWith(".json")) continue;
    const file = path.join(dir, entry);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new SoulError("soul/io-error", `Soul profile for '${principal}' has an unsafe lifecycle reservation`);
      }
      handle = await open(file, fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0)));
      const owner = reservationOwner(await handle.readFile({ encoding: "utf8" }));
      if (owner?.ownerBootId === SOUL_LAUNCH_RESERVATION_BOOT_ID
        && typeof owner.ownerPid === "number"
        && !pidIsAlive(owner.ownerPid)) {
        await handle.close();
        handle = undefined;
        await unlink(file).catch(() => undefined);
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof SoulError) throw error;
      throw new SoulError("soul/io-error", `Unable to inspect lifecycle reservation for '${principal}'`, { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
    }
    throw new SoulError("soul/io-error", `Soul profile for '${principal}' has an active lifecycle reservation`);
  }
}

export const SOUL_ERROR_CODES = [
  "soul/path-invalid", "soul/missing", "soul/outside-workspace", "soul/final-symlink",
  "soul/not-regular", "soul/permission-denied", "soul/invalid-utf8", "soul/empty",
  "soul/too-many-chars", "soul/too-many-bytes", "soul/source-changed-during-read",
  "soul/profile-adoption-required", "soul/runtime-unsupported", "soul/io-error",
  "soul/profile-transaction-degraded", "soul/profile-collision", "soul/digest-mismatch",
  "soul/profile-enabled",
  // t-e81ec5 — the agent is a canonical profile pointer, which cannot carry an inline `soul:` key.
  // Its own code because it is a STRUCTURAL refusal, not an I/O failure: retrying, fixing permissions
  // or repairing bytes cannot make it succeed, and the operator needs to be told that rather than
  // handed `soul/io-error` from deep inside the config writer.
  "soul/canonical-profile-unsupported",
] as const;

export type SoulErrorCode = typeof SOUL_ERROR_CODES[number];

export function isSoulErrorCode(value: unknown): value is SoulErrorCode {
  return typeof value === "string" && (SOUL_ERROR_CODES as readonly string[]).includes(value);
}

/** Minimal template exclusively published by Create SOUL.md (spec 377 T15). */
export const SOUL_MINIMAL_TEMPLATE = "# Soul\n\nDescribe this agent's identity, voice, and non-negotiables.\n";

export class SoulError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: SoulErrorCode, message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message, { cause: options?.cause });
    this.name = "SoulError";
    this.retryable = options?.retryable === true;
  }
}

export interface SoulProfileManifest {
  schemaVersion: 1 | 2;
  profileId: string;
  owner: string;
  state: "active" | "retained";
  /** Present and mandatory for canonical profile authority (schema v2). */
  agentId?: string;
}

export interface ResolvedSoul {
  source: string;
  profileId: string;
  body: string;
  sha256: string;
  chars: number;
  bytes: number;
  agentId?: string;
}

export function validateSoulAgentName(name: string): void {
  if (!isValidAgentName(name)) {
    throw new SoulError("soul/path-invalid", `Invalid agent name '${name}'; expected ${AGENT_NAME_PATTERN}`);
  }
}

export function agentProfileDir(workspaceRoot: string, name: string): string {
  validateSoulAgentName(name);
  if (!path.isAbsolute(workspaceRoot)) throw new SoulError("soul/path-invalid", "Workspace root must be absolute");
  return path.join(path.resolve(workspaceRoot), ".tachyon", "agents", name);
}

export function agentSoulPath(workspaceRoot: string, name: string): string {
  return path.join(agentProfileDir(workspaceRoot, name), SOUL_FILE_NAME);
}

export function agentSoulManifestPath(workspaceRoot: string, name: string): string {
  return path.join(agentProfileDir(workspaceRoot, name), SOUL_MANIFEST_FILE_NAME);
}

export const soulProfileDir = agentProfileDir;
export const canonicalSoulPath = agentSoulPath;

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function mapFsError(error: unknown, source: string): SoulError {
  if (error instanceof SoulError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
  if (code === "ENOENT") return new SoulError("soul/missing", `Soul profile is missing: ${source}`, { cause: error });
  if (code === "ELOOP") return new SoulError("soul/final-symlink", `Soul source must not be a symlink: ${source}`, { cause: error });
  if (code === "EACCES" || code === "EPERM") return new SoulError("soul/permission-denied", `Permission denied reading soul profile: ${source}`, { cause: error });
  return new SoulError("soul/io-error", `Unable to read soul profile: ${source}`, { cause: error, retryable: RETRYABLE_FS_CODES.has(code) });
}

function parseManifestFields(raw: string, owner: string, allowRetained: boolean): SoulProfileManifest {
  try {
    const value = JSON.parse(raw) as Partial<SoulProfileManifest>;
    const keys = Object.keys(value).sort().join(",");
    const v1 = value.schemaVersion === SOUL_PROFILE_SCHEMA_VERSION && keys === "owner,profileId,schemaVersion,state";
    const v2 = value.schemaVersion === SOUL_PROFILE_SCHEMA_VERSION_V2 && keys === "agentId,owner,profileId,schemaVersion,state"
      && typeof value.agentId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.agentId);
    if ((!v1 && !v2) || typeof value.profileId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.profileId) ||
        value.owner !== owner ||
        (value.state !== "active" && !(allowRetained && value.state === "retained"))) {
      throw new Error("inactive or wrong owner");
    }
    return value as SoulProfileManifest;
  } catch (error) {
    throw new SoulError("soul/profile-adoption-required", `Soul profile for '${owner}' requires explicit adoption`, { cause: error });
  }
}

function parseManifest(raw: string, owner: string): SoulProfileManifest {
  return parseManifestFields(raw, owner, false);
}

function parseManifestAnyState(raw: string, owner: string): SoulProfileManifest {
  return parseManifestFields(raw, owner, true);
}

function sameStat(a: { size: number; mtimeMs: number; ctimeMs: number }, b: { size: number; mtimeMs: number; ctimeMs: number }): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function boundedRead(handle: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(SOUL_MAX_BYTES + 1);
  let total = 0;
  while (total < buffer.length) {
    const result = await handle.read(buffer, total, buffer.length - total, total);
    if (result.bytesRead === 0) break;
    total += result.bytesRead;
  }
  if (total > SOUL_MAX_BYTES) {
    throw new SoulError("soul/too-many-bytes", `Soul contains ${total} bytes; maximum is ${SOUL_MAX_BYTES} bytes (and ${SOUL_MAX_CHARS} Unicode scalar values)`);
  }
  return buffer.subarray(0, total);
}

async function readStableHandle(handle: Awaited<ReturnType<typeof open>>, source: string): Promise<{ bytes: Buffer; stat: Awaited<ReturnType<typeof handle.stat>> }> {
  const stat1 = await handle.stat();
  if (!stat1.isFile()) throw new SoulError("soul/not-regular", `Soul source must be a regular file: ${source}`);
  if (stat1.size > SOUL_MAX_BYTES) {
    throw new SoulError("soul/too-many-bytes", `Soul contains ${stat1.size} bytes; maximum is ${SOUL_MAX_BYTES} bytes (and ${SOUL_MAX_CHARS} Unicode scalar values)`);
  }
  const first = await boundedRead(handle);
  const stat2 = await handle.stat();
  const second = await boundedRead(handle);
  const stat3 = await handle.stat();
  if (!first.equals(second) || first.length !== stat3.size || !sameStat(stat1, stat2) || !sameStat(stat2, stat3)) {
    throw new SoulError("soul/source-changed-during-read", `Soul source changed while being read: ${source}`, { retryable: true });
  }
  return { bytes: first, stat: stat3 };
}

async function openNoFollow(source: string): Promise<Awaited<ReturnType<typeof open>>> {
  const before = await lstat(source);
  if (before.isSymbolicLink()) throw new SoulError("soul/final-symlink", `Soul source must not be a symlink: ${source}`);
  const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(source, fsConstants.O_RDONLY | noFollow);
  if (process.platform === "win32") {
    const after = await handle.stat();
    if (before.dev !== after.dev || (before.ino !== 0 && after.ino !== 0 && before.ino !== after.ino)) {
      await handle.close();
      throw new SoulError("soul/source-changed-during-read", `Soul source changed while being opened: ${source}`, { retryable: true });
    }
  }
  return handle;
}

async function readPrivateManifest(source: string, owner: string): Promise<SoulProfileManifest> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await openNoFollow(source);
    const stat = await handle.stat();
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
      throw new SoulError("soul/profile-adoption-required", `Soul profile for '${owner}' requires explicit adoption`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new SoulError("soul/profile-adoption-required", `Soul profile for '${owner}' requires explicit adoption`);
    }
    const bytes = await boundedRead(handle);
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new SoulError("soul/profile-adoption-required", `Soul profile for '${owner}' requires explicit adoption`, { cause: error });
    }
    return parseManifest(raw, owner);
  } catch (error) {
    if (error instanceof SoulError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "EACCES" || code === "EPERM") {
      throw new SoulError("soul/permission-denied", `Permission denied reading soul profile manifest: ${source}`, { cause: error });
    }
    if (RETRYABLE_FS_CODES.has(code)) {
      throw new SoulError("soul/io-error", `Unable to read soul profile manifest: ${source}`, { cause: error, retryable: true });
    }
    if (code === "ENOENT") throw new SoulError("soul/profile-adoption-required", `Soul profile for '${owner}' requires explicit adoption`, { cause: error });
    throw new SoulError("soul/io-error", `Unable to read soul profile manifest: ${source}`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

type FileIdentity = { dev: bigint | number; ino: bigint | number };

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function removeIfOwned(file: string, identity: FileIdentity): Promise<void> {
  try {
    const current = await lstat(file, { bigint: true });
    if (sameIdentity(current, identity)) await unlink(file);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code !== "ENOENT") throw error;
  }
}

async function stagePrivateFile(file: string, content: string | Buffer): Promise<FileIdentity> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(content);
    await handle.sync();
    return await handle.stat({ bigint: true });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertAgentProfileDir(workspaceRoot: string, name: string): Promise<string> {
  const root = path.resolve(workspaceRoot);
  const rootReal = await realpath(root);
  const components = [path.join(root, ".tachyon"), path.join(root, ".tachyon", "agents"), agentProfileDir(root, name)];
  for (const component of components) {
    const stat = await lstat(component);
    const expected = path.join(rootReal, path.relative(root, component));
    if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(component) !== expected || !contained(rootReal, expected)) {
      throw new SoulError("soul/outside-workspace", `Soul profile parent escapes workspace: ${component}`);
    }
  }
  return components.at(-1)!;
}

async function ensureAgentProfileDir(workspaceRoot: string, name: string): Promise<string> {
  const root = path.resolve(workspaceRoot);
  const rootReal = await realpath(root);
  const components = [path.join(root, ".tachyon"), path.join(root, ".tachyon", "agents"), agentProfileDir(root, name)];
  for (const component of components) {
    try {
      await mkdir(component, { mode: 0o700 });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code !== "EEXIST") throw error;
    }
    const stat = await lstat(component);
    const expected = path.join(rootReal, path.relative(root, component));
    if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(component) !== expected || !contained(rootReal, expected)) {
      throw new SoulError("soul/outside-workspace", `Soul profile parent escapes workspace: ${component}`);
    }
  }
  return assertAgentProfileDir(workspaceRoot, name);
}

function decodeSoul(bytes: Buffer, enforceAuthoringLimit = true): { body: string; chars: number } {
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SoulError("soul/invalid-utf8", "Soul must be valid UTF-8", { cause: error });
  }
  if (body.includes("\0")) throw new SoulError("soul/invalid-utf8", "Soul must not contain NUL bytes");
  if (body.trim().length === 0) throw new SoulError("soul/empty", "Soul must contain non-whitespace text");
  const chars = Array.from(body).length;
  if (enforceAuthoringLimit && chars > SOUL_MAX_CHARS) {
    throw new SoulError("soul/too-many-chars", `Soul contains ${chars} Unicode scalar values and ${bytes.length} bytes; maximum is ${SOUL_MAX_CHARS} scalars and ${SOUL_MAX_BYTES} bytes`);
  }
  return { body, chars };
}

/**
 * Resolve through one descriptor. POSIX uses O_NOFOLLOW. Windows additionally performs pre-open
 * lstat and post-open fstat; Node cannot portably close a same-user parent replacement race there.
 */
export async function resolveSoul(workspaceRoot: string, name: string, expectedAgentId?: string): Promise<ResolvedSoul> {
  const source = agentSoulPath(workspaceRoot, name);
  try {
    await assertAgentProfileDir(workspaceRoot, name);
    const manifest = await readPrivateManifest(agentSoulManifestPath(workspaceRoot, name), name);
    if (expectedAgentId !== undefined && (manifest.schemaVersion !== SOUL_PROFILE_SCHEMA_VERSION_V2 || manifest.agentId !== expectedAgentId)) {
      throw new SoulError("soul/profile-adoption-required", `Soul profile for '${name}' is not bound to agentId '${expectedAgentId}'`);
    }
    const handle = await openNoFollow(source);
    try {
      const { bytes: first } = await readStableHandle(handle, source);
      const { body, chars } = decodeSoul(first, false);
      return {
        source: path.relative(path.resolve(workspaceRoot), source).split(path.sep).join("/"),
        profileId: manifest.profileId,
        body,
        sha256: createHash("sha256").update(first).digest("hex"),
        chars,
        bytes: first.length,
        ...(manifest.agentId ? { agentId: manifest.agentId } : {}),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw mapFsError(error, source);
  }
}

export const resolveAgentSoul = resolveSoul;

export interface ImportSoulResult { profileId: string; sha256: string; chars: number; bytes: number; }

/** Validate and copy exact source bytes into the private canonical profile. The source path is not returned or persisted. */
async function importSoulProfileUnlocked(workspaceRoot: string, name: string, importSource: string): Promise<ImportSoulResult> {
  validateSoulAgentName(name);
  await assertNoActiveLaunchReservation(workspaceRoot, name);
  let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
  let bytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  try {
    sourceHandle = await openNoFollow(importSource);
    ({ bytes } = await readStableHandle(sourceHandle, importSource));
  } catch (error) {
    throw mapFsError(error, importSource);
  } finally {
    await sourceHandle?.close().catch(() => undefined);
  }
  const { chars } = decodeSoul(bytes);
  const dir = await ensureAgentProfileDir(workspaceRoot, name);
  const destination = agentSoulPath(workspaceRoot, name);
  const profileId = randomUUID();
  const manifest: SoulProfileManifest = { schemaVersion: 1, profileId, owner: name, state: "active" };
  const manifestPath = agentSoulManifestPath(workspaceRoot, name);
  const soulStage = path.join(dir, `.SOUL.md.${randomUUID()}.stage`);
  const manifestStage = path.join(dir, `.profile.json.${randomUUID()}.stage`);
  let soulIdentity: FileIdentity | undefined;
  let manifestIdentity: FileIdentity | undefined;
  try {
    soulIdentity = await stagePrivateFile(soulStage, bytes);
    manifestIdentity = await stagePrivateFile(manifestStage, `${JSON.stringify(manifest, null, 2)}\n`);

    // Hard-link publication is atomic and create-only. The complete soul becomes visible first;
    // activation becomes visible only when the manifest is published last.
    await link(soulStage, destination);
    await syncDirectory(dir);
    await link(manifestStage, manifestPath);
    await syncDirectory(dir);
    const resolved = await resolveSoul(workspaceRoot, name);
    await removeIfOwned(soulStage, soulIdentity);
    await removeIfOwned(manifestStage, manifestIdentity);
    await syncDirectory(dir);
    return { profileId, sha256: resolved.sha256, chars, bytes: bytes.length };
  } catch (error) {
    // Stage names are unique and opened create-only, so these paths are ours even when a
    // write/sync/stat failure prevented identity capture. Published names still require identity.
    await unlink(soulStage).catch(() => undefined);
    await unlink(manifestStage).catch(() => undefined);
    if (manifestIdentity) {
      await removeIfOwned(manifestPath, manifestIdentity).catch(() => undefined);
    }
    if (soulIdentity) {
      await removeIfOwned(destination, soulIdentity).catch(() => undefined);
    }
    await syncDirectory(dir).catch(() => undefined);
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST") {
      throw new SoulError("soul/profile-adoption-required", `Canonical profile already exists for '${name}'; explicit adoption or replace is required`, { cause: error });
    }
    throw mapFsError(error, destination);
  }
}

export function importSoulProfile(workspaceRoot: string, name: string, importSource: string): Promise<ImportSoulResult> {
  return withSoulProfileAdmission(workspaceRoot, name, () => importSoulProfileUnlocked(workspaceRoot, name, importSource));
}

export const importSoul = importSoulProfile;

export type SoulProfileLifecycleState = "missing" | "active" | "retained" | "unowned" | "invalid";

export interface SoulProfileStatus {
  agent: string;
  canonicalPath: string;
  relativePath: string;
  lifecycle: SoulProfileLifecycleState;
  profileId?: string;
  sha256?: string;
  chars?: number;
  bytes?: number;
  soulEnabled: boolean;
  resolvable: boolean;
  transactionDegraded: boolean;
  /** Bounded preview text when available; never includes an import source path. */
  preview?: string;
}

/** Read a same-owner manifest in either active or retained state (Studio status / adopt). */
export async function readSoulManifestAnyState(workspaceRoot: string, name: string): Promise<SoulProfileManifest> {
  validateSoulAgentName(name);
  try {
    await assertAgentProfileDir(workspaceRoot, name);
  } catch (error) {
    if (error instanceof SoulError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SoulError("soul/profile-adoption-required", `Soul profile for '${name}' requires explicit adoption`, { cause: error });
    }
    throw error;
  }
  return readPrivateManifestAnyState(agentSoulManifestPath(workspaceRoot, name), name);
}

/** Exact private manifest bytes for transaction tuple proofs; undefined only when the final file is absent. */
export async function readCanonicalSoulManifestBytes(workspaceRoot: string, name: string): Promise<Buffer | undefined> {
  validateSoulAgentName(name);
  const source = agentSoulManifestPath(workspaceRoot, name);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertAgentProfileDir(workspaceRoot, name);
    handle = await openNoFollow(source);
    const { bytes } = await readStableHandle(handle, source);
    return bytes;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT" || (error instanceof SoulError && error.code === "soul/missing")) return undefined;
    throw mapFsError(error, source);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readPrivateManifestAnyState(source: string, owner: string): Promise<SoulProfileManifest> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await openNoFollow(source);
    const stat = await handle.stat();
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
      throw new SoulError("soul/profile-adoption-required", `Soul profile for '${owner}' requires explicit adoption`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new SoulError("soul/profile-adoption-required", `Soul profile for '${owner}' requires explicit adoption`);
    }
    const bytes = await boundedRead(handle);
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new SoulError("soul/profile-adoption-required", `Soul profile for '${owner}' requires explicit adoption`, { cause: error });
    }
    return parseManifestAnyState(raw, owner);
  } catch (error) {
    if (error instanceof SoulError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "EACCES" || code === "EPERM") {
      throw new SoulError("soul/permission-denied", `Permission denied reading soul profile manifest: ${source}`, { cause: error });
    }
    if (RETRYABLE_FS_CODES.has(code)) {
      throw new SoulError("soul/io-error", `Unable to read soul profile manifest: ${source}`, { cause: error, retryable: true });
    }
    if (code === "ENOENT") throw new SoulError("soul/profile-adoption-required", `Soul profile for '${owner}' requires explicit adoption`, { cause: error });
    throw new SoulError("soul/io-error", `Unable to read soul profile manifest: ${source}`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Validate import/create bytes without publishing. Does not accept or return a source path. */
export function validateSoulBytes(bytes: Buffer): { body: string; chars: number; sha256: string } {
  if (bytes.length > SOUL_MAX_BYTES) {
    throw new SoulError("soul/too-many-bytes", `Soul contains ${bytes.length} bytes; maximum is ${SOUL_MAX_BYTES} bytes (and ${SOUL_MAX_CHARS} Unicode scalar values)`);
  }
  const { body, chars } = decodeSoul(bytes);
  return { body, chars, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Read exact validated bytes from a local regular file without following a final symlink. */
export async function readValidatedSoulSourceBytes(sourcePath: string): Promise<Buffer> {
  let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    sourceHandle = await openNoFollow(sourcePath);
    const { bytes } = await readStableHandle(sourceHandle, sourcePath);
    decodeSoul(bytes);
    return bytes;
  } catch (error) {
    throw mapFsError(error, sourcePath);
  } finally {
    await sourceHandle?.close().catch(() => undefined);
  }
}

export async function readCanonicalSoulBytes(workspaceRoot: string, name: string): Promise<Buffer | undefined> {
  const source = agentSoulPath(workspaceRoot, name);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertAgentProfileDir(workspaceRoot, name);
    handle = await openNoFollow(source);
    const { bytes } = await readStableHandle(handle, source);
    return bytes;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (error instanceof SoulError && error.code === "soul/missing") return undefined;
    if (code === "ENOENT") return undefined;
    throw mapFsError(error, source);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface FoldedProfileCollision {
  owner: string;
  profileId: string;
  state: "active" | "retained";
}

/** Reject distinct active/retained manifests whose owner folds to the same ASCII case. */
export async function findFoldedProfileCollision(
  workspaceRoot: string,
  name: string,
  opts?: { selfProfileId?: string },
): Promise<FoldedProfileCollision | undefined> {
  validateSoulAgentName(name);
  const folded = name.toLowerCase();
  const agentsRoot = path.join(path.resolve(workspaceRoot), ".tachyon", "agents");
  let entries: string[];
  try {
    entries = await readdir(agentsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  for (const entry of entries) {
    if (!isValidAgentName(entry) || entry.toLowerCase() !== folded) continue;
    try {
      const manifest = await readSoulManifestAnyState(workspaceRoot, entry);
      if (opts?.selfProfileId && manifest.profileId === opts.selfProfileId && entry === name) continue;
      if (opts?.selfProfileId && manifest.profileId === opts.selfProfileId && entry.toLowerCase() === folded) continue;
      if (entry === name && opts?.selfProfileId === undefined) continue;
      if (entry === name) continue;
      return { owner: entry, profileId: manifest.profileId, state: manifest.state };
    } catch (error) {
      if (error instanceof SoulError && (error.code === "soul/profile-adoption-required" || error.code === "soul/missing")) continue;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return undefined;
}

const PREVIEW_MAX_CHARS = 2_000;

export async function inspectSoulProfile(
  workspaceRoot: string,
  name: string,
  opts?: { soulEnabled?: boolean; transactionDegraded?: boolean; includePreview?: boolean },
): Promise<SoulProfileStatus> {
  validateSoulAgentName(name);
  const relativePath = `.tachyon/agents/${name}/SOUL.md`;
  const status: SoulProfileStatus = {
    agent: name,
    canonicalPath: agentSoulPath(workspaceRoot, name),
    relativePath,
    lifecycle: "missing",
    soulEnabled: opts?.soulEnabled === true,
    resolvable: false,
    transactionDegraded: opts?.transactionDegraded === true,
  };
  try {
    const manifest = await readSoulManifestAnyState(workspaceRoot, name);
    status.profileId = manifest.profileId;
    status.lifecycle = manifest.state;
    const bytes = await readCanonicalSoulBytes(workspaceRoot, name);
    if (bytes) {
      status.sha256 = createHash("sha256").update(bytes).digest("hex");
      status.bytes = bytes.length;
      try {
        const validated = validateSoulBytes(bytes);
        status.chars = validated.chars;
        if (opts?.includePreview !== false) {
          status.preview = validated.body.length > PREVIEW_MAX_CHARS
            ? `${validated.body.slice(0, PREVIEW_MAX_CHARS)}\n…`
            : validated.body;
        }
      } catch {
        status.lifecycle = "invalid";
      }
    } else if (manifest.state === "retained") {
      status.lifecycle = "retained";
    } else {
      status.lifecycle = "missing";
    }
  } catch (error) {
    if (error instanceof SoulError && error.code === "soul/profile-adoption-required") {
      const bytes = await readCanonicalSoulBytes(workspaceRoot, name);
      if (bytes) {
        status.lifecycle = "unowned";
        status.sha256 = createHash("sha256").update(bytes).digest("hex");
        status.bytes = bytes.length;
        try {
          const validated = validateSoulBytes(bytes);
          status.chars = validated.chars;
          if (opts?.includePreview !== false) {
            status.preview = validated.body.length > PREVIEW_MAX_CHARS
              ? `${validated.body.slice(0, PREVIEW_MAX_CHARS)}\n…`
              : validated.body;
          }
        } catch {
          status.lifecycle = "invalid";
        }
      }
    } else if (error instanceof SoulError && error.code !== "soul/missing") throw error;
    else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (status.lifecycle === "active" && status.sha256) {
    try {
      await resolveSoul(workspaceRoot, name);
      status.resolvable = true;
    } catch {
      status.resolvable = false;
    }
  }
  return status;
}

/** True when `candidate` resolves to the same path as the agent's canonical SOUL.md. */
export function isCanonicalSoulPath(workspaceRoot: string, name: string, candidate: string): boolean {
  return path.resolve(candidate) === path.resolve(agentSoulPath(workspaceRoot, name));
}

/** Low-level exclusive publish used by journaled create/import after staging. */
export async function publishCanonicalSoulFiles(
  workspaceRoot: string,
  name: string,
  bytes: Buffer,
  manifest: SoulProfileManifest,
): Promise<{ sha256: string; chars: number; bytes: number }> {
  validateSoulAgentName(name);
  if (manifest.owner !== name) {
    throw new SoulError("soul/path-invalid", `Manifest owner '${manifest.owner}' does not match agent '${name}'`);
  }
  const { chars } = decodeSoul(bytes);
  const dir = await ensureAgentProfileDir(workspaceRoot, name);
  const destination = agentSoulPath(workspaceRoot, name);
  const manifestPath = agentSoulManifestPath(workspaceRoot, name);
  const soulStage = path.join(dir, `.SOUL.md.${randomUUID()}.stage`);
  const manifestStage = path.join(dir, `.profile.json.${randomUUID()}.stage`);
  let soulIdentity: FileIdentity | undefined;
  let manifestIdentity: FileIdentity | undefined;
  try {
    soulIdentity = await stagePrivateFile(soulStage, bytes);
    manifestIdentity = await stagePrivateFile(manifestStage, `${JSON.stringify(manifest, null, 2)}\n`);
    await link(soulStage, destination);
    await syncDirectory(dir);
    await link(manifestStage, manifestPath);
    await syncDirectory(dir);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await removeIfOwned(soulStage, soulIdentity);
    await removeIfOwned(manifestStage, manifestIdentity);
    await syncDirectory(dir);
    return { sha256, chars, bytes: bytes.length };
  } catch (error) {
    await unlink(soulStage).catch(() => undefined);
    await unlink(manifestStage).catch(() => undefined);
    if (manifestIdentity) await removeIfOwned(manifestPath, manifestIdentity).catch(() => undefined);
    if (soulIdentity) await removeIfOwned(destination, soulIdentity).catch(() => undefined);
    await syncDirectory(dir).catch(() => undefined);
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST") {
      throw new SoulError("soul/profile-adoption-required", `Canonical profile already exists for '${name}'; explicit adoption or replace is required`, { cause: error });
    }
    throw mapFsError(error, destination);
  }
}

/** Atomically replace only the private manifest after a digest CAS against the current destination. */
export async function writeSoulManifestState(
  workspaceRoot: string,
  name: string,
  manifest: SoulProfileManifest,
  opts?: { expectedDigest?: string | null },
): Promise<void> {
  validateSoulAgentName(name);
  if (manifest.owner !== name) {
    throw new SoulError("soul/path-invalid", `Manifest owner '${manifest.owner}' does not match agent '${name}'`);
  }
  const dir = await ensureAgentProfileDir(workspaceRoot, name);
  const manifestPath = agentSoulManifestPath(workspaceRoot, name);
  const stage = path.join(dir, `.profile.json.${randomUUID()}.stage`);
  let identity: FileIdentity | undefined;
  try {
    identity = await stagePrivateFile(stage, `${JSON.stringify(manifest, null, 2)}\n`);
    if (opts && "expectedDigest" in opts) {
      const current = await readCanonicalSoulManifestBytes(workspaceRoot, name);
      const digest = current ? createHash("sha256").update(current).digest("hex") : null;
      if (digest !== opts.expectedDigest) {
        throw new SoulError("soul/profile-transaction-degraded", `Manifest changed during profile transaction for '${name}'`);
      }
    }
    await rename(stage, manifestPath);
    await syncDirectory(dir);
    await removeIfOwned(stage, identity);
  } catch (error) {
    await unlink(stage).catch(() => undefined);
    await syncDirectory(dir).catch(() => undefined);
    throw mapFsError(error, manifestPath);
  }
}
