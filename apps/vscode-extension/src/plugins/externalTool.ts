/**
 * spec 285 — external-tool DETECTION + install-argv GUARDRAILS (the security foundation; no privileged exec here).
 *
 * Detection is SPOOF-RESISTANT (codex D4): a required binary is resolved on a CLEAN PATH (never the cwd/workspace,
 * which a poisoned shell profile could prepend a fake into), to an absolute realpath, then ownership/mode/ancestry
 * trust-checked with the same `isTrustedExecPath` the tool launcher uses. The assisted-install argv is shape-checked
 * (codex D3) BEFORE it ever runs: no control chars, capped, a leading optional `sudo` then a package-manager
 * executable whose family matches the DECLARED package-manager key. Tachyon never builds a shell string and never
 * runs the install here — only validates + detects.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { isTrustedExecPath } from "./toolProvisioning.js";
import { parseLockfile, LOCKFILE_REL_PATH } from "@tachyon/engine/plugins/lockfile.js";
import { PACKAGE_MANAGERS, type PackageManager, type ExternalToolDecl, type ExternalToolInstall } from "@tachyon/engine/plugins/manifest.js";

/** the `_tachyon-external` resolver shim path (sibling of `_tachyon-data`/`_tachyon-tool`; workspace-relative). */
export const EXTERNAL_RESOLVER_REL = ".tachyon/bin/_tachyon-external";

/** A fixed, system-only PATH for resolving a required binary — deliberately EXCLUDES the cwd/workspace + the ambient
 *  PATH, so a workspace-local or profile-injected fake is never the thing we detect (codex D4). */
const CLEAN_PATH = process.platform === "darwin"
  ? "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin"
  : "/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";

/** the executable name(s) each package manager is invoked as (the family the install argv's first exe must match). */
export const PM_EXECUTABLES: Record<PackageManager, string[]> = {
  apt: ["apt-get", "apt"],
  dnf: ["dnf"],
  pacman: ["pacman"],
  apk: ["apk"],
  zypper: ["zypper"],
  brew: ["brew"],
  choco: ["choco", "choco.exe"],
};

const CONTROL = /[\x00-\x1f\x7f]/;

