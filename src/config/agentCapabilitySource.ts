import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { containsUnsafeFramingCharacter } from "./framingSafety.js";
import { AGENT_PROFILE_REFERENCE_MAX_BYTES, agentProfileRelativePathError } from "./agentProfileSchema.js";

const TREE_DOMAIN = Buffer.from("tachyon/agent-capability-tree/v1\0", "utf8");

export interface CapturedCapabilityEntry {
  path: string;
  type: "file" | "directory";
  mode: number;
  bytes?: Buffer;
}

export interface CapturedCapabilitySource {
  source: string;
  sourcePath: string;
  type: "file" | "tree";
  sha256: string;
  entries: CapturedCapabilityEntry[];
}

export class AgentCapabilitySourceError extends Error {
  constructor(readonly code: "profile/invalid-path" | "profile/unsupported-custody" | "profile/unsafe-path" | "profile/missing-reference" | "profile/not-regular" | "profile/too-large" | "profile/changed-during-read" | "profile/digest-mismatch" | "profile/io", readonly source: string, detail: string) {
    super(`${code}: ${source}: ${detail}`);
    this.name = "AgentCapabilitySourceError";
  }
}

function fail(code: AgentCapabilitySourceError["code"], source: string, detail: string): never {
  throw new AgentCapabilitySourceError(code, source, detail);
}

