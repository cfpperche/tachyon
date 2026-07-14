import fs from "node:fs";
import path from "node:path";
import { workspaceHash } from "../tmux/TmuxService.js";

export const PERSISTENT_BRIDGE_PROTOCOL = 1;

/** Linux AF_UNIX `sun_path` is 108 bytes (macOS 104), including the NUL terminator. Stay well under the
 *  tightest real limit so a derived path never risks the raw, undiagnosable connect() EINVAL that this
 *  guard exists to prevent (t-88ef8c). */
export const MAX_CONTROL_SOCKET_PATH_BYTES = 100;

export class PersistentBridgeSocketPathError extends Error {
  constructor(readonly socketPath: string, readonly byteLength: number) {
    super(
      `persistent Bridge control socket path is ${byteLength} bytes, exceeding the ${MAX_CONTROL_SOCKET_PATH_BYTES}-byte AF_UNIX sun_path budget: ${socketPath}`,
    );
    this.name = "PersistentBridgeSocketPathError";
  }
}

/** Thrown when the directory a control socket would bind inside cannot be trusted to be private to the
 *  current user. Callers MUST treat this as fatal for the persistent proxy and fail closed to the
 *  in-process Bridge — never bind a socket in a directory this rejects (t-88ef8c security review). */
export class PersistentBridgeUnsafeRuntimeDirError extends Error {
  constructor(readonly dirPath: string, readonly reason: string) {
    super(`persistent Bridge runtime directory is unsafe, refusing to bind a socket in it: ${dirPath} (${reason})`);
    this.name = "PersistentBridgeUnsafeRuntimeDirError";
  }
}

/** Thrown when there is no OS-private location to derive the persistent Bridge runtime dir from at all.
 *  Callers MUST treat this as fatal and fail closed to the in-process Bridge (t-88ef8c security review). */
export class PersistentBridgeUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`persistent Bridge is unavailable: ${reason}`);
    this.name = "PersistentBridgeUnavailableError";
  }
}

/** Creates (or reuses) `dirPath` and REFUSES it outright unless it is a real directory (not a symlink —
 *  `fs.mkdirSync`'s recursive mode silently no-ops on an existing symlink-to-directory, and a naive
 *  `statSync` follows symlinks, so only `lstatSync` on the leaf itself is trustworthy), owned by the
 *  current user, and exclusively user-accessible (`mode & 0o077 === 0`). No repair path: a directory that
 *  fails this check is never made safe in place (t-88ef8c round 2 — the round-1 chmod-repair was itself a
 *  TOCTOU gap), the caller must fail closed instead. */