function statOrNull(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

/** Resolve a kebab-validated binary NAME to an absolute realpath on the CLEAN PATH (no cwd/workspace), or null. */
function resolveOnCleanPath(name: string): string | null {
  try {
    // `command -v` is a shell builtin; run it under a CLEAN PATH, passing the name as a positional ARG (never
    // interpolated → no injection; the name is kebab-validated upstream anyway).
    const out = execFileSync("/bin/sh", ["-c", 'command -v -- "$1" || true', "sh", name], { encoding: "utf8", timeout: 5000, env: { PATH: CLEAN_PATH } }).trim();
    if (!out || !path.isAbsolute(out)) return null;
    return fs.realpathSync(out);
  } catch {
    return null;
  }
}

/** spec 287 (D3) — SPAWN-FREE presence resolution for the installed-card status: walk the CLEAN_PATH dirs in JS,
 *  realpath the first regular candidate, NO `command -v` subprocess and NO detect probe. The full spoof-resistant
 *  probe (`detectExternalTool`) stays in the install preview; the card only needs cheap present/absent for many tools
 *  on every refresh, so a per-tool process spawn is unacceptable. */
export function resolveOnCleanPathNoSpawn(name: string, dirs: string[] = CLEAN_PATH.split(":")): string | null {
  for (const dir of dirs) {
    const cand = path.join(dir, name);
    const st = statOrNull(cand);
    if (!st || !st.isFile()) continue;
    try {
      // mirror `command -v` semantics: the PATH entry must be EXECUTABLE, not merely a regular file. Without this a
      // trusted-path but non-executable `ffmpeg` (mode 0644) would read as present on the card while the real
      // detection (drawer/runtime) still fails (codex MEDIUM).
      fs.accessSync(cand, fs.constants.X_OK);
      const real = fs.realpathSync(cand);
      if (path.isAbsolute(real)) return real;
    } catch {
      /* unreadable / non-executable candidate → keep scanning */
    }
  }
  return null;
}

export type ExternalPresence = { present: true; path: string } | { present: false };

/** spec 289 — the ordered candidate binary names for an external tool: the explicit `names` set when present (and
 *  non-empty), else the single canonical key. The ONE place both the spawn and spawn-free paths derive candidates,
 *  so they can never disagree on which aliases satisfy a requirement (codex MEDIUM). */
export function candidateNames(key: string, names?: string[]): string[] {
  return names && names.length > 0 ? names : [key];
}

/** spec 287 (D3) + 289 — cheap, spawn-free presence check for the installed-card status: for each candidate name,
 *  clean-PATH resolve (JS, no subprocess) + trust-check, NO detect probe; return the FIRST TRUSTED one. Injected
 *  into the pure view model like `intact`/`updateChecks`. */
export function detectExternalToolPresence(name: string, deps: { uid?: number; resolve?: (name: string) => string | null; names?: string[] } = {}): ExternalPresence {
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const resolve = deps.resolve ?? resolveOnCleanPathNoSpawn;
  for (const cand of candidateNames(name, deps.names)) {
    const abs = resolve(cand);
    if (!abs) continue;
    if (!isTrustedExecPath(abs, uid, statOrNull).trusted) continue; // untrusted candidate → skip, try the next
    return { present: true, path: abs };
  }
  return { present: false };
}

export interface ExternalDetectDeps {
  uid?: number;
  /** injectable name→abs-realpath resolver (tests); default resolves on the clean PATH. */
  resolve?: (name: string) => string | null;
  /** injectable detect-argv runner returning exit-0 success (tests); default execFile, no shell, timeout. */
  runDetect?: (argv: string[]) => boolean;
}

export type ExternalDetect = { present: true; path: string } | { present: false; reason: string };

/** Run the RESOLVED-tool binary with the declared detect ARGS via execFile (NO shell, clean PATH, bounded); exit
 *  0 = present. The executed binary is ALWAYS the trust-checked `abs` — NEVER a manifest-supplied path (codex
 *  BLOCKER: `detect` carries args only, the tool itself is the resolved trusted path). */
function runDetectArgs(abs: string, args: string[]): boolean {
  try {
    execFileSync(abs, args, { timeout: 5000, env: { PATH: CLEAN_PATH }, stdio: "ignore", maxBuffer: 1 << 20 });
    return true;
  } catch {
    return false;
  }
}

/** spec 285 + 289 — detect a required external tool: for each candidate binary name (the `names` set, else the key),
 *  resolve on a clean PATH, trust-check, and run the optional detect-args probe against the RESOLVED trusted binary
 *  (never a manifest path). Resolution returns the FIRST candidate that is trusted AND (if `detect` is set) passes
 *  the probe (codex HIGH — a trusted-but-wrong binary must fall through to the next candidate). An untrusted or
 *  detect-failing candidate is SKIPPED (never returned), and the search continues; `missing` only after all fail. */
export function detectExternalTool(name: string, decl: ExternalToolDecl, deps: ExternalDetectDeps = {}): ExternalDetect {
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const resolve = deps.resolve ?? resolveOnCleanPath;
  const cands = candidateNames(name, decl.names);
  const reasons: string[] = [];
  for (const cand of cands) {
    const abs = resolve(cand);
    if (!abs) { reasons.push(`${cand}: not found on a clean system PATH`); continue; }
    const trust = isTrustedExecPath(abs, uid, statOrNull);
    if (!trust.trusted) { reasons.push(`${cand} at ${abs} is not trusted (${trust.reason})`); continue; }
    if (decl.detect) {
      const ok = deps.runDetect ? deps.runDetect(decl.detect) : runDetectArgs(abs, decl.detect);
      if (!ok) { reasons.push(`${cand} at ${abs}: detect probe did not succeed`); continue; }
    }
    return { present: true, path: abs };
  }
  const label = cands.length > 1 ? `${name} (candidates: ${cands.join(", ")})` : name;
  return { present: false, reason: `${label} unavailable — ${reasons.join("; ")}` };
}

/** spec 285 — POSIX shell-quote a token FOR DISPLAY ONLY (execution is always argv-based). */
export function shellQuoteForDisplay(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_./:=-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
}

/** spec 285 — the package manager present on this host (first match, resolved on the clean PATH + trusted), or null. */
export function detectPackageManager(deps: { uid?: number; resolve?: (name: string) => string | null } = {}): PackageManager | null {
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const resolve = deps.resolve ?? resolveOnCleanPath;
  for (const pm of PACKAGE_MANAGERS) {
    for (const exe of PM_EXECUTABLES[pm]) {
      const abs = resolve(exe);
      if (abs && isTrustedExecPath(abs, uid, statOrNull).trusted) return pm;
    }
  }
  return null;
}

export type ArgvCheck = { ok: true } | { ok: false; reason: string };

/** spec 285 (D3) — shape-check an assisted-install argv BEFORE it runs: bounded, control-free, and a leading optional
 *  `sudo` then a package-manager executable whose family matches the DECLARED pm key. Pure (no exec, no realpath). */
export function validateInstallArgv(pm: PackageManager, argv: string[]): ArgvCheck {
  if (argv.length === 0) return { ok: false, reason: "install argv is empty" };
  if (argv.length > 64) return { ok: false, reason: "install argv has too many tokens" };
  for (const a of argv) {
    if (typeof a !== "string" || a.length === 0) return { ok: false, reason: "install argv has an empty token" };
    if (a.length > 1024) return { ok: false, reason: "install argv token too long" };
    if (a.includes("\0") || CONTROL.test(a)) return { ok: false, reason: "install argv token has a control character" };
  }
  // the leading executable must be EXACTLY `sudo` or a BARE package-manager name (no path separator, no basename
  // trickery like `/tmp/apt-get`, no `env`/`sh`) — codex BLOCKER. The PM token must equal a known bare exe.
  let i = 0;
  if (argv[0] === "sudo") i = 1;
  else if (argv[0]?.includes("/")) return { ok: false, reason: `install argv[0] '${argv[0]}' must be 'sudo' or a bare package-manager name (no path)` };
  const pmTok = argv[i] ?? "";
  if (pmTok.includes("/") || !PM_EXECUTABLES[pm].includes(pmTok)) {
    return { ok: false, reason: `install argv's package-manager executable '${pmTok}' must be the bare '${pm}' command (one of ${PM_EXECUTABLES[pm].join(" / ")}, no path)` };
  }
  return { ok: true };
}

/** spec 287 (D4) — adapt a LOCKFILE external-tool requirement's `install: Record<pm, string[]>` into the
 *  `{ argv }` shape `buildAssistedInstall` consumes. ONLY known package managers are forwarded (an unknown key is
 *  dropped — `buildAssistedInstall`/`validateInstallArgv` would reject it anyway). Pure: no exec, no realpath; the
 *  resulting argv is still re-validated + re-normalized to trusted realpaths by `buildAssistedInstall`. */
export function adaptLockedInstall(install: Record<string, string[]>): Partial<Record<PackageManager, ExternalToolInstall>> {
  const out: Partial<Record<PackageManager, ExternalToolInstall>> = {};
  for (const [pm, argv] of Object.entries(install)) {
    if ((PACKAGE_MANAGERS as readonly string[]).includes(pm) && Array.isArray(argv) && argv.length > 0) out[pm as PackageManager] = { argv };
  }
  return out;
}

export type AssistedInstall =
  | { ok: true; pm: PackageManager; argv: string[] }
  | { ok: false; reason: string };

/** spec 285 — pick the host PM + build a NORMALIZED install argv whose executable parts (`sudo` + the package
 *  manager) are resolved to TRUSTED clean-PATH realpaths (codex BLOCKER: never run a manifest-supplied path; the
 *  declared executables are bare names, substituted with their trusted absolute realpaths). The trailing tokens
 *  (e.g. `install -y ffmpeg`) are pure args, kept verbatim. Pure: detection + validation only, runs nothing. */
export function buildAssistedInstall(install: Partial<Record<PackageManager, { argv: string[] }>>, deps: { uid?: number; resolve?: (name: string) => string | null } = {}): AssistedInstall {
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const resolve = deps.resolve ?? resolveOnCleanPath;
  const pm = detectPackageManager({ uid, resolve });
  if (!pm) return { ok: false, reason: "no supported package manager detected on this host — install the tool manually" };
  const cmd = install[pm];
  if (!cmd) return { ok: false, reason: `no install command declared for the detected package manager '${pm}' — install the tool manually` };
  const chk = validateInstallArgv(pm, cmd.argv);
  if (!chk.ok) return { ok: false, reason: chk.reason };

  const out: string[] = [];
  let i = 0;
  if (cmd.argv[0] === "sudo") {
    const sudoAbs = resolve("sudo");
    if (!sudoAbs || !isTrustedExecPath(sudoAbs, uid, statOrNull).trusted) return { ok: false, reason: "sudo is not present at a trusted path on this host" };
    out.push(sudoAbs);
    i = 1;
  }
  const pmAbs = resolve(cmd.argv[i]); // a bare PM name (validateInstallArgv enforced it)
  if (!pmAbs || !isTrustedExecPath(pmAbs, uid, statOrNull).trusted) return { ok: false, reason: `the '${pm}' executable is not present at a trusted path on this host` };
  out.push(pmAbs, ...cmd.argv.slice(i + 1));
  return { ok: true, pm, argv: out };
}

export type ExternalResolve = { ok: true; path: string } | { ok: false; code: string; detail: string };

/** spec 285 (D5) — resolve a plugin's external-tool requirement to a TRUSTED absolute path, lockfile-anchored +
 *  PLUGIN-SCOPED. Re-detects on every call (spoof-resistant). Fail-closed `unavailable` when absent/untrusted. */
export function resolveExternalTool(pluginName: string, toolName: string, deps: { workspaceRoot: string; uid?: number; resolve?: (name: string) => string | null; runDetect?: (argv: string[]) => boolean }): ExternalResolve {
  if (!pluginName || !toolName) return { ok: false, code: "BAD_ARGS", detail: "missing plugin/tool name" };
  const lockPath = path.join(deps.workspaceRoot, LOCKFILE_REL_PATH);
  if (!fs.existsSync(lockPath)) return { ok: false, code: "REHYDRATE_REQUIRED", detail: `${LOCKFILE_REL_PATH} is absent` };
  const parsed = parseLockfile(fs.readFileSync(lockPath, "utf8"));
  if (!parsed.lockfile) return { ok: false, code: "LOCKFILE_CORRUPT", detail: parsed.errors[0] ?? "unparseable lockfile" };
  const lock = parsed.lockfile.plugins[pluginName];
  if (!lock) return { ok: false, code: "PLUGIN_NOT_FOUND", detail: `plugin '${pluginName}' is not installed` };
  const req = (lock.externalTools ?? []).find((e) => e.name === toolName);
  if (!req) return { ok: false, code: "EXTERNAL_NOT_FOUND", detail: `plugin '${pluginName}' declares no external tool '${toolName}'` };
  // spec 289 — feed the lock's candidate `names` into detection (delegates the first-trusted-and-detect-passing loop).
  const det = detectExternalTool(toolName, { install: {}, manual: req.manual, ...(req.names ? { names: req.names } : {}), ...(req.detect ? { detect: req.detect } : {}) }, deps);
  if (!det.present) return { ok: false, code: "UNAVAILABLE", detail: `${det.reason} — ${req.manual}` };
  return { ok: true, path: det.path };
}

/** The `_tachyon-external <plugin> <name>` CLI: resolve → print the trusted path → exit 0; fail-closed nonzero. */
export function runExternalResolver(argv: string[], deps: { workspaceRoot: string }): number {
  if (argv.length < 2) { process.stderr.write("tachyon-external: usage: _tachyon-external <plugin> <name>\n"); return 2; }
  const r = resolveExternalTool(argv[0], argv[1], { workspaceRoot: deps.workspaceRoot });
  if (!r.ok) { process.stderr.write(`tachyon-external: ${r.code}: ${r.detail}\n`); return r.code === "REHYDRATE_REQUIRED" ? 78 : 1; }
  process.stdout.write(`${r.path}\n`);
  return 0;
}

export interface MaterializeExternalResolverResult { shimPath: string; validatorPath: string; shimSha256: string; validatorSha256: string; }

/** Materialize the `_tachyon-external` resolver into `binDir` (sibling of the data resolver). Regenerated on every
 *  managed op; its hashes are recorded in the lockfile launcher block for drift detection. */
export function materializeExternalResolver(binDir: string, opts: { nodePath: string; resolverBundlePath: string }): MaterializeExternalResolverResult {
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const validatorPath = path.join(binDir, "_tachyon-external.js");
  fs.copyFileSync(opts.resolverBundlePath, validatorPath);
  fs.chmodSync(validatorPath, 0o600);
  const shimPath = path.join(binDir, "_tachyon-external");
  const shim = `#!/bin/sh\n# Tachyon external-tool resolver (spec 285) — regenerated on every managed op; do not edit.\nset -eu\ndir=$(cd "$(dirname "$0")" && pwd -P)\nexec "${opts.nodePath}" "$dir/_tachyon-external.js" "$@"\n`;
  fs.writeFileSync(shimPath, shim, { mode: 0o700 });
  fs.chmodSync(shimPath, 0o700);
  return { shimPath, validatorPath, shimSha256: crypto.createHash("sha256").update(shim).digest("hex"), validatorSha256: crypto.createHash("sha256").update(fs.readFileSync(validatorPath)).digest("hex") };
}
