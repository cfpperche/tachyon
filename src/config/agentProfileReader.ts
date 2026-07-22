import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { isValidAgentName } from "./nameValidation.js";
import {
  AGENT_PROFILE_MAX_BYTES,
  AGENT_PROFILE_REFERENCE_MAX_BYTES,
  agentProfileRelativePathError,
} from "./agentProfileSchema.js";

export type AgentProfileReadErrorCode =
  | "profile/invalid-path"
  | "profile/unsupported-custody"
  | "profile/unsafe-path"
  | "profile/missing-reference"
  | "profile/not-regular"
  | "profile/too-large"
  | "profile/changed-during-read"
  | "profile/invalid-utf8"
  | "profile/digest-mismatch"
  | "profile/io";

export class AgentProfileReadError extends Error {
  constructor(
    readonly code: AgentProfileReadErrorCode,
    readonly source: string,
    detail: string,
  ) {
    super(`${code}: ${source}: ${detail}`);
    this.name = "AgentProfileReadError";
  }
}

export interface BoundAgentProfileFile {
  /** Stable source label relative to the workspace or profile. */
  source: string;
  absolutePath: string;
  bytes: Buffer;
  text: string;
  sha256: string;
}

export interface CanonicalAgentProfileSource extends BoundAgentProfileFile {
  workspaceRoot: string;
  profileRoot: string;
  /** Descriptor retained so every local reference stays under the exact directory that declared it. */
  profileDirectoryFd: number;
}

function fail(code: AgentProfileReadErrorCode, source: string, detail: string): never {
  throw new AgentProfileReadError(code, source, detail);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // Preserve the original validation/read failure.
  }
}

function requireCustodyFlags(source: string): { noFollow: number; directory: number; nonBlock: number } {
  const noFollow = fs.constants.O_NOFOLLOW;
  const directory = fs.constants.O_DIRECTORY;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (typeof noFollow !== "number" || typeof directory !== "number" || typeof nonBlock !== "number") {
    fail("profile/unsupported-custody", source, "platform does not expose O_NOFOLLOW, O_DIRECTORY and O_NONBLOCK");
  }
  return { noFollow, directory, nonBlock };
}

