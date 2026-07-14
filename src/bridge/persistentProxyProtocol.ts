import fs from "node:fs";
import os from "node:os";
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

/** Thrown when the directory a control socket would bind inside cannot be made exclusively writable by
 *  the current user. Callers MUST treat this as fatal for the persistent proxy and fail closed to the
 *  in-process Bridge — never bind a socket in a directory this rejects (t-88ef8c security review). */
export class PersistentBridgeUnsafeRuntimeDirError extends Error {
  constructor(readonly dirPath: string, readonly reason: string) {
    super(`persistent Bridge runtime directory is unsafe, refusing to bind a socket in it: ${dirPath} (${reason})`);
    this.name = "PersistentBridgeUnsafeRuntimeDirError";
  }
}

/** Creates (or reuses) `dirPath` and enforces it is owned by, and exclusively writable by, the current
 *  user before any control socket is bound inside it. `fs.mkdirSync`'s `mode` option is SILENTLY IGNORED
 *  when the directory already exists (Node/POSIX behavior) — so a same-uid-namespace attacker who
 *  pre-creates the deterministic runtime dir (world-writable, or owned by a different uid) before this
 *  process runs would otherwise defeat the intended 0700 and swap in a hijacked control.sock, harvesting
 *  every client's Bearer token (the control protocol authenticates only the public workspace hash). A lax
 *  mode on a directory we already own is repaired in place; anything we cannot make safe (foreign-owned,
 *  or still group/other-accessible after chmod) is refused, never used. */
export function ensureSecureRuntimeDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const stat = fs.statSync(dirPath);
  if (stat.uid !== uid) {
    throw new PersistentBridgeUnsafeRuntimeDirError(dirPath, `owned by uid ${stat.uid}, expected ${uid}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    fs.chmodSync(dirPath, 0o700);
    const repaired = fs.statSync(dirPath);
    if ((repaired.mode & 0o077) !== 0) {
      throw new PersistentBridgeUnsafeRuntimeDirError(
        dirPath,
        `mode ${(repaired.mode & 0o777).toString(8)} still group/other-accessible after chmod`,
      );
    }
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
 *  (t-88ef8c: a worktree under `~/.cache/tachyon/worktrees/...` alone is already 122+ bytes). */
function persistentBridgeRuntimeBaseDir(): string {
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR?.trim();
  if (xdgRuntimeDir) return path.join(xdgRuntimeDir, "tachyon");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(os.tmpdir(), `tachyon-${uid}`);
}

/** The single writer-side derivation. Every consumer that STARTS or OWNS a daemon (PersistentBridgeService,
 *  the dogfood harness) must go through this — never re-derive the path independently. */
export function persistentBridgeDir(workspaceRoot: string): string {
  return path.join(persistentBridgeRuntimeBaseDir(), workspaceHash(workspaceRoot));
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
