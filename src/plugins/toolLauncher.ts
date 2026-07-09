/**
 * spec 265 task 7 — the tool LAUNCHER (runtime trust enforcement). A provisioned tool is invoked through
 * `_tachyon-tool <name> <args...>`, NEVER by its raw install path, so the binary is re-validated against the
 * lockfile pin before EVERY exec (a git pre-commit hook from spec 264 fires this with no VS Code running).
 *
 * Trust model (task-0 gate (b), codex task-7 review folded):
 *  - The integrity-bearing code is the EXTENSION-BUNDLED validator (this module, shipped as `dist/tool-launcher.cjs`
 *    and copied to `.tachyon/bin/_tachyon-tool.js` on every managed op). The on-disk shim is NOT a trust root.
 *  - The LOCKFILE is the single source of truth (no `tools.json` in the hot path). Absent lockfile → hard fail
 *    `REHYDRATE_REQUIRED` (a clone/CI must rehydrate, never trust a derived cache).
 *  - Two validators by source: `fetched` asserts the content-address shape + nlink==1; `host-provided` asserts
 *    the recorded absolute realpath + full-path ownership trust (no nlink==1 — package managers hardlink).
 *  - Both: open `O_NOFOLLOW`, fstat (regular file, owner==uid, no group/other write), hash THROUGH the fd vs the
 *    lockfile binSha256. Mismatch → fail closed (blocks the commit).
 *  - Exec: Linux NATIVE binaries via "procfd exec" (`/proc/self/fd/3` with the validated fd mapped to child fd 3
 *    — the executed image IS the validated inode, closing the path-reopen race); scripts + macOS use best-effort
 *    re-stat-then-path exec. Honest: exec-time rehash defends cross-user + accidental corruption, NOT a same-uid
 *    attacker (out of scope, gate b/H2).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseLockfile, LOCKFILE_REL_PATH } from "./lockfile.js";
import { sha256File, isTrustedExecPath, type PathStat } from "./toolProvisioning.js";
import type { ToolLaunchPolicy } from "./manifest.js";
import { runI18nPtbrStagedGate } from "./i18nPtbrGate.js";
import { appendExternalToolEvent } from "../externalTools/events.js";
import { isLauncherExternalToolKind } from "../externalTools/filters.js";
import type { ExternalToolKind } from "../externalTools/types.js";

export const TACHYON_BIN_REL = ".tachyon/bin";

export type LaunchErrorCode =
  | "BAD_ARGS"
  | "REHYDRATE_REQUIRED"
  | "LOCKFILE_CORRUPT"
  | "PLUGIN_NOT_FOUND"
  | "TOOL_NOT_FOUND"
  | "UNTRUSTED_DIR"
  | "BAD_INSTALL_PATH"
  | "OPEN_FAILED"
  | "NOT_REGULAR"
  | "OWNER_MISMATCH"
  | "WRITABLE"
  | "NLINK"
  | "HASH_MISMATCH"
  | "UNTRUSTED_HOST_PATH"
  | "POLICY_CONFLICT"
  | "CONFIG_MISSING";

export interface ResolveOk {
  ok: true;
  /** the validated absolute path of the executable. */
  execPath: string;
  /** the still-OPEN, O_NOFOLLOW, hash-verified fd (the caller execs it then closes it). */
  fd: number;
  source: "fetched" | "host-provided";
  binSha256: string;
  /** spec 269 — the lockfile-consented launch policy the launcher enforces (forced env/args, refused args). */
  launchPolicy?: ToolLaunchPolicy;
  /** spec 270/271 — absolute path of the plugin's human-owned config file, resolved when the policy declares a
   *  `configArg` AND the plugin records a `config`. The launcher feeds it as `<configArg> <configPath>`. */
  configPath?: string;
}
export interface ResolveErr {
  ok: false;
  code: LaunchErrorCode;
  detail: string;
}
export type Resolve = ResolveOk | ResolveErr;