function canonicalDirectory(value: string, source: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(value);
  } catch (error) {
    fail("profile/io", source, `cannot resolve directory: ${errorText(error)}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonical);
  } catch (error) {
    fail("profile/io", source, `cannot inspect directory: ${errorText(error)}`);
  }
  if (!stat.isDirectory()) fail("profile/not-regular", source, "must be a directory");
  return canonical;
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

/**
 * Node does not expose openat/openat2. Linux `/proc/self/fd/<fd>` (and the
 * equivalent `/dev/fd/<fd>` where supported) gives pathname syntax rooted at a
 * retained directory descriptor. We verify the descriptor identity before use
 * and fail closed when neither mechanism exists.
 */
function descriptorPath(fd: number, source: string): string {
  const expected = fs.fstatSync(fd, { bigint: true });
  for (const root of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = `${root}/${fd}`;
    try {
      const actual = fs.statSync(candidate, { bigint: true });
      if (sameIdentity(expected, actual)) return candidate;
    } catch {
      // Try the next host-supported descriptor filesystem.
    }
  }
  fail("profile/unsupported-custody", source, "host has no verified descriptor-relative filesystem path");
}

function openRootDirectory(root: string, source: string): number {
  const flags = requireCustodyFlags(source);
  let fd: number;
  try {
    fd = fs.openSync(root, fs.constants.O_RDONLY | flags.directory | flags.noFollow | flags.nonBlock);
  } catch (error) {
    fail("profile/io", source, `cannot open canonical root descriptor: ${errorText(error)}`);
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory()) fail("profile/not-regular", source, "canonical root must remain a directory");
    descriptorPath(fd, source);
    return fd;
  } catch (error) {
    closeQuietly(fd);
    throw error;
  }
}

function classifyOpenError(candidate: string, source: string, error: unknown, missingIsAbsent: boolean): undefined {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" && missingIsAbsent) return undefined;
  if (code === "ENOENT") fail("profile/missing-reference", source, "does not exist");
  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) fail("profile/unsafe-path", source, "must not traverse a symbolic link");
    if (!stat.isDirectory() && !stat.isFile()) fail("profile/not-regular", source, "must be a regular file or directory of the expected kind");
  } catch (inspectError) {
    if (inspectError instanceof AgentProfileReadError) throw inspectError;
    if ((inspectError as NodeJS.ErrnoException).code === "ENOENT" && missingIsAbsent) return undefined;
  }
  fail("profile/io", source, `cannot open descriptor-relative path: ${errorText(error)}`);
}

function openChildDirectory(parentFd: number, segment: string, source: string, missingIsAbsent: boolean): number | undefined {
  const flags = requireCustodyFlags(source);
  const candidate = `${descriptorPath(parentFd, source)}/${segment}`;
  let fd: number;
  try {
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | flags.directory | flags.noFollow | flags.nonBlock);
  } catch (error) {
    return classifyOpenError(candidate, source, error, missingIsAbsent);
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory()) fail("profile/not-regular", source, `path component ${JSON.stringify(segment)} must be a directory`);
    descriptorPath(fd, source);
    return fd;
  } catch (error) {
    closeQuietly(fd);
    throw error;
  }
}

function duplicateDirectory(fd: number, source: string): number {
  const flags = requireCustodyFlags(source);
  const original = fs.fstatSync(fd, { bigint: true });
  let duplicate: number;
  try {
    // The descriptor filesystem entry itself is a host-owned symlink to the
    // retained descriptor, so O_NOFOLLOW applies only to descendants, not here.
    duplicate = fs.openSync(descriptorPath(fd, source), fs.constants.O_RDONLY | flags.directory | flags.nonBlock);
  } catch (error) {
    fail("profile/unsupported-custody", source, `cannot duplicate directory descriptor: ${errorText(error)}`);
  }
  try {
    const opened = fs.fstatSync(duplicate, { bigint: true });
    if (!opened.isDirectory() || !sameIdentity(original, opened)) {
      fail("profile/changed-during-read", source, "directory descriptor identity changed while duplicated");
    }
    return duplicate;
  } catch (error) {
    closeQuietly(duplicate);
    throw error;
  }
}

function decodeUtf8(bytes: Buffer, source: string): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) fail("profile/invalid-utf8", source, "must not contain NUL bytes");
    return text;
  } catch (error) {
    if (error instanceof AgentProfileReadError) throw error;
    fail("profile/invalid-utf8", source, `must contain valid UTF-8: ${errorText(error)}`);
  }
}

function readBoundFileAt(
  parentFd: number,
  leaf: string,
  source: string,
  absolutePath: string,
  maxBytes: number,
  missingIsAbsent: boolean,
): BoundAgentProfileFile | undefined {
  const flags = requireCustodyFlags(source);
  const candidate = `${descriptorPath(parentFd, source)}/${leaf}`;
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(candidate, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && missingIsAbsent) return undefined;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("profile/missing-reference", source, "does not exist");
    fail("profile/io", source, `cannot inspect descriptor-relative file: ${errorText(error)}`);
  }
  if (before.isSymbolicLink()) fail("profile/unsafe-path", source, "must not be a symbolic link");
  if (!before.isFile()) fail("profile/not-regular", source, "must be a regular file");
  if (before.size > BigInt(maxBytes)) fail("profile/too-large", source, `exceeds ${maxBytes} bytes`);

  let fd: number;
  try {
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | flags.noFollow | flags.nonBlock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && missingIsAbsent) return undefined;
    classifyOpenError(candidate, source, error, missingIsAbsent);
    return undefined;
  }

  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile()) fail("profile/not-regular", source, "must remain a regular file when opened");
    if (!sameIdentity(before, opened)) fail("profile/changed-during-read", source, "changed while it was opened");
    if (opened.size > BigInt(maxBytes)) fail("profile/too-large", source, `exceeds ${maxBytes} bytes`);

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      let count: number;
      try {
        count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      } catch (error) {
        fail("profile/io", source, `cannot read validated descriptor: ${errorText(error)}`);
      }
      if (count === 0) break;
      offset += count;
    }
    if (offset > maxBytes) fail("profile/too-large", source, `exceeds ${maxBytes} bytes`);

    let afterDescriptor: fs.BigIntStats;
    let afterPath: fs.BigIntStats;
    try {
      afterDescriptor = fs.fstatSync(fd, { bigint: true });
      afterPath = fs.lstatSync(candidate, { bigint: true });
    } catch (error) {
      fail("profile/changed-during-read", source, `changed while final identity was checked: ${errorText(error)}`);
    }
    if (afterPath.isSymbolicLink() || !sameRevision(opened, afterDescriptor) || !sameIdentity(opened, afterPath)) {
      fail("profile/changed-during-read", source, "changed while bytes were consumed");
    }

    const bytes = Buffer.from(buffer.subarray(0, offset));
    return {
      source,
      absolutePath,
      bytes,
      text: decodeUtf8(bytes, source),
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Resolve the conventional canonical profile through retained directory
 * descriptors. Missing profile directories/files are an ordinary "no canonical
 * owner" result; unsafe existing paths remain errors.
 */
export function readCanonicalAgentProfile(workspaceRoot: string, agentName: string): CanonicalAgentProfileSource | undefined {
  if (!isValidAgentName(agentName)) fail("profile/invalid-path", `agent ${JSON.stringify(agentName)}`, "invalid agent name");
  const root = canonicalDirectory(workspaceRoot, "workspace root");
  const source = `.tachyon/agents/${agentName}/agent.yml`;
  let currentFd = openRootDirectory(root, source);
  try {
    for (const segment of [".tachyon", "agents", agentName]) {
      const child = openChildDirectory(currentFd, segment, source, true);
      if (child === undefined) return undefined;
      const parentFd = currentFd;
      currentFd = child;
      closeQuietly(parentFd);
    }
    const profileRoot = path.join(root, ".tachyon", "agents", agentName);
    const file = readBoundFileAt(currentFd, "agent.yml", source, path.join(profileRoot, "agent.yml"), AGENT_PROFILE_MAX_BYTES, true);
    if (!file) return undefined;
    const retainedFd = currentFd;
    currentFd = -1;
    return { ...file, workspaceRoot: root, profileRoot, profileDirectoryFd: retainedFd };
  } finally {
    if (currentFd >= 0) closeQuietly(currentFd);
  }
}

export function closeCanonicalAgentProfile(source: CanonicalAgentProfileSource): void {
  if (source.profileDirectoryFd < 0) return;
  const fd = source.profileDirectoryFd;
  source.profileDirectoryFd = -1;
  closeQuietly(fd);
}

/** Read one pinned profile-local reference under the retained profile descriptor. */
export function readAgentProfileReference(
  source: CanonicalAgentProfileSource,
  referencePath: string,
  expectedSha256: string,
): BoundAgentProfileFile {
  const reason = agentProfileRelativePathError(referencePath);
  if (reason) fail("profile/invalid-path", referencePath, reason);
  if (source.profileDirectoryFd < 0) fail("profile/changed-during-read", referencePath, "profile directory descriptor is already closed");
  const segments = referencePath.split("/");
  const leaf = segments.pop()!;
  let currentFd = duplicateDirectory(source.profileDirectoryFd, referencePath);
  try {
    for (const segment of segments) {
      const child = openChildDirectory(currentFd, segment, referencePath, false)!;
      const parentFd = currentFd;
      currentFd = child;
      closeQuietly(parentFd);
    }
    const file = readBoundFileAt(currentFd, leaf, referencePath, path.join(source.profileRoot, ...referencePath.split("/")), AGENT_PROFILE_REFERENCE_MAX_BYTES, false)!;
    if (file.sha256 !== expectedSha256) {
      fail("profile/digest-mismatch", referencePath, `expected ${expectedSha256}, consumed ${file.sha256}`);
    }
    return file;
  } finally {
    closeQuietly(currentFd);
  }
}