export function ensureSecureRuntimeDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const stat = fs.lstatSync(dirPath);
  if (!stat.isDirectory()) {
    throw new PersistentBridgeUnsafeRuntimeDirError(dirPath, "not a real directory (symlink or other non-directory entry)");
  }
  if (stat.uid !== uid) {
    throw new PersistentBridgeUnsafeRuntimeDirError(dirPath, `owned by uid ${stat.uid}, expected ${uid}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new PersistentBridgeUnsafeRuntimeDirError(dirPath, `mode ${(stat.mode & 0o777).toString(8)} is group/other-accessible`);
  }
}

export interface PersistentBridgeDescriptor {
  protocol: number;
  workspaceHash: string;
  workspaceRoot: string;
  instanceId: string;
  pid: number;
  port: number;
  controlSocket: string;
  startedAt: string;
}

export type PersistentBridgeControlRequest =
  | { op: "health"; workspaceHash: string }
  | { op: "register"; workspaceHash: string; backendPort: number }
  | { op: "detach"; workspaceHash: string; backendPort: number }
  | { op: "stop"; workspaceHash: string };

export type PersistentBridgeControlResponse =
  | { ok: true; descriptor: PersistentBridgeDescriptor; backendPort?: number }
  | { ok: false; code: string; message: string };

/** Outside the workspace, keyed only by the 8-hex-char workspace hash — never the workspace path itself —
 *  so a control socket underneath it can never grow past `sun_path` no matter how deep the checkout lives
 *  (t-88ef8c: a worktree under `~/.cache/tachyon/worktrees/...` alone is already 122+ bytes).
 *
 *  ONLY `$XDG_RUNTIME_DIR/tachyon` — pam_systemd guarantees `$XDG_RUNTIME_DIR` (`/run/user/<uid>`) is a
 *  0700 tmpfs private to the current user, so nothing beneath it is attacker-creatable. There is
 *  deliberately NO `os.tmpdir()` fallback (t-88ef8c round 2): a `/tmp`-rooted path is a world-writable
 *  sticky dir whose PARENT (not just the leaf) any local user can pre-create, which let an attacker plant
 *  a hijacked control.sock underneath a leaf that still passed a leaf-only permission check (security
 *  re-review j-d0f57760d567, findings #1/#3). When there is no private runtime dir to use, the persistent
 *  proxy is simply unavailable — the caller must fail closed to the in-process Bridge, never bind here. */
function persistentBridgeRuntimeBaseDir(): string {
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR?.trim();
  if (!xdgRuntimeDir) {
    throw new PersistentBridgeUnavailableError(
      "XDG_RUNTIME_DIR is not set — no OS-private per-user runtime directory to bind the control socket in",
    );
  }
  return path.join(xdgRuntimeDir, "tachyon");
}

/** The single writer-side derivation. Every consumer that STARTS or OWNS a daemon (PersistentBridgeService,
 *  the dogfood harness) must go through this — never re-derive the path independently. Pure (no fs access)
 *  so read-only/length-check callers can use it without side effects; throws PersistentBridgeUnavailableError
 *  when there is no private runtime dir (see persistentBridgeRuntimeBaseDir). */
export function persistentBridgeDir(workspaceRoot: string): string {
  return path.join(persistentBridgeRuntimeBaseDir(), workspaceHash(workspaceRoot));
}

/** The single BINDING choke point: every consumer that is about to create/own a control socket (as
 *  opposed to merely computing where one would live) must go through this instead of mkdir'ing
 *  `persistentBridgeDir()` directly. Validates both the shared `tachyon` base dir and the per-workspace
 *  leaf beneath it — each must be a real, current-user-owned, exclusively-accessible directory — before
 *  returning the leaf path a socket may bind inside (t-88ef8c round 2, j-2cf52fee3827). */
export function ensureSecurePersistentBridgeDir(workspaceRoot: string): string {
  const base = persistentBridgeRuntimeBaseDir();
  ensureSecureRuntimeDir(base);
  const leaf = path.join(base, workspaceHash(workspaceRoot));
  ensureSecureRuntimeDir(leaf);
  return leaf;
}

export function persistentBridgeDescriptorPath(workspaceRoot: string): string {
  return path.join(persistentBridgeDir(workspaceRoot), "service.json");
}

export function persistentBridgeControlSocket(workspaceRoot: string): string {
  const socketPath = path.join(persistentBridgeDir(workspaceRoot), "control.sock");
  const byteLength = Buffer.byteLength(socketPath, "utf8");
  if (byteLength > MAX_CONTROL_SOCKET_PATH_BYTES) throw new PersistentBridgeSocketPathError(socketPath, byteLength);
  return socketPath;
}

/** Pre-t-88ef8c in-workspace location. Never written by this build — read-only, so a daemon started by an
 *  older extension build stays reachable (and isn't duplicated) until it naturally stops. */
export function legacyPersistentBridgeControlSocket(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "bridge-service", "control.sock");
}

/** The single reader-side resolver: every caller that needs to FIND a running daemon (as opposed to
 *  starting one) goes through this — new short path first, old in-workspace path second — so there is
 *  exactly one place that knows both locations. */
export function resolvePersistentBridgeControlSocket(workspaceRoot: string): string {
  const primary = persistentBridgeControlSocket(workspaceRoot);
  if (!fs.existsSync(primary)) {
    const legacy = legacyPersistentBridgeControlSocket(workspaceRoot);
    if (fs.existsSync(legacy)) return legacy;
  }
  return primary;
}

export function isPersistentBridgeDescriptor(value: unknown): value is PersistentBridgeDescriptor {
  if (!value || typeof value !== "object") return false;
  const d = value as Partial<PersistentBridgeDescriptor>;
  return d.protocol === PERSISTENT_BRIDGE_PROTOCOL
    && typeof d.workspaceHash === "string"
    && typeof d.workspaceRoot === "string"
    && typeof d.instanceId === "string"
    && Number.isSafeInteger(d.pid) && (d.pid ?? 0) > 0
    && Number.isSafeInteger(d.port) && (d.port ?? 0) > 0 && (d.port ?? 0) <= 65_535
    && typeof d.controlSocket === "string"
    && typeof d.startedAt === "string";
}