export interface ResolveDeps {
  workspaceRoot: string;
  uid?: number;
  /** injectable stat for host-path ancestor trust (defaults to fs.statSync). */
  statPath?: (p: string) => PathStat | null;
}

function rerr(code: LaunchErrorCode, detail: string): ResolveErr {
  return { ok: false, code, detail };
}

/** Assert a managed dir is a real dir (not a symlink), owned by uid/root, with no group/other write. */
function dirTrusted(dir: string, uid: number): { ok: true } | ResolveErr {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return rerr("UNTRUSTED_DIR", `cannot lstat ${dir}`);
  }
  if (st.isSymbolicLink()) return rerr("UNTRUSTED_DIR", `${dir} is a symlink`);
  if (!st.isDirectory()) return rerr("UNTRUSTED_DIR", `${dir} is not a directory`);
  if (st.uid !== 0 && st.uid !== uid) return rerr("UNTRUSTED_DIR", `${dir} is owned by uid ${st.uid}`);
  if (st.mode & 0o022) return rerr("UNTRUSTED_DIR", `${dir} is group/other writable`);
  return { ok: true };
}

/** sha256 of the bytes read THROUGH an already-open fd (positional reads; does not disturb a later pread). */
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
 * Resolve + validate a tool for launch, lockfile-anchored + PLUGIN-SCOPED (codex task-10 review B). Resolution
 * is scoped to `plugins[pluginName].tools[]` ONLY — a later plugin installing a same-named tool can never hijack
 * another plugin's hook, and there is no cross-plugin ambiguity. Returns the validated open fd + path, or a
 * typed fail-closed error. The caller execs the fd then closes it.
 */