function flags(source: string): { directory: number; noFollow: number; nonBlock: number } {
  const directory = fs.constants.O_DIRECTORY;
  const noFollow = fs.constants.O_NOFOLLOW;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (typeof directory !== "number" || typeof noFollow !== "number" || typeof nonBlock !== "number") {
    fail("profile/unsupported-custody", source, "platform does not expose no-follow directory reads");
  }
  return { directory, noFollow, nonBlock };
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameRevision(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function descriptorPath(fd: number, source: string): string {
  const expected = fs.fstatSync(fd, { bigint: true });
  for (const root of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = `${root}/${fd}`;
    try {
      const actual = fs.statSync(candidate, { bigint: true });
      if (sameIdentity(expected, actual)) return candidate;
    } catch {
      // Try the next descriptor filesystem.
    }
  }
  fail("profile/unsupported-custody", source, "host has no verified descriptor-relative filesystem path");
}

function duplicateDirectory(fd: number, source: string): number {
  const expected = fs.fstatSync(fd, { bigint: true });
  const opened = fs.openSync(descriptorPath(fd, source), fs.constants.O_RDONLY | flags(source).directory | flags(source).nonBlock);
  const actual = fs.fstatSync(opened, { bigint: true });
  if (!actual.isDirectory() || !sameIdentity(expected, actual)) {
    fs.closeSync(opened);
    fail("profile/changed-during-read", source, "custody root changed while duplicated");
  }
  return opened;
}

function openDirectory(parentFd: number, name: string, source: string): number {
  const candidate = `${descriptorPath(parentFd, source)}/${name}`;
  try {
    const opened = fs.openSync(candidate, fs.constants.O_RDONLY | flags(source).directory | flags(source).noFollow | flags(source).nonBlock);
    if (!fs.fstatSync(opened).isDirectory()) {
      fs.closeSync(opened);
      fail("profile/not-regular", source, `${name} is not a directory`);
    }
    return opened;
  } catch (error) {
    if (error instanceof AgentCapabilitySourceError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") fail("profile/missing-reference", source, "does not exist");
    if (code === "ELOOP" || code === "ENOTDIR") fail("profile/unsafe-path", source, "must not traverse a symbolic link");
    fail("profile/io", source, `cannot open directory: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateEntryName(name: string, source: string): void {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")
    || containsUnsafeFramingCharacter(name) || name.normalize("NFC") !== name) {
    fail("profile/invalid-path", source, `unsafe or non-canonical tree entry ${JSON.stringify(name)}`);
  }
}

function readFile(parentFd: number, name: string, source: string, budget: { bytes: number }): { bytes: Buffer; mode: number } {
  const candidate = `${descriptorPath(parentFd, source)}/${name}`;
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(candidate, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("profile/changed-during-read", source, "entry disappeared while captured");
    fail("profile/io", source, `cannot inspect file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (before.isSymbolicLink()) fail("profile/unsafe-path", source, "tree contains a symbolic link");
  if (!before.isFile()) fail("profile/not-regular", source, "tree contains a special file");
  if (before.size > BigInt(AGENT_PROFILE_REFERENCE_MAX_BYTES - budget.bytes)) fail("profile/too-large", source, `captured payload exceeds ${AGENT_PROFILE_REFERENCE_MAX_BYTES} bytes`);

  let fd: number;
  try {
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | flags(source).noFollow | flags(source).nonBlock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") fail("profile/unsafe-path", source, "tree contains a symbolic link");
    fail("profile/changed-during-read", source, "file changed while opened");
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) fail("profile/changed-during-read", source, "file identity changed while opened");
    const bytes = fs.readFileSync(fd);
    budget.bytes += bytes.length;
    if (budget.bytes > AGENT_PROFILE_REFERENCE_MAX_BYTES) fail("profile/too-large", source, `captured payload exceeds ${AGENT_PROFILE_REFERENCE_MAX_BYTES} bytes`);
    const afterFd = fs.fstatSync(fd, { bigint: true });
    const afterPath = fs.lstatSync(candidate, { bigint: true });
    if (afterPath.isSymbolicLink() || !sameRevision(opened, afterFd) || !sameIdentity(opened, afterPath)) {
      fail("profile/changed-during-read", source, "file changed while bytes were captured");
    }
    return { bytes, mode: Number(opened.mode & 0o777n) };
  } finally {
    fs.closeSync(fd);
  }
}

function captureDirectory(fd: number, source: string, relative: string, entries: CapturedCapabilityEntry[], budget: { bytes: number }): void {
  const before = fs.fstatSync(fd, { bigint: true });
  if (!before.isDirectory()) fail("profile/not-regular", source, "tree root must be a directory");
  entries.push({ path: relative || ".", type: "directory", mode: Number(before.mode & 0o777n) });
  let names: string[];
  try {
    names = fs.readdirSync(descriptorPath(fd, source)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  } catch (error) {
    fail("profile/io", source, `cannot enumerate tree: ${error instanceof Error ? error.message : String(error)}`);
  }
  const folded = new Set<string>();
  for (const name of names) {
    validateEntryName(name, source);
    const lower = name.toLocaleLowerCase("en-US");
    if (folded.has(lower)) fail("profile/invalid-path", source, `tree contains a case-folding collision at ${JSON.stringify(name)}`);
    folded.add(lower);
    const itemPath = relative ? `${relative}/${name}` : name;
    const candidate = `${descriptorPath(fd, source)}/${name}`;
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (stat.isSymbolicLink()) fail("profile/unsafe-path", source, `tree contains a symbolic link at ${itemPath}`);
    if (stat.isDirectory()) {
      const child = openDirectory(fd, name, source);
      try {
        captureDirectory(child, source, itemPath, entries, budget);
      } finally {
        fs.closeSync(child);
      }
    } else if (stat.isFile()) {
      const captured = readFile(fd, name, source, budget);
      entries.push({ path: itemPath, type: "file", mode: captured.mode, bytes: captured.bytes });
    } else {
      fail("profile/not-regular", source, `tree contains a special file at ${itemPath}`);
    }
  }
  const after = fs.fstatSync(fd, { bigint: true });
  if (!sameRevision(before, after)) fail("profile/changed-during-read", source, "directory changed while tree bytes were captured");
}

function frame(hash: crypto.Hash, value: Buffer | string): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

export function digestCapturedCapability(type: "file" | "tree", entries: readonly CapturedCapabilityEntry[]): string {
  if (type === "file") {
    const file = entries.find((entry) => entry.type === "file");
    return crypto.createHash("sha256").update(file?.bytes ?? Buffer.alloc(0)).digest("hex");
  }
  const hash = crypto.createHash("sha256").update(TREE_DOMAIN);
  for (const entry of entries) {
    frame(hash, entry.type);
    frame(hash, entry.path);
    frame(hash, String(entry.mode));
    if (entry.type === "file") frame(hash, entry.bytes ?? Buffer.alloc(0));
  }
  return hash.digest("hex");
}

export function captureCapabilitySourceFromDirectory(
  directoryFd: number,
  rootPath: string,
  referencePath: string,
  expectedSha256: string,
): CapturedCapabilitySource {
  return captureFromDirectory(directoryFd, rootPath, referencePath, expectedSha256);
}

function captureFromDirectory(
  directoryFd: number,
  rootPath: string,
  referencePath: string,
  expectedSha256: string | undefined,
): CapturedCapabilitySource {
  const reason = agentProfileRelativePathError(referencePath);
  if (reason) fail("profile/invalid-path", referencePath, reason);
  const source = referencePath;
  const segments = referencePath.split("/");
  const leaf = segments.pop()!;
  let current = duplicateDirectory(directoryFd, source);
  try {
    for (const segment of segments) {
      const child = openDirectory(current, segment, source);
      fs.closeSync(current);
      current = child;
    }
    const candidate = `${descriptorPath(current, source)}/${leaf}`;
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(candidate, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("profile/missing-reference", source, "does not exist");
      fail("profile/io", source, `cannot inspect capability source: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (stat.isSymbolicLink()) fail("profile/unsafe-path", source, "must not be a symbolic link");
    const entries: CapturedCapabilityEntry[] = [];
    let type: "file" | "tree";
    if (stat.isFile()) {
      const budget = { bytes: 0 };
      const captured = readFile(current, leaf, source, budget);
      entries.push({ path: ".", type: "file", mode: captured.mode, bytes: captured.bytes });
      type = "file";
    } else if (stat.isDirectory()) {
      const child = openDirectory(current, leaf, source);
      try {
        captureDirectory(child, source, "", entries, { bytes: 0 });
      } finally {
        fs.closeSync(child);
      }
      type = "tree";
    } else {
      fail("profile/not-regular", source, "must be a regular file or directory");
    }
    const sha256 = digestCapturedCapability(type, entries);
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
      fail("profile/digest-mismatch", source, `expected ${expectedSha256}, consumed ${sha256}`);
    }
    return { source, sourcePath: path.join(rootPath, ...referencePath.split("/")), type, sha256, entries };
  } finally {
    fs.closeSync(current);
  }
}

export function captureCapabilitySourceAtRoot(rootPath: string, referencePath: string, expectedSha256: string): CapturedCapabilitySource {
  return captureAtRoot(rootPath, referencePath, expectedSha256);
}

/**
 * t-5498a6 — capture a capability source that has NO expected digest yet.
 *
 * Authorization is the one moment where the digest is being established rather than verified: the
 * human is deciding to pin whatever is on disk right now. Every other caller is verifying a pin that
 * already exists, and for those an absent expectation would silently disable the check that makes a
 * grant meaningful. That is why this is a separate exported name instead of an optional parameter on
 * `captureCapabilitySourceAtRoot` — "no expectation" has to be visible at the call site, not hidden in
 * an argument a caller can forget to pass.
 */
export function inspectCapabilitySourceAtRoot(rootPath: string, referencePath: string): CapturedCapabilitySource {
  return captureAtRoot(rootPath, referencePath, undefined);
}

function captureAtRoot(rootPath: string, referencePath: string, expectedSha256: string | undefined): CapturedCapabilitySource {
  const source = referencePath;
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync.native(rootPath);
  } catch (error) {
    fail("profile/io", source, `cannot resolve custody root: ${error instanceof Error ? error.message : String(error)}`);
  }
  let fd: number;
  try {
    fd = fs.openSync(canonicalRoot, fs.constants.O_RDONLY | flags(source).directory | flags(source).noFollow | flags(source).nonBlock);
  } catch (error) {
    fail("profile/io", source, `cannot open custody root: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return captureFromDirectory(fd, canonicalRoot, referencePath, expectedSha256);
  } finally {
    fs.closeSync(fd);
  }
}
