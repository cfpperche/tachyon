/**
 * spec 284 — the DATA RESOLVER, the non-executable sibling of `toolLauncher.ts`'s `resolveToolForLaunch`.
 *
 * Resolves a plugin's provisioned DATA artifact to a TRUSTED absolute on-disk path, lockfile-anchored +
 * PLUGIN-SCOPED, with the same fd-enforced integrity as the tool launcher MINUS execution: open `O_NOFOLLOW`,
 * fstat (regular / owned / no foreign write / nlink==1 / NOT executable), hash THROUGH the fd vs the pinned
 * `contentSha256`. Unlike the tool resolver it does NOT hand the caller an exec fd or a launch policy — a data
 * artifact is READ, never run. The `_tachyon-data` shim (a sibling of `_tachyon-tool`) calls this and prints the
 * path; absent/corrupt → a fail-closed nonzero (never a fabricated path). The guarantee is scoped to resolve time
 * (a same-user post-resolve swap is out of scope — stated honestly, per the dueto).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseLockfile, LOCKFILE_REL_PATH } from "./lockfile.js";

/** content-addressed DATA store + the resolver shim path (sha-first per dueto D1; workspace-relative, clone-safe). */
export const DATA_STORE_REL = ".tachyon/data/sha256";
export const DATA_RESOLVER_REL = ".tachyon/bin/_tachyon-data";

export type DataResolveErrorCode =
  | "BAD_ARGS"
  | "REHYDRATE_REQUIRED"
  | "LOCKFILE_CORRUPT"
  | "PLUGIN_NOT_FOUND"
  | "DATA_NOT_FOUND"
  | "UNTRUSTED_DIR"
  | "BAD_INSTALL_PATH"
  | "OPEN_FAILED"
  | "NOT_REGULAR"
  | "OWNER_MISMATCH"
  | "WRITABLE"
  | "NLINK"
  | "EXECUTABLE"
  | "HASH_MISMATCH";

export type DataResolve =
  | { ok: true; dataPath: string; contentSha256: string }
  | { ok: false; code: DataResolveErrorCode; detail: string };

export interface DataResolveDeps {
  workspaceRoot: string;
  uid?: number;
}

function derr(code: DataResolveErrorCode, detail: string): DataResolve {
  return { ok: false, code, detail };
}

/** Assert a managed dir is a real dir (not a symlink), owned by uid/root, no group/other write. */
function dirTrusted(dir: string, uid: number): DataResolve | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return derr("UNTRUSTED_DIR", `cannot lstat ${dir}`);
  }
  if (st.isSymbolicLink()) return derr("UNTRUSTED_DIR", `${dir} is a symlink`);
  if (!st.isDirectory()) return derr("UNTRUSTED_DIR", `${dir} is not a directory`);
  if (st.uid !== 0 && st.uid !== uid) return derr("UNTRUSTED_DIR", `${dir} is owned by uid ${st.uid}`);
  if (st.mode & 0o022) return derr("UNTRUSTED_DIR", `${dir} is group/other writable`);
  return null;
}

/** sha256 of the bytes read THROUGH an already-open fd (positional reads). */
function hashFd(fd: number): string {
  const h = crypto.createHash("sha256");
  const buf = Buffer.alloc(64 * 1024);
  let pos = 0;
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, pos);
    if (n <= 0) break;
    h.update(buf.subarray(0, n));
    pos += n;
  }
  return h.digest("hex");
}

/**
 * Resolve + validate a plugin's DATA artifact, lockfile-anchored + PLUGIN-SCOPED. Returns the trusted absolute
 * path (the caller READS it; no fd is handed out — data is never exec'd), or a typed fail-closed error.
 */
export function resolveDataForAccess(pluginName: string, dataName: string, deps: DataResolveDeps): DataResolve {
  if (typeof pluginName !== "string" || pluginName.length === 0) return derr("BAD_ARGS", "missing plugin name");
  if (typeof dataName !== "string" || dataName.length === 0) return derr("BAD_ARGS", "missing data name");
  const uid = deps.uid ?? process.getuid?.() ?? 0;

  const lockPath = path.join(deps.workspaceRoot, LOCKFILE_REL_PATH);
  if (!fs.existsSync(lockPath)) return derr("REHYDRATE_REQUIRED", `${LOCKFILE_REL_PATH} is absent — run Tachyon to rehydrate this workspace's data`);
  const parsed = parseLockfile(fs.readFileSync(lockPath, "utf8"));
  if (!parsed.lockfile) return derr("LOCKFILE_CORRUPT", parsed.errors[0] ?? "unparseable lockfile");

  // PLUGIN-SCOPED: only THIS plugin's data artifacts, by name (unique within a plugin's manifest).
  const lock = parsed.lockfile.plugins[pluginName];
  if (!lock) return derr("PLUGIN_NOT_FOUND", `plugin '${pluginName}' is not installed in this workspace`);
  const d = (lock.data ?? []).find((x) => x.name === dataName);
  if (!d) return derr("DATA_NOT_FOUND", `plugin '${pluginName}' provisions no data artifact named '${dataName}'`);

  // the store's home must be locked down (protects the content-addressed blobs).
  for (const dir of [path.join(deps.workspaceRoot, ".tachyon"), path.join(deps.workspaceRoot, ".tachyon", "data")]) {
    const bad = dirTrusted(dir, uid);
    if (bad) return bad;
  }

  // the install path must equal the sha-first content address (no rebinding to an arbitrary file).
  const expectRel = path.posix.join(DATA_STORE_REL, d.contentSha256, d.fileName);
  if (d.installPath !== expectRel) return derr("BAD_INSTALL_PATH", `installPath '${d.installPath}' != content-address '${expectRel}'`);
  const abs = path.join(deps.workspaceRoot, d.installPath);

  // open O_NOFOLLOW, fstat, hash THROUGH the fd — then close (the data is read by the caller via the printed path).
  let fd: number;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    return derr("OPEN_FAILED", `cannot open ${abs} (O_NOFOLLOW): ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return derr("NOT_REGULAR", `${abs} is not a regular file`);
    if (st.uid !== 0 && st.uid !== uid) return derr("OWNER_MISMATCH", `${abs} is owned by uid ${st.uid}`);
    if (st.mode & 0o022) return derr("WRITABLE", `${abs} is group/other writable`);
    if (st.nlink !== 1) return derr("NLINK", `${abs} has link-count ${st.nlink} (expected 1)`);
    if (st.mode & 0o111) return derr("EXECUTABLE", `${abs} must not be executable (a data artifact is read, never run)`);
    const h = hashFd(fd);
    if (h !== d.contentSha256) return derr("HASH_MISMATCH", `${abs} hash ${h} != pinned ${d.contentSha256}`);
    return { ok: true, dataPath: abs, contentSha256: d.contentSha256 };
  } finally {
    fs.closeSync(fd);
  }
}