export function resolveToolForLaunch(pluginName: string, toolName: string, deps: ResolveDeps): Resolve {
  if (typeof pluginName !== "string" || pluginName.length === 0) return rerr("BAD_ARGS", "missing plugin name");
  if (typeof toolName !== "string" || toolName.length === 0) return rerr("BAD_ARGS", "missing tool name");
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const statPath = deps.statPath;

  const lockPath = path.join(deps.workspaceRoot, LOCKFILE_REL_PATH);
  if (!fs.existsSync(lockPath)) return rerr("REHYDRATE_REQUIRED", `${LOCKFILE_REL_PATH} is absent — run Tachyon to rehydrate this workspace's tools`);
  const parsed = parseLockfile(fs.readFileSync(lockPath, "utf8"));
  if (!parsed.lockfile) return rerr("LOCKFILE_CORRUPT", parsed.errors[0] ?? "unparseable lockfile");

  // PLUGIN-SCOPED resolution: only THIS plugin's tools, by name (unique within a plugin's manifest).
  const lock = parsed.lockfile.plugins[pluginName];
  if (!lock) return rerr("PLUGIN_NOT_FOUND", `plugin '${pluginName}' is not installed in this workspace`);
  const tool = (lock.tools ?? []).find((t) => t.name === toolName);
  if (!tool) return rerr("TOOL_NOT_FOUND", `plugin '${pluginName}' provisions no tool named '${toolName}'`);

  // the launcher's own home must be locked down (protects the shim + validator copy).
  const binDir = path.join(deps.workspaceRoot, TACHYON_BIN_REL);
  for (const d of [path.join(deps.workspaceRoot, ".tachyon"), binDir]) {
    const t = dirTrusted(d, uid);
    if (!t.ok) return t;
  }

  // resolve + shape-check the absolute exec path by source.
  let abs: string;
  if (tool.source === "fetched") {
    const expectRel = path.posix.join(TACHYON_BIN_REL, tool.name, tool.binSha256, tool.exeName);
    if (tool.installPath !== expectRel) return rerr("BAD_INSTALL_PATH", `fetched installPath '${tool.installPath}' != content-address '${expectRel}'`);
    abs = path.join(deps.workspaceRoot, tool.installPath);
  } else {
    abs = tool.installPath; // absolute host realpath (recorded at detect)
    if (!path.isAbsolute(abs)) return rerr("BAD_INSTALL_PATH", `host-provided installPath is not absolute: ${abs}`);
    const trust = isTrustedExecPath(abs, uid, statPath ?? ((p) => { try { return fs.statSync(p); } catch { return null; } }));
    if (!trust.trusted) return rerr("UNTRUSTED_HOST_PATH", trust.reason ?? "untrusted host path");
  }

  // open O_NOFOLLOW, fstat, hash THROUGH the fd.
  let fd: number;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    return rerr("OPEN_FAILED", `cannot open ${abs} (O_NOFOLLOW): ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return rerr("NOT_REGULAR", `${abs} is not a regular file`);
    if (st.uid !== 0 && st.uid !== uid) return rerr("OWNER_MISMATCH", `${abs} is owned by uid ${st.uid}`);
    if (st.mode & 0o022) return rerr("WRITABLE", `${abs} is group/other writable`);
    if (tool.source === "fetched" && st.nlink !== 1) return rerr("NLINK", `${abs} has link-count ${st.nlink} (expected 1)`);
    const h = hashFd(fd);
    if (h !== tool.binSha256) {
      if (tool.source === "host-provided") return rerr("HASH_MISMATCH", `host tool ${abs} changed (hash ${h} != pinned ${tool.binSha256}) — run Tachyon repair/rehydrate to consent to the new binary`);
      return rerr("HASH_MISMATCH", `${abs} hash ${h} != pinned ${tool.binSha256}`);
    }
    const okFd = fd;
    fd = -1; // hand ownership to the caller
    // spec 270/271 — resolve the plugin's human-owned config path when the policy feeds it via a configArg.
    const configPath = tool.launchPolicy?.configArg && lock.config?.file ? path.join(deps.workspaceRoot, lock.config.file) : undefined;
    return { ok: true, execPath: abs, fd: okFd, source: tool.source, binSha256: tool.binSha256, ...(tool.launchPolicy ? { launchPolicy: tool.launchPolicy } : {}), ...(configPath ? { configPath } : {}) };
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
}

export interface LaunchResult {
  status: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Exec the validated tool. Linux NATIVE (ELF) binaries go through procfd exec (`/proc/self/fd/3`, the validated
 * fd mapped to child fd 3 — the executed image is the validated inode, immune to a path swap). Scripts + non-Linux
 * fall back to best-effort path exec. The caller still owns + closes `r.fd`.
 */
export function launchTool(r: ResolveOk, args: string[], opts: { captureOutput?: boolean; env?: NodeJS.ProcessEnv } = {}): LaunchResult {
  const magic = Buffer.alloc(4);
  try {
    fs.readSync(r.fd, magic, 0, 4, 0);
  } catch {
    /* fall through to path exec */
  }
  const isElf = magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46;
  const out = opts.captureOutput ? "pipe" : "inherit";
  // argv0 = the tool's real program name (= basename of the validated path) so multicall binaries
  // (busybox/coreutils) dispatch the right applet — `/proc/self/fd/3` as argv0 would break them.
  const argv0 = path.basename(r.execPath);
  // spec 269 — when a launch policy forces env, the launcher passes an EXPLICIT env (so the policy values win
  // regardless of the parent env); otherwise spawn inherits (env undefined).
  const envOpt = opts.env ? { env: opts.env } : {};

  let res;
  if (process.platform === "linux" && isElf) {
    // map the validated fd to child fd 3; exec /proc/self/fd/3 (resolved in the CHILD).
    res = spawnSync("/proc/self/fd/3", args, { stdio: ["inherit", out, out, r.fd], encoding: "utf8", argv0, ...envOpt });
  } else {
    res = spawnSync(r.execPath, args, { stdio: ["inherit", out, out], encoding: "utf8", argv0, ...envOpt });
  }
  const status = res.status ?? (res.signal ? 1 : 0);
  return { status, ...(opts.captureOutput ? { stdout: res.stdout ?? "", stderr: res.stderr ?? "" } : {}) };
}

function failExit(code: LaunchErrorCode): number {
  // a pre-commit hook treats any non-zero as a block; REHYDRATE_REQUIRED gets a distinct, recognizable code.
  return code === "REHYDRATE_REQUIRED" ? 78 : 1;
}

function launcherToolKind(pluginName: string, toolName: string): ExternalToolKind {
  const label = `${pluginName} ${toolName}`.toLowerCase();
  if (label.includes("browser") || label.includes("chrome") || label.includes("chromium") || label.includes("edge")) return "browser";
  if (label.includes("desktop")) return "desktop";
  if (label.includes("screen")) return "screen";
  return "unknown";
}

/** The CLI entry: resolve → exec → exit code. Stderr carries an actionable message on failure. Invoked as
 *  `_tachyon-tool <pluginName> <toolName> [args...]` — plugin-scoped (codex task-10 review B). */
export function runLauncher(argv: string[], deps: ResolveDeps): number {
  if (argv[0] === "tachyon-core" && argv[1] === "i18n-ptbr-staged") {
    return runI18nPtbrStagedGate({ workspaceRoot: deps.workspaceRoot });
  }
  if (argv.length < 2) {
    process.stderr.write("tachyon-tool: usage: _tachyon-tool <plugin> <tool> [args...] | tachyon-core i18n-ptbr-staged\n");
    return 2;
  }
  const [pluginName, toolName, ...rest] = argv;
  const r = resolveToolForLaunch(pluginName, toolName, deps);
  if (!r.ok) {
    process.stderr.write(`tachyon-tool: ${r.code}: ${r.detail}\n`);
    return failExit(r.code);
  }
  const agent = process.env.TACHYON_AGENT_NAME;
  const now = new Date().toISOString();
  const kind = launcherToolKind(pluginName, toolName);
  if (agent && isLauncherExternalToolKind(kind)) {
    appendExternalToolEvent(deps.workspaceRoot, {
      event: "launch",
      agent,
      kind,
      tool: `${pluginName}/${toolName}`,
      source: "tool-launcher",
      confidence: "strong",
      sessionId: `ets-${crypto.createHash("sha256").update(`${agent}\0${pluginName}\0${toolName}\0${now}`).digest("hex").slice(0, 10)}`,
      startedAt: now,
      lastSeenAt: now,
      state: "active",
    });
  }
  // spec 269 — enforce the consented launch policy: refuse a conflicting agent arg (fail CLOSED — never trust the
  // tool's flag-vs-env precedence), then apply forced args + an explicit forced env. Enforced only on THIS path
  // (the launcher); a same-user agent that re-execs the raw bytes is out of scope (see spec 269).
  let args = rest;
  let env: NodeJS.ProcessEnv | undefined;
  const policy = r.launchPolicy;
  if (policy) {
    // The set of flags the agent may NOT pass = the plugin's explicit denyArgs PLUS the flag NAMES the policy
    // forces (so a forced `--foo bar` can't be neutralized by the agent appending its own `--foo baz` — forced
    // args are PREPENDED and a last-wins CLI would otherwise let the later value win). The launcher only knows the
    // flags it is told about; aliases/short-forms of the same option (incl. a compact `-Ipath`-style short option
    // with an attached value) remain the plugin author's responsibility to list in denyArgs (the gate is "enforced
    // via the launcher for the declared flags", per spec 269). We derive long/`--flag=value` forms here.
    // spec 270/271 — the launcher feeds the plugin's human-owned config via `<configArg> <configPath>` (forced,
    // PREPENDED so a tool that takes last-wins still sees ours first). Only when the policy declares configArg AND
    // the plugin resolved a config path; the agent must not pass the same flag (it belongs in denyArgs).
    // spec 271 — when a policy declares configArg, the human-owned config MUST resolve AND exist, or the launcher
    // fails CLOSED: a tool whose safety gate is driven by its config (e.g. agent-browser's confirmActions) must
    // NEVER silently fall back to the binary's own (ungated) default — whether the plugin recorded no config
    // (no configPath, codex dueto) or the file was deleted. Either the consented config is present (and drives the
    // tool) or the launcher refuses.
    if (policy.configArg && (!r.configPath || !fs.existsSync(r.configPath))) {
      process.stderr.write(`tachyon-tool: CONFIG_MISSING: this tool requires its human-owned config but ${r.configPath ? `'${r.configPath}' is absent` : "none is recorded in the lockfile"} — reinstall the plugin to restore it (refusing to launch without the consented config)\n`);
      try { fs.closeSync(r.fd); } catch { /* already closed */ }
      return failExit("CONFIG_MISSING");
    }
    const forcedConfig = policy.configArg && r.configPath ? [policy.configArg, r.configPath] : [];
    const forcedFlags = [...(policy.args ?? []), ...forcedConfig].filter((a) => a.startsWith("-")).map((a) => a.split("=")[0]);
    const blocked = [...(policy.denyArgs ?? []), ...forcedFlags];
    if (blocked.length > 0) {
      const denied = rest.find((a) => blocked.some((d) => a === d || a.startsWith(`${d}=`)));
      if (denied) {
        process.stderr.write(`tachyon-tool: POLICY_CONFLICT: '${denied}' is refused by this tool's enforced launch policy (the plugin controls this flag)\n`);
        try { fs.closeSync(r.fd); } catch { /* already closed */ }
        return failExit("POLICY_CONFLICT");
      }
    }
    const forcedArgs = [...forcedConfig, ...(policy.args ?? [])];
    if (forcedArgs.length > 0) args = [...forcedArgs, ...rest];
    // spec 271 — build the child env: STRIP the policy's scrubEnv keys (so the agent can't override the
    // human config via env), THEN apply the forced env (policy.env wins). Done whenever scrubEnv or env is set.
    if (policy.scrubEnv || policy.env) {
      const base: NodeJS.ProcessEnv = { ...process.env };
      for (const k of policy.scrubEnv ?? []) delete base[k];
      env = { ...base, ...(policy.env ?? {}) };
    }
  }
  try {
    return launchTool(r, args, env ? { env } : {}).status;
  } finally {
    try {
      fs.closeSync(r.fd);
    } catch {
      /* already closed */
    }
  }
}

