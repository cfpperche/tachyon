import { constants as fsConstants } from "node:fs";
import { open, lstat, link, mkdir, readdir, realpath, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { AGENT_NAME_PATTERN, isValidAgentName } from "../config/nameValidation.js";

export const SOUL_MAX_BYTES = 64 * 1024;
export const SOUL_MAX_CHARS = 20_000;
export const SOUL_PROFILE_SCHEMA_VERSION = 1;
export const SOUL_FILE_NAME = "SOUL.md";
export const SOUL_MANIFEST_FILE_NAME = "profile.json";
export const SOUL_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;

const RETRYABLE_FS_CODES = new Set(["EIO", "EBUSY", "EMFILE", "ENFILE"]);
const profileAdmissions = new Map<string, Promise<void>>();

/** Serialize lifecycle reads and canonical profile mutations for one case-folded principal. */
export async function withSoulProfileAdmission<T>(workspaceRoot: string, name: string, operation: () => Promise<T>): Promise<T> {
  validateSoulAgentName(name);
  const key = `${path.resolve(workspaceRoot)}\0${name.toLowerCase()}`;
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

async function assertNoActiveLaunchReservation(workspaceRoot: string, principal: string): Promise<void> {
  let entries: string[];
  try { entries = await readdir(soulLaunchReservationsDir(workspaceRoot)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entries.some((entry) => entry.startsWith(`${principal.toLowerCase()}--`) && entry.endsWith(".json"))) {
    throw new SoulError("soul/io-error", `Soul profile for '${principal}' has an active lifecycle reservation`);
  }
}

export type SoulErrorCode =
  | "soul/path-invalid" | "soul/missing" | "soul/outside-workspace" | "soul/final-symlink"
  | "soul/not-regular" | "soul/permission-denied" | "soul/invalid-utf8" | "soul/empty"
  | "soul/too-many-chars" | "soul/too-many-bytes" | "soul/source-changed-during-read"
  | "soul/profile-adoption-required" | "soul/runtime-unsupported" | "soul/io-error";

export class SoulError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: SoulErrorCode, message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message, { cause: options?.cause });
    this.name = "SoulError";
    this.retryable = options?.retryable === true;
  }
}

export interface SoulProfileManifest {
  schemaVersion: 1;
  profileId: string;
  owner: string;
  state: "active" | "retained";
}

export interface ResolvedSoul {
  source: string;
  profileId: string;
  body: string;
  sha256: string;
  chars: number;
  bytes: number;
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

function parseManifest(raw: string, owner: string): SoulProfileManifest {
  try {
    const value = JSON.parse(raw) as Partial<SoulProfileManifest>;
    if (Object.keys(value).sort().join(",") !== "owner,profileId,schemaVersion,state" ||
        value.schemaVersion !== SOUL_PROFILE_SCHEMA_VERSION || typeof value.profileId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.profileId) ||
        value.owner !== owner || value.state !== "active") {
      throw new Error("inactive or wrong owner");
    }
    return value as SoulProfileManifest;
  } catch (error) {
    throw new SoulError("soul/profile-adoption-required", `Soul profile for '${owner}' requires explicit adoption`, { cause: error });
  }
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

async function ensureCanonicalProfileDir(workspaceRoot: string, name: string): Promise<string> {
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
  return components.at(-1)!;
}

function decodeSoul(bytes: Buffer): { body: string; chars: number } {
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SoulError("soul/invalid-utf8", "Soul must be valid UTF-8", { cause: error });
  }
  if (body.includes("\0")) throw new SoulError("soul/invalid-utf8", "Soul must not contain NUL bytes");
  if (body.trim().length === 0) throw new SoulError("soul/empty", "Soul must contain non-whitespace text");
  const chars = Array.from(body).length;
  if (chars > SOUL_MAX_CHARS) {
    throw new SoulError("soul/too-many-chars", `Soul contains ${chars} Unicode scalar values and ${bytes.length} bytes; maximum is ${SOUL_MAX_CHARS} scalars and ${SOUL_MAX_BYTES} bytes`);
  }
  return { body, chars };
}

/**
 * Resolve through one descriptor. POSIX uses O_NOFOLLOW. Windows additionally performs pre-open
 * lstat and post-open fstat; Node cannot portably close a same-user parent replacement race there.
 */
export async function resolveSoul(workspaceRoot: string, name: string): Promise<ResolvedSoul> {
  const source = agentSoulPath(workspaceRoot, name);
  try {
    const rootReal = await realpath(path.resolve(workspaceRoot));
    const profileReal = await realpath(agentProfileDir(workspaceRoot, name));
    const expectedProfile = path.join(rootReal, ".tachyon", "agents", name);
    if (!contained(rootReal, profileReal) || profileReal !== expectedProfile) throw new SoulError("soul/outside-workspace", `Soul profile escapes workspace: ${source}`);
    const manifest = await readPrivateManifest(agentSoulManifestPath(workspaceRoot, name), name);
    const handle = await openNoFollow(source);
    try {
      const { bytes: first } = await readStableHandle(handle, source);
      const { body, chars } = decodeSoul(first);
      return {
        source: path.relative(path.resolve(workspaceRoot), source).split(path.sep).join("/"),
        profileId: manifest.profileId,
        body,
        sha256: createHash("sha256").update(first).digest("hex"),
        chars,
        bytes: first.length,
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
  const dir = await ensureCanonicalProfileDir(workspaceRoot, name);
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
    await link(manifestStage, manifestPath);
    const resolved = await resolveSoul(workspaceRoot, name);
    await removeIfOwned(soulStage, soulIdentity);
    await removeIfOwned(manifestStage, manifestIdentity);
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