export interface MaterializeLauncherResult {
  shimPath: string;
  validatorPath: string;
  shimSha256: string;
  validatorSha256: string;
}

/**
 * Materialize the on-disk launcher into `binDir` (0700): copy the bundled validator + write the POSIX-sh shim
 * that execs the TRUST-CHECKED absolute Node on the validator. Regenerated on every managed op; the returned
 * hashes are recorded in the lockfile for drift detection (codex task-7 A/E).
 */
export function materializeLauncher(binDir: string, opts: { nodePath: string; launcherBundlePath: string }): MaterializeLauncherResult {
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const validatorPath = path.join(binDir, "_tachyon-tool.js");
  fs.copyFileSync(opts.launcherBundlePath, validatorPath);
  fs.chmodSync(validatorPath, 0o600);

  const shimPath = path.join(binDir, "_tachyon-tool");
  // resolve the shim's own physical dir; exec the recorded absolute Node on the adjacent validator.
  const shim = `#!/bin/sh\n# Tachyon tool launcher (spec 265) — regenerated on every managed op; do not edit.\nset -eu\ndir=$(cd "$(dirname "$0")" && pwd -P)\nexec "${opts.nodePath}" "$dir/_tachyon-tool.js" "$@"\n`;
  fs.writeFileSync(shimPath, shim, { mode: 0o700 });
  fs.chmodSync(shimPath, 0o700);

  return {
    shimPath,
    validatorPath,
    shimSha256: crypto.createHash("sha256").update(shim).digest("hex"),
    validatorSha256: sha256File(validatorPath),
  };
}
