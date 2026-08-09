#!/usr/bin/env node
/**
 * Dev Host pointer — arm F5 so the monorepo window loads extension bits from a
 * worktree and opens an isolated fixture workspace (never the monorepo root).
 *
 * Usage (from monorepo root):
 *   node scripts/dev-host/pointer.mjs point --worktree PATH --workspace PATH [--spec NNN] [--slug SLUG] [--owner NAME]
 *   node scripts/dev-host/pointer.mjs point --worktree PATH --fixture SLUG …
 *   node scripts/dev-host/pointer.mjs fixture-new --slug SLUG [--spec NNN] [--intent focus|metrics] [--worktree PATH]
 *   node scripts/dev-host/pointer.mjs status
 *   node scripts/dev-host/pointer.mjs clear
 *   (CLI: npm run dogfood -- dev-host -- point|point-status|point-clear|fixture-new)
 *
 * Layout under <repo>/.tachyon/dev-host/ (gitignored via .tachyon/):
 *   extension  → worktree root (symlink) — --extensionDevelopmentPath
 *   workspace  → real directory opened in EDH (child symlinks into fixture;
 *                `.tachyon` is a REAL copy — not a symlink — so managed state stays inside the workspace)
 *   meta.json  — pointer metadata for agents/humans
 *   runtime → the Node executable that may safely outlive the Extension Host
 *   tmux/, cache/ — private TMUX_TMPDIR / XDG_CACHE_HOME for the EDH process
 *   user-data/, extensions/ — reserved for CLI launch only (not F5; drops Remote-WSL)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeFixtureEngine, stopFixtureBridge, stopFixtureEngine } from "./stop-bridge.mjs";

const SELF = "dev-host";
const DIR_NAME = "dev-host";

/**
 * AF_UNIX `sockaddr_un.sun_path` is typically 108 bytes incl. NUL. tmux places the
 * socket at `$TMUX_TMPDIR/tmux-<uid>/<name>` — a deep worktree pointer like
 * `…/worktrees/<id>/change/<slug>/.tachyon/dev-host/tmux/tmux-1000/tachyon` blows past
 * that and agent spawn fails with `error connecting … (File name too long)`.
 *
 * Keep the *string* passed as TMUX_TMPDIR short (XDG_RUNTIME_DIR + hash of checkout).
 * Budget ~100 bytes for the full socket path (matches engine control-socket gate).
 */
export const TMUX_SOCKET_PATH_BUDGET = 100;

/**
 * Private short TMUX_TMPDIR for this checkout's Dev Host (F5 + headless).
 * Stable per checkout path so concurrent dogfoods do not share a socket server.
 *
 * @param {string} checkoutAbs
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute directory suitable for TMUX_TMPDIR
 */
export function devHostTmuxTmpDir(checkoutAbs, env = process.env) {
  const checkout = path.resolve(checkoutAbs);
  const id = createHash("sha256").update(checkout).digest("hex").slice(0, 12);
  const runtime = String(env.XDG_RUNTIME_DIR || "").replace(/\/+$/, "") || path.join("/tmp", `tachyon-u${process.getuid?.() ?? 0}`);
  const dir = path.join(runtime, "tachyon-dh", id, "tmux");
  const uid = process.getuid?.() ?? 0;
  const sock = path.join(dir, `tmux-${uid}`, "tachyon");
  if (Buffer.byteLength(sock, "utf8") > TMUX_SOCKET_PATH_BUDGET) {
    // Last-resort ultra-short layout (should not hit on normal Linux XDG_RUNTIME_DIR).
    const fallback = path.join(runtime, "tdh", id.slice(0, 8));
    const fallbackSock = path.join(fallback, `tmux-${uid}`, "tachyon");
    if (Buffer.byteLength(fallbackSock, "utf8") > TMUX_SOCKET_PATH_BUDGET) {
      throw new Error(
        `${SELF}: cannot fit tmux socket under AF_UNIX budget (${Buffer.byteLength(fallbackSock, "utf8")} bytes): ${fallbackSock}`,
      );
    }
    return fallback;
  }
  return dir;
}

/**
 * Materialize short TMUX_TMPDIR + `.tachyon/dev-host/launch.env` for F5.
 * launch.json loads this via envFile (cannot put absolute runtime paths in committed launch.json).
 *
 * @param {string} repoRoot checkout that owns the dev-host
 * @returns {{ tmuxTmpDir: string, launchEnvPath: string }}
 */
export function ensureDevHostTmuxLaunchEnv(repoRoot) {
  const root = path.resolve(repoRoot);
  const base = devHostDir(root);
  const tmuxTmpDir = devHostTmuxTmpDir(root);
  fs.mkdirSync(tmuxTmpDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const launchEnvPath = path.join(base, "launch.env");
  // Only TMUX_TMPDIR must be short/absolute; other F5 env stays in launch.json via ${workspaceFolder}.
  fs.writeFileSync(launchEnvPath, `TMUX_TMPDIR=${tmuxTmpDir}\n`, { encoding: "utf8", mode: 0o600 });
  // Keep a discoverable marker under the pointer (symlink → short dir). Do NOT set TMUX_TMPDIR to this
  // symlink path — the long string would still overflow sun_path.
  const marker = path.join(base, "tmux");
  try {
    const st = fs.lstatSync(marker);
    if (st.isSymbolicLink()) {
      const cur = fs.readlinkSync(marker);
      if (path.resolve(path.dirname(marker), cur) !== tmuxTmpDir && cur !== tmuxTmpDir) {
        fs.unlinkSync(marker);
        fs.symlinkSync(tmuxTmpDir, marker);
      }
    } else {
      fs.rmSync(marker, { recursive: true, force: true });
      fs.symlinkSync(tmuxTmpDir, marker);
    }
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      fs.symlinkSync(tmuxTmpDir, marker);
    } else {
      throw err;
    }
  }
  return { tmuxTmpDir, launchEnvPath };
}

export function defaultRepoRoot(fromFile = fileURLToPath(import.meta.url)) {
  return path.resolve(path.dirname(fromFile), "../..");
}

/**
 * Locate the PRIMARY checkout of this repository, for **borrowing dependencies only**.
 *
 * spec 448 — this used to be `resolveF5HostRepoRoot`, and it decided where the dev-host lived:
 * a linked worktree was redirected to the primary monorepo so one shared `.tachyon/dev-host`
 * could serve every checkout. The dev-host now belongs to the checkout it serves, so that job
 * is gone. What remains is a real worktree→primary dependency: `ensureNodeModules` symlinks the
 * primary's `node_modules` into a worktree that lacks one, and `ensureWorktreeToolBin` does the
 * same for `.tachyon/bin`. Those still need to find the primary.
 *
 * Callers must NEVER use the result as a dev-host root. It answers exactly one question:
 * "where can this checkout borrow installed dependencies from?"
 *
 * Pure for tests: pass `readGitCommonDir(checkout) => absolute .git path`.
 *
 * @returns {{ primaryRepo: string, checkout: string, redirected: boolean, warning?: string }}
 */
export function resolvePrimaryRepoRoot(fromCheckout, { readGitCommonDir } = {}) {
  const scriptRepo = path.resolve(fromCheckout);
  const gitPath = path.join(scriptRepo, ".git");
  let isLinkedWorktree = false;
  try {
    isLinkedWorktree = fs.existsSync(gitPath) && fs.statSync(gitPath).isFile();
  } catch {
    return { primaryRepo: scriptRepo, checkout: scriptRepo, redirected: false };
  }
  if (!isLinkedWorktree) {
    return { primaryRepo: scriptRepo, checkout: scriptRepo, redirected: false };
  }

  const readCommon =
    readGitCommonDir ??
    ((checkout) =>
      execFileSync("git", ["-C", checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
        encoding: "utf8",
      }).trim());

  let common;
  try {
    common = String(readCommon(scriptRepo) || "").trim();
  } catch (err) {
    return {
      primaryRepo: scriptRepo,
      checkout: scriptRepo,
      redirected: false,
      warning: `linked worktree but git-common-dir failed (${err instanceof Error ? err.message : String(err)}); dependencies cannot be borrowed`,
    };
  }
  if (!common) {
    return {
      primaryRepo: scriptRepo,
      checkout: scriptRepo,
      redirected: false,
      warning: "linked worktree but empty git-common-dir; dependencies cannot be borrowed",
    };
  }

  // git-common-dir is <primary>/.git — primary checkout is its parent.
  const primaryRepo = path.resolve(path.dirname(common));
  if (primaryRepo === scriptRepo) {
    return { primaryRepo: scriptRepo, checkout: scriptRepo, redirected: false };
  }
  if (!fs.existsSync(path.join(primaryRepo, "package.json"))) {
    return {
      primaryRepo: scriptRepo,
      checkout: scriptRepo,
      redirected: false,
      warning: `linked worktree primary ${primaryRepo} has no package.json; dependencies cannot be borrowed`,
    };
  }
  return { primaryRepo, checkout: scriptRepo, redirected: true };
}

export function devHostDir(repoRoot) {
  return path.join(repoRoot, ".tachyon", DIR_NAME);
}

/**
 * Paths for this checkout's Dev Host (spec 448).
 *
 * Flat: the dev-host is owned by the checkout it serves, so there is exactly one per checkout and
 * nothing to partition. `root` is kept as an alias of `base` so call sites that spoke in terms of a
 * slot root keep reading naturally.
 *
 * @param {string} repoRoot the checkout that owns this dev-host
 */
export function pathsOf(repoRoot) {
  const base = devHostDir(repoRoot);
  return {
    base,
    root: base,
    extension: path.join(base, "extension"),
    workspace: path.join(base, "workspace"),
    // t-f0efc5 — the multi-root entry point. VS Code decides folder-vs-workspace by EXTENSION, so a
    // multi-root dogfood needs a real `.code-workspace` path to open; the mirror directory beside it
    // still holds the folders. Absent for a single-root pointer, and that absence is the mode.
    workspaceFile: path.join(base, "workspace.code-workspace"),
    runtime: path.join(base, "runtime"),
    meta: path.join(base, "meta.json"),
    userData: path.join(base, "user-data"),
    extensions: path.join(base, "extensions"),
    tmux: path.join(base, "tmux"),
    cache: path.join(base, "cache"),
    profileHome: path.join(base, "profile-home"),
  };
}

/** Remove path if present (symlink-safe — never follow a dangling active → slots/*). */
function rmIfPresent(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || st.isFile()) {
      fs.unlinkSync(p);
      return;
    }
    fs.rmSync(p, { recursive: true, force: true });
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return;
    /* best-effort for replace */
  }
}

/** Refuse monorepo root as the opened EDH workspace. */
export function assertWorkspaceNotRepoRoot(workspaceAbs, repoRootAbs) {
  const ws = path.resolve(workspaceAbs);
  const repo = path.resolve(repoRootAbs);
  if (ws === repo) {
    throw new Error(
      `${SELF}: refusing workspace=repo root (${ws}). Open an isolated fixture, never the monorepo fleet.`,
    );
  }
}

export function assertWorktreeLooksValid(worktreeAbs) {
  const wt = path.resolve(worktreeAbs);
  if (!fs.existsSync(wt) || !fs.statSync(wt).isDirectory()) {
    throw new Error(`${SELF}: worktree not found or not a directory: ${wt}`);
  }
  const pkg = path.join(wt, "package.json");
  if (!fs.existsSync(pkg)) {
    throw new Error(`${SELF}: worktree missing package.json: ${wt}`);
  }
  return wt;
}

export function assertWorkspaceDir(workspaceAbs) {
  const ws = path.resolve(workspaceAbs);
  if (!fs.existsSync(ws) || !fs.statSync(ws).isDirectory()) {
    throw new Error(`${SELF}: workspace (fixture) not found or not a directory: ${ws}`);
  }
  return ws;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
}

function replaceSymlink(linkPath, targetAbs) {
  try {
    fs.lstatSync(linkPath);
    fs.rmSync(linkPath, { recursive: true, force: true });
  } catch {
    /* missing */
  }
  fs.symlinkSync(targetAbs, linkPath);
}

/**
 * Materialize the EDH open-folder as a *real directory* under the monorepo pointer,
 * with child symlinks into the fixture. Opening a directory that *is* a symlink
 * (or an absolute path outside ${workspaceFolder}) breaks F5 on WSL Remote:
 * - symlink folder → empty "NO FOLDER OPENED"
 * - absolute machine path → new window re-enters WSL → "Disconnected from WSL" /
 *   "Extension 'WSL' is required"
 * Portable launch keeps ${workspaceFolder}/.tachyon/dev-host/workspace so the EDH
 * inherits the parent remote authority (same shape as Run Tachyon demo/fixture).
 */
/**
 * t-f0efc5 — is this fixture a multi-root workspace? It is when it carries exactly one
 * `*.code-workspace` file, which is also the file that names the folders.
 *
 * Detection is by the fixture's own contents rather than by a flag, so `point --fixture multiroot`
 * does the right thing without the caller having to know which shape they pointed at — and a fixture
 * that later gains a workspace file starts opening as one without a lane change.
 */
export function detectMultiRootFixture(fixtureAbs) {
  const fixture = path.resolve(fixtureAbs);
  let names;
  try {
    names = fs.readdirSync(fixture);
  } catch {
    return null;
  }
  const files = names.filter((name) => name.endsWith(".code-workspace"));
  if (files.length === 0) return null;
  if (files.length > 1) {
    throw new Error(`${SELF}: fixture ${fixture} has ${files.length} .code-workspace files; keep exactly one`);
  }
  const file = path.join(fixture, files[0]);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${SELF}: ${file} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const folders = Array.isArray(parsed?.folders) ? parsed.folders : null;
  if (!folders || folders.length === 0) {
    throw new Error(`${SELF}: ${file} declares no folders`);
  }
  const relPaths = [];
  for (const entry of folders) {
    const rel = typeof entry?.path === "string" ? entry.path : null;
    if (!rel) throw new Error(`${SELF}: ${file} has a folder entry without a string path`);
    // A fixture that reaches outside itself would mirror something the lane never isolated — the
    // same rule that keeps the monorepo root from being opened as a workspace.
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
      throw new Error(`${SELF}: ${file} folder '${rel}' must be a relative path inside the fixture`);
    }
    const abs = path.join(fixture, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(`${SELF}: ${file} folder '${rel}' is not an existing directory`);
    }
    relPaths.push(rel);
  }
  return { file, folders: relPaths, name: files[0] };
}

/**
 * Copy ONE fixture entry into the mirror under the rules the lane already applies: runtime-owned
 * configuration is a real copy (the engine opens it no-follow, and a dogfood must not write back into
 * a tracked fixture), everything else a symlink so Explorer still shows fixture files.
 *
 * Extracted from `materializeWorkspaceMirror` by t-f0efc5 so a multi-root mirror is the SAME rules
 * applied per folder, not a second policy that could drift from this one.
 */
function mirrorFixtureEntry(fixtureDir, mirrorDir, name) {
  if (name === ".edh-cache" || name === ".edh-extensions" || name === ".edh-tmux" || name === ".edh-user-data") return;
  if (name === ".dev-host-source" || name === ".tachyon-dev-host.json") return;
  // The fixture's own workspace file is not mirrored: the lane writes its own beside the mirror,
  // with paths rewritten to the mirrored folders.
  if (name.endsWith(".code-workspace")) return;
  const src = path.join(fixtureDir, name);
  const dest = path.join(mirrorDir, name);
  if (name === ".tachyon" || name === ".codex" || name === ".claude") {
    fs.cpSync(src, dest, { recursive: true });
    return;
  }
  if (name === "tachyon.yml" || name === ".mcp.json") {
    fs.copyFileSync(src, dest);
    return;
  }
  fs.symlinkSync(src, dest);
}

export function materializeWorkspaceMirror(mirrorDir, fixtureAbs) {
  const fixture = path.resolve(fixtureAbs);
  try {
    fs.lstatSync(mirrorDir);
    fs.rmSync(mirrorDir, { recursive: true, force: true });
  } catch {
    /* missing */
  }
  fs.mkdirSync(mirrorDir, { recursive: true, mode: 0o700 });
  // Runtime-owned configuration and tachyon.yml must be REAL entries under the mirror; everything else
  // stays a symlink. See `mirrorFixtureEntry` for why each rule exists.
  for (const name of fs.readdirSync(fixture)) mirrorFixtureEntry(fixture, mirrorDir, name);
  fs.writeFileSync(path.join(mirrorDir, ".dev-host-source"), `${fixture}\n`, "utf8");
  fs.writeFileSync(
    path.join(mirrorDir, ".tachyon-dev-host.json"),
    `${JSON.stringify({ schemaVersion: 1, kind: "tachyon-dev-host" }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return mirrorDir;
}

/**
 * t-f0efc5 — materialize a MULTI-ROOT fixture: every declared folder mirrored under the same rules,
 * plus a `.code-workspace` beside the mirror whose paths point at the mirrored copies.
 *
 * The workspace file lives OUTSIDE the mirror directory and refers to `./workspace/<folder>` so the
 * whole thing stays under `${workspaceFolder}/.tachyon/dev-host` — the relative-path rule that keeps
 * F5 working on WSL Remote (an absolute path re-enters WSL and disconnects the window).
 *
 * Returns the workspace-file path, which is what VS Code must be given: it decides folder-vs-workspace
 * by EXTENSION, so the mirror directory alone can never open as multi-root.
 */
export function materializeMultiRootMirror(mirrorDir, workspaceFilePath, fixtureAbs, detected) {
  const fixture = path.resolve(fixtureAbs);
  const spec = detected ?? detectMultiRootFixture(fixture);
  if (!spec) throw new Error(`${SELF}: ${fixture} is not a multi-root fixture (no .code-workspace)`);
  try {
    fs.lstatSync(mirrorDir);
    fs.rmSync(mirrorDir, { recursive: true, force: true });
  } catch {
    /* missing */
  }
  fs.mkdirSync(mirrorDir, { recursive: true, mode: 0o700 });
  const folders = [];
  for (const rel of spec.folders) {
    const src = path.join(fixture, rel);
    const dest = path.join(mirrorDir, rel);
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(src)) mirrorFixtureEntry(src, dest, name);
    // Each mirrored root carries the same provenance marker a single-root mirror does, so a human
    // (and `point-status`) can tell what any one of them came from.
    fs.writeFileSync(path.join(dest, ".dev-host-source"), `${src}\n`, "utf8");
    folders.push({ path: `./workspace/${rel.split(path.sep).join("/")}` });
  }
  fs.writeFileSync(path.join(mirrorDir, ".dev-host-source"), `${fixture}\n`, "utf8");
  fs.writeFileSync(
    path.join(mirrorDir, ".tachyon-dev-host.json"),
    `${JSON.stringify({ schemaVersion: 1, kind: "tachyon-dev-host", multiRoot: true }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  fs.writeFileSync(workspaceFilePath, `${JSON.stringify({ folders }, null, 2)}\n`, "utf8");
  return workspaceFilePath;
}

/**
 * t-f0efc5 — what this pointer says to OPEN, read from its own meta.
 *
 * One reader, shared by F5's documentation and both headless runners, so "a multi-root dogfood is
 * given the .code-workspace file" is a fact recorded once at point time rather than a rule three
 * callers re-derive. Returns null when the pointer predates the field or cannot be read — the caller
 * then falls back to the mirror directory, which is exactly what such a pointer was.
 */
export function readPointerWorkspaceArg(slotRootAbs) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(slotRootAbs, "meta.json"), "utf8"));
    const arg = typeof meta?.workspaceArg === "string" ? meta.workspaceArg : null;
    return arg && fs.existsSync(arg) ? arg : null;
  } catch {
    return null;
  }
}

export function ensureNodeModules(worktreeAbs, repoRootAbs) {
  const wtNm = path.join(worktreeAbs, "node_modules");
  if (fs.existsSync(wtNm)) return { linked: false };
  const primary = path.join(repoRootAbs, "node_modules");
  if (!fs.existsSync(primary)) {
    throw new Error(
      `${SELF}: worktree has no node_modules and primary ${primary} is missing — run npm install in the monorepo first`,
    );
  }
  fs.symlinkSync(primary, wtNm);
  return { linked: true };
}

/**
 * Link monorepo `.tachyon/bin/*` into a worktree when missing so pre-commit leaves
 * that exec `.tachyon/bin/_tachyon-tool` (cwd = worktree root) still resolve.
 * Does not overwrite existing entries.
 */
export function ensureWorktreeToolBin(worktreeAbs, repoRootAbs) {
  const srcBin = path.join(path.resolve(repoRootAbs), ".tachyon", "bin");
  if (!fs.existsSync(srcBin) || !fs.statSync(srcBin).isDirectory()) {
    return { linked: false, count: 0, reason: "monorepo .tachyon/bin missing" };
  }
  const destBin = path.join(path.resolve(worktreeAbs), ".tachyon", "bin");
  fs.mkdirSync(destBin, { recursive: true, mode: 0o700 });
  let count = 0;
  for (const name of fs.readdirSync(srcBin)) {
    const src = path.join(srcBin, name);
    const dest = path.join(destBin, name);
    if (fs.existsSync(dest)) continue;
    try {
      fs.symlinkSync(src, dest);
      count += 1;
    } catch {
      /* best-effort — never fail point */
    }
  }
  return { linked: count > 0, count };
}

/**
 * Resolve `--fixture SLUG` to an absolute fixture directory.
 * Order: worktree test/fixtures/<slug>, worktree test/fixtures/<slug>-dogfood,
 * same under monorepo, then path.resolve(fixture) if it exists.
 */
export function resolveFixturePath({ worktree, repoRoot, fixture }) {
  const raw = String(fixture || "").trim();
  if (!raw) throw new Error(`${SELF}: --fixture requires a non-empty slug or path`);
  if (path.isAbsolute(raw) && fs.existsSync(raw) && fs.statSync(raw).isDirectory()) {
    return path.resolve(raw);
  }
  const names = [raw];
  if (!raw.endsWith("-dogfood") && !raw.includes(path.sep) && !raw.includes("/")) {
    names.push(`${raw}-dogfood`);
  }
  const bases = [];
  if (worktree) bases.push(path.resolve(worktree));
  if (repoRoot) bases.push(path.resolve(repoRoot));
  const candidates = [];
  for (const base of bases) {
    for (const name of names) {
      candidates.push(path.join(base, "test", "fixtures", name));
    }
  }
  candidates.push(path.resolve(raw));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return path.resolve(c);
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `${SELF}: fixture not found for '${raw}'. Tried:\n  - ${candidates.slice(0, 8).join("\n  - ")}`,
  );
}

/**
 * Scaffold test/fixtures/<slug>-dogfood for dogfood intents (focus | metrics).
 * @returns {{ root: string, slug: string, intent: string }}
 */
export function fixtureNew(opts) {
  const repoRoot = path.resolve(opts.repoRoot);
  const base = opts.worktree ? assertWorktreeLooksValid(opts.worktree) : repoRoot;
  const intent = opts.intent === "metrics" ? "metrics" : "focus";
  let slug = String(opts.slug || "").trim();
  if (!slug) throw new Error(`${SELF}: fixture-new requires --slug`);
  slug = slug.replace(/\/+$/, "");
  const dirName = slug.endsWith("-dogfood") ? slug : `${slug}-dogfood`;
  const root = path.join(base, "test", "fixtures", dirName);
  if (fs.existsSync(root)) {
    throw new Error(`${SELF}: fixture already exists: ${root}`);
  }
  const spec = opts.spec ? String(opts.spec) : null;

  fs.mkdirSync(path.join(root, ".tachyon", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".tachyon", "continuity"), { recursive: true });

  const yml =
    intent === "metrics"
      ? `# Dogfood fixture (${dirName}) — intent: metrics (running agents for CPU/MEM peek)
# Spec: ${spec ?? "—"}. Agents autostart with busy loops so resource metrics can sample.
settings:
  maxAgents: 8

agents:
  pilot:
    cmd: bash
    args: ["-c", "while true; do :; done"]
    autostart: true
    attention: true
  busy:
    cmd: bash
    args: ["-c", "while true; do :; done"]
    autostart: true
    attention: false
`
      : `# Dogfood fixture (${dirName}) — intent: focus (stopped OK; project task/brief/goal)
# Spec: ${spec ?? "—"}. Agents start STOPPED; focus still projects without a live process.
settings:
  maxAgents: 8

agents:
  grok:
    cmd: grok
    autostart: false
    attention: true
  solo:
    cmd: grok
    autostart: false
    attention: true
  idle:
    cmd: grok
    autostart: false
    attention: false
`;

  fs.writeFileSync(path.join(root, "tachyon.yml"), yml, "utf8");

  if (intent === "focus") {
    fs.writeFileSync(
      path.join(root, ".tachyon", "tasks", "t-fixture1.json"),
      `${JSON.stringify(
        {
          id: "t-fixture1",
          title: `Dogfood focus for ${dirName}`,
          status: "active",
          priority: 1,
          kind: "feature",
          author: "human",
          assignee: "grok",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, ".tachyon", "continuity", "solo.md"),
      `---
version: 1
agent: solo
updated_at: "${new Date().toISOString()}"
updated_by: agent
status: active
---

# Current Goal

Explore continuity-only focus projection for fixture ${dirName}

# Next Steps

- Confirm focus line shows source goal
`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, ".tachyon", "sessions.json"),
      `${JSON.stringify({ sessions: {} }, null, 2)}\n`,
      "utf8",
    );
  } else {
    fs.writeFileSync(
      path.join(root, ".tachyon", "sessions.json"),
      `${JSON.stringify({ sessions: {} }, null, 2)}\n`,
      "utf8",
    );
  }

  const readme = `# ${dirName}

Dogfood fixture for${spec ? ` spec ${spec}` : ""} — **intent: ${intent}**.

## Intent presets

| Intent | When to use | Agents |
|--------|-------------|--------|
| **focus** | Sidebar focus line / filters; Live 0 is OK | stopped agents + task/continuity seeds |
| **metrics** | CPU/MEM peek (spec 386) | autostart busy loops — need **Live > 0** |

This fixture was scaffolded as **${intent}**.

## Git note

Repo \`.gitignore\` ignores \`.tachyon/\`. Force-add seed content:

\`\`\`bash
git add -f test/fixtures/${dirName}/.tachyon
git add test/fixtures/${dirName}/tachyon.yml test/fixtures/${dirName}/README.md
\`\`\`

## Arm Dev Host

\`\`\`bash
# from monorepo:
npm run dogfood -- dev-host -- point \\
  --worktree <worktree-or-repo> \\
  --fixture ${dirName.replace(/-dogfood$/, "")} \\
  ${spec ? `--spec ${spec} ` : ""}--slug ${dirName.replace(/-dogfood$/, "")}
\`\`\`

Human: **Run and Debug → Tachyon: Dev Host → F5**. Then \`point-clear\` when done.
If you remove the worktree, run \`point-clear\` so the pointer is not left stale.
`;
  fs.writeFileSync(path.join(root, "README.md"), readme, "utf8");

  return { root, slug: dirName, intent, spec };
}

/** Newest mtime under dir (ms), or null if missing/empty. */
function newestMtimeMs(dir) {
  if (!fs.existsSync(dir)) return null;
  let max = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isFile()) {
      if (st.mtimeMs > max) max = st.mtimeMs;
      continue;
    }
    if (st.isDirectory()) {
      if (st.mtimeMs > max) max = st.mtimeMs;
      try {
        for (const name of fs.readdirSync(cur)) stack.push(path.join(cur, name));
      } catch {
        /* ignore */
      }
    }
  }
  return max || null;
}

function readShortSha(worktreeAbs) {
  try {
    return execFileSync("git", ["-C", worktreeAbs, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}


const LAUNCH_CONFIG_NAME = "Tachyon: Dev Host";
/**
 * t-f0efc5 — the multi-root F5 entry point.
 *
 * TWO tracked configurations rather than one rewritten per dogfood: `launch.json` is tracked and spec
 * 448's whole point is that it is never edited per agent, while VS Code decides folder-vs-workspace by
 * the EXTENSION of the path it is given — so one static argument cannot serve both shapes. Keeping the
 * single-root configuration exactly as it was also keeps the single-FOLDER window dogfoodable, which
 * matters because the product genuinely branches on it (`workspaceFile === undefined` in
 * extension.ts's worktree reveal); collapsing both onto a one-folder `.code-workspace` would have made
 * that branch unreachable by clicking.
 */
const MULTI_ROOT_LAUNCH_CONFIG_NAME = "Tachyon: Dev Host (multi-root)";


/**
 * Point one Dev Host slot at a worktree + fixture (t-efe06d multi-slot).
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.worktree
 * @param {string} opts.workspace
 * @param {string} [opts.owner]
 * @param {string} [opts.slot]
 * @param {boolean} [opts.activate] — set F5 `active` symlink to this slot (default: true for default slot / no owner)
 * @param {boolean} [opts.requireOwner]
 * @returns {object} meta written to disk
 */
export function point(opts) {
  // spec 448 — the dev-host is rooted in the checkout that owns it. `primaryRepo` is only where
  // dependencies are borrowed from (node_modules / .tachyon/bin); it never selects the root.
  const repoRoot = path.resolve(opts.repoRoot);
  const primaryRepo = path.resolve(opts.primaryRepo ?? opts.repoRoot);
  const worktree = assertWorktreeLooksValid(opts.worktree ?? repoRoot);
  const workspace = assertWorkspaceDir(opts.workspace);
  assertWorkspaceNotRepoRoot(workspace, repoRoot);

  const p = pathsOf(repoRoot);
  assertPointerSessionIdle(p.root);
  ensureDir(p.base);
  ensureDir(p.userData);
  ensureDir(p.extensions);
  ensureDir(p.cache);
  // A fixture may seed a disposable runtime home for native-runtime configuration.
  // This makes Dev Host's Runtime Config Global scope controlled rather than ambient.
  fs.rmSync(p.profileHome, { recursive: true, force: true });
  const seededProfileHome = path.join(workspace, ".runtime-config-global-home");
  if (fs.existsSync(seededProfileHome)) fs.cpSync(seededProfileHome, p.profileHome, { recursive: true });
  else ensureDir(p.profileHome);
  // Short AF_UNIX-safe TMUX_TMPDIR + launch.env (do not mkdir the long marker path as a real dir).
  const { tmuxTmpDir, launchEnvPath } = ensureDevHostTmuxLaunchEnv(repoRoot);

  const nm = ensureNodeModules(worktree, primaryRepo);
  const tools = ensureWorktreeToolBin(worktree, primaryRepo);
  // extension: symlink is fine for --extensionDevelopmentPath (remote loads package.json/dist).
  replaceSymlink(p.extension, worktree);
  // Point at the Node executable running this CLI; the engine store will copy and hash that instead.
  replaceSymlink(p.runtime, fs.realpathSync(process.execPath));
  // workspace: real dir + child symlinks so Explorer works under WSL Remote F5.
  // t-f0efc5 — a fixture carrying a `.code-workspace` is mirrored per folder instead, and the lane
  // writes its own workspace file beside the mirror. `rmIfPresent` first: re-pointing from a
  // multi-root fixture to a single-root one must not leave the old workspace file behind, or F5's
  // multi-root configuration would keep opening a mirror that no longer matches it.
  rmIfPresent(p.workspaceFile);
  const multiRoot = detectMultiRootFixture(workspace);
  if (multiRoot) materializeMultiRootMirror(p.workspace, p.workspaceFile, workspace, multiRoot);
  else materializeWorkspaceMirror(p.workspace, workspace);

  let packageName = null;
  try {
    packageName = JSON.parse(fs.readFileSync(path.join(worktree, "package.json"), "utf8")).name ?? null;
  } catch {
    /* ignore */
  }

  const meta = {
    schemaVersion: 3,
    generation: randomUUID(),
    kind: "dev-host",
    checkout: repoRoot,
    primaryRepo,
    worktree,
    workspace,
    extensionLink: p.extension,
    workspaceLink: p.workspace,
    workspaceMirror: true,
    // t-f0efc5 — the mode, and the exact path VS Code must be given for it. `workspaceArg` exists so
    // the headless runners never re-derive the rule: they open what the pointer says to open.
    workspaceMode: multiRoot ? "multi-root" : "single-root",
    workspaceArg: multiRoot ? p.workspaceFile : p.workspace,
    workspaceFolders: multiRoot ? multiRoot.folders : null,
    tmuxTmpDir,
    launchEnv: launchEnvPath,
    spec: opts.spec ?? null,
    slug: opts.slug ?? null,
    packageName,
    sha: readShortSha(worktree),
    nodeModulesLinked: nm.linked,
    toolBinLinked: tools.linked,
    toolBinLinkCount: tools.count,
    preparedAt: new Date().toISOString(),
    launchConfig: multiRoot ? MULTI_ROOT_LAUNCH_CONFIG_NAME : LAUNCH_CONFIG_NAME,
    howTo: [
      `Open VS Code on THIS checkout (${repoRoot}) — the dev-host belongs to it`,
      `Run and Debug → select "${multiRoot ? MULTI_ROOT_LAUNCH_CONFIG_NAME : LAUNCH_CONFIG_NAME}"`,
      "Press F5 (builds this checkout, opens Extension Development Host on the fixture)",
      "Drive only the EDH window; do not reload the monorepo fleet window",
      "When done: npm run dogfood -- dev-host -- point-clear",
      "Other checkouts are untouched — each owns its own dev-host",
    ],
  };
  fs.writeFileSync(p.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
}

export async function status(repoRoot, opts = {}) {
  const probeEngine = opts.probeEngine ?? probeFixtureEngine;
  const resolved = path.resolve(repoRoot);
  // spec 448 — one dev-host per checkout: nothing to select, nothing to mark active.
  const p = pathsOf(resolved);
  if (!fs.existsSync(p.meta)) {
    return {
      armed: false,
      broken: true,
      reason: "no meta.json — run: npm run dogfood -- dev-host -- point …",
      checkout: resolved,
      warnings: [],
    };
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));
  } catch (err) {
    return {
      armed: false,
      broken: true,
      reason: `meta.json unreadable: ${err instanceof Error ? err.message : String(err)}`,
      checkout: resolved,
      warnings: [],
    };
  }
  const warnings = [];
  const extOk = fs.existsSync(p.extension);
  const runtimeOk = fs.existsSync(p.runtime);
  const wsOk = fs.existsSync(p.workspace) && !fs.lstatSync(p.workspace).isSymbolicLink() && fs.statSync(p.workspace).isDirectory();

  let workspaceSource = null;
  if (wsOk) {
    const srcMarker = path.join(p.workspace, ".dev-host-source");
    if (fs.existsSync(srcMarker)) {
      try {
        workspaceSource = fs.readFileSync(srcMarker, "utf8").trim() || null;
      } catch {
        /* ignore */
      }
    }
  }

  // t-f0efc5 — the mode is what tells a human WHICH F5 configuration to pick, so status states it and
  // validates the artifact that mode requires. An older meta (before this field) reads as single-root,
  // which is what it was.
  const workspaceMode = meta.workspaceMode === "multi-root" ? "multi-root" : "single-root";
  const workspaceArg = typeof meta.workspaceArg === "string" ? meta.workspaceArg : p.workspace;
  if (workspaceMode === "multi-root") {
    if (!fs.existsSync(p.workspaceFile)) {
      warnings.push("multi-root workspace file missing — re-point");
    } else {
      let declared = null;
      try {
        declared = JSON.parse(fs.readFileSync(p.workspaceFile, "utf8"))?.folders ?? null;
      } catch {
        warnings.push("multi-root workspace file is not readable JSON — re-point");
      }
      // A folder listed but not mirrored opens as an empty root in the EDH, which reads as a product
      // bug rather than as a broken pointer. Say it here instead.
      for (const entry of Array.isArray(declared) ? declared : []) {
        const rel = typeof entry?.path === "string" ? entry.path.replace(/^\.\//, "") : null;
        const abs = rel ? path.join(p.base, rel) : null;
        if (!abs || !fs.existsSync(abs)) {
          warnings.push(`multi-root folder missing from the mirror: ${entry?.path ?? "(unnamed)"}`);
          continue;
        }
        // The single-root mirror's own invariant, checked per root: `.tachyon` must be a REAL
        // directory. A symlinked one makes AgentManager fail closed ("managed state parent
        // escapes workspace") only once an agent is spawned — a failure the dogfooder would read as
        // a product bug rather than as a broken mirror.
        const tachyonDir = path.join(abs, ".tachyon");
        if (fs.existsSync(tachyonDir) && fs.lstatSync(tachyonDir).isSymbolicLink()) {
          warnings.push(`multi-root folder ${entry.path}: .tachyon is a symlink (must be a real copy) — re-point`);
        }
        // tachyon.yml is what makes a folder a Tachyon workspace at all; a root without one opens as
        // an ordinary folder and the multi-root scenario silently tests less than it claims.
        if (!fs.existsSync(path.join(abs, "tachyon.yml"))) {
          warnings.push(`multi-root folder ${entry.path}: no tachyon.yml — that root is not a Tachyon workspace`);
        }
      }
    }
  } else if (fs.existsSync(p.workspaceFile)) {
    warnings.push("stale multi-root workspace file beside a single-root pointer — re-point or point-clear");
  }

  const worktreePath = typeof meta.worktree === "string" ? meta.worktree : null;
  const worktreeExists = Boolean(worktreePath && fs.existsSync(worktreePath));
  if (worktreePath && !worktreeExists) {
    warnings.push(`worktree missing: ${worktreePath} — run point-clear or re-point`);
  }

  let extensionResolves = null;
  if (extOk) {
    try {
      extensionResolves = fs.realpathSync(p.extension);
    } catch {
      extensionResolves = null;
      warnings.push("extension symlink is broken");
    }
  } else {
    warnings.push("extension link missing");
  }
  if (!runtimeOk) warnings.push("Dev Host engine runtime missing — re-point");
  if (!wsOk) warnings.push("workspace mirror missing or is a symlink (must be a real directory)");

  // Mirror `.tachyon` must be a real directory (managed state refuses parent-outside-workspace).
  const mirrorTachyon = path.join(p.workspace, ".tachyon");
  let tachyonMirrorIsRealDir = null;
  if (wsOk && fs.existsSync(mirrorTachyon)) {
    try {
      const st = fs.lstatSync(mirrorTachyon);
      tachyonMirrorIsRealDir = st.isDirectory() && !st.isSymbolicLink();
      if (!tachyonMirrorIsRealDir) {
        warnings.push("mirror .tachyon is a symlink — re-point (must be a real copy)");
      }
    } catch {
      tachyonMirrorIsRealDir = false;
      warnings.push("mirror .tachyon unreadable");
    }
  } else if (wsOk) {
    tachyonMirrorIsRealDir = null; // fixture had no .tachyon — ok
  }

  const distPath = worktreePath ? path.join(worktreePath, "dist") : null;
  const distExists = Boolean(distPath && fs.existsSync(distPath));
  if (worktreeExists && !distExists) {
    warnings.push("worktree dist/ missing — F5 preLaunchTask should build; or npm run build in worktree");
  }

  const fixtureSourceExists = Boolean(workspaceSource && fs.existsSync(workspaceSource));
  if (workspaceSource && !fixtureSourceExists) {
    warnings.push(`fixture source missing: ${workspaceSource}`);
  }

  // P3: fixture .tachyon newer than mirror copy → drift
  let fixtureDrift = false;
  if (workspaceSource && tachyonMirrorIsRealDir) {
    const fixtureTachyon = path.join(workspaceSource, ".tachyon");
    const fixMs = newestMtimeMs(fixtureTachyon);
    const mirMs = newestMtimeMs(mirrorTachyon);
    if (fixMs != null && mirMs != null && fixMs > mirMs + 1000) {
      fixtureDrift = true;
      warnings.push("fixture .tachyon is newer than mirror copy — re-run point to rematerialize");
    }
  }

  const criticalBroken =
    !extOk ||
    !runtimeOk ||
    !wsOk ||
    !worktreeExists ||
    tachyonMirrorIsRealDir === false ||
    !fixtureSourceExists && Boolean(workspaceSource);

  // Precise, actionable collision diagnostic (t-e357dc): a persistent engine still active for this
  // pointer's fixed mirror workspace hash will make the next F5 reuse/upgrade it instead of starting
  // clean. Read-only — never stops anything; point-clear is what reconciles it.
  let engineOccupant = null;
  try {
    engineOccupant = await probeEngine(p.root);
  } catch (error) {
    engineOccupant = { state: "unknown", error: error instanceof Error ? error.message : String(error) };
  }
  if (engineOccupant?.state === "active") {
    warnings.push(
      `persistent engine ${engineOccupant.unitName} is still active for this pointer — run point-clear before re-pointing to a different build/storage root, or it may reuse a stale engine (ROLLBACK_BUNDLE_UNAVAILABLE)`,
    );
  } else if (engineOccupant?.state === "unknown") {
    warnings.push(`could not determine persistent engine status: ${engineOccupant.error}`);
  }

  return {
    armed: !criticalBroken && extOk && wsOk && worktreeExists,
    broken: criticalBroken,
    checkout: resolved,
    meta,
    extensionResolves,
    runtimePath: runtimeOk ? fs.realpathSync(p.runtime) : null,
    workspaceResolves: workspaceSource ?? (wsOk ? path.resolve(p.workspace) : null),
    workspaceMirrorPath: wsOk ? path.resolve(p.workspace) : null,
    workspaceIsMirror: Boolean(workspaceSource),
    // t-f0efc5 — which shape this pointer opens, and the exact path that opens it. A human reads the
    // mode to pick the matching F5 configuration; the headless runners read the arg.
    workspaceMode,
    workspaceArg,
    worktreePath,
    worktreeExists,
    distExists,
    tachyonMirrorIsRealDir,
    fixtureSourceExists,
    fixtureDrift,
    engineOccupant,
    warnings,
  };
}

/** Pretty-print doctor lines for humans/agents (stdout). */
export function printStatus(st) {
  if (!st.armed && st.reason && !st.meta) {
    console.log(`${SELF}: unarmed — ${st.reason}`);
    return;
  }
  console.log(`${SELF}: ${st.armed ? "armed" : "BROKEN / not ready"}`);
  if (st.meta?.owner) console.log(`  owner:          ${st.meta.owner}`);
  if (st.meta?.spec) console.log(`  spec:           ${st.meta.spec}`);
  if (st.meta?.slug) console.log(`  slug:           ${st.meta.slug}`);
  if (st.worktreePath) console.log(`  worktree:       ${st.worktreePath}${st.worktreeExists ? "" : "  (MISSING)"}`);
  if (st.extensionResolves) console.log(`  extension →     ${st.extensionResolves}`);
  if (st.runtimePath) console.log(`  engine runtime: ${st.runtimePath}`);
  if (st.workspaceResolves) console.log(`  fixture source: ${st.workspaceResolves}`);
  if (st.workspaceMirrorPath) console.log(`  workspace mir:  ${st.workspaceMirrorPath}`);
  // t-f0efc5 — the two facts a human needs to press the right F5: which shape is armed, and the path
  // that opens it. Printed for both modes so single-root is stated rather than assumed.
  if (st.workspaceMode) console.log(`  workspace mode: ${st.workspaceMode}`);
  if (st.workspaceMode === "multi-root") console.log(`  open with:      ${st.workspaceArg}`);
  if (st.tachyonMirrorIsRealDir === true) console.log(`  mirror .tachyon: real directory (ok)`);
  else if (st.tachyonMirrorIsRealDir === false) console.log(`  mirror .tachyon: NOT a real dir (re-point)`);
  else if (st.workspaceIsMirror) console.log(`  mirror .tachyon: (none in fixture)`);
  if (st.worktreeExists) console.log(`  dist/:          ${st.distExists ? "present" : "missing"}`);
  if (st.fixtureDrift) console.log(`  fixture drift:  yes — re-point`);
  for (const w of st.warnings ?? []) console.log(`  ! ${w}`);
  if (st.meta?.howTo?.length) {
    console.log("  next:");
    for (const line of st.meta.howTo) console.log(`    • ${line}`);
  }
}

/**
 * Stop any persistent engine/Bridge owned by this Dev Host **slot** before its storage is touched.
 * Per-slot XDG state/data live under `slots/<id>/` (see portableDevHostLaunchConfig). A persistent
 * engine started under an earlier point() outlives point-clear unless stopped first — that is what
 * prevents ROLLBACK_BUNDLE_UNAVAILABLE (t-e357dc). stopFixtureEngine/Bridge key off this slot's
 * mirror workspace path only — never a normal Tachyon window or another slot.
 *
 * @param {string} slotRoot absolute path to slots/<id> (or legacy flat root during migration)
 */
export async function reconcileDevHostOccupant(slotRoot, opts = {}) {
  const stopEngine = opts.stopEngine ?? stopFixtureEngine;
  const stopBridge = opts.stopBridge ?? stopFixtureBridge;
  const root = path.resolve(slotRoot);
  const engine = await stopEngine(root);
  const bridge = await stopBridge(root);
  return { engine, bridge };
}

/**
 * Clear one slot (default: active, else default). `--all` / opts.all wipes every slot + base.
 * Never touches worktree or fixture targets.
 */
export async function clear(repoRoot, opts = {}) {
  const resolved = path.resolve(repoRoot);
  const base = devHostDir(resolved);

  // spec 448 — one dev-host per checkout, so clearing is unconditional: there is no slot to select
  // and no `active` link to retarget. `--all` is accepted as a no-op alias for callers that still
  // pass it, because "all" and "this one" are now the same set.
  if (!fs.existsSync(base)) {
    return { cleared: false, reason: "already clear" };
  }
  assertPointerSessionIdle(base);
  const reconciled = await reconcileDevHostOccupant(base, opts);
  fs.rmSync(base, { recursive: true, force: true });
  return { cleared: true, checkout: resolved, reconciled };
}

/** Refuse destructive pointer changes while an interactive headless session owns it. */
export function assertPointerSessionIdle(pointerRoot) {
  const sessionFile = path.join(pointerRoot, "session.json");
  if (!fs.existsSync(sessionFile)) return;
  let session;
  try { session = JSON.parse(fs.readFileSync(sessionFile, "utf8")); }
  catch { throw new Error(`${SELF}: interactive session marker is unreadable; run headless-session.mjs down`); }
  const livePids = [
    ["edh", session.edhPid],
    ["xvfb", session.xvfbPid],
  ].filter(([, pid]) => Number.isInteger(pid));
  for (const [kind, pid] of livePids) {
    try {
      process.kill(pid, 0);
      throw new Error(
        `${SELF}: interactive headless session owns this pointer (${kind}Pid=${pid}); run headless-session.mjs down before point/point-clear`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${SELF}: interactive`)) throw error;
    }
  }
  fs.rmSync(sessionFile, { force: true });
}

/**
 * Flags retired by spec 448, with the replacement each one maps to.
 *
 * These fail immediately rather than warning for a release — the maintainer's explicit call
 * (2026-07-24). A silent no-op would be worse than a hard stop here: the caller would believe it had
 * armed a scoped dev-host and then be pointed at a different directory than the one that launches.
 */
/**
 * Flags spec 448 removed, with the sentence each refusal carries. Exported so a guard can DERIVE the
 * set instead of restating it (t-3e5072): the transported project guidance must never instruct one of
 * these again, and a seventh retirement should extend that guard by being added here — not by
 * somebody remembering to update a second list.
 */
export const RETIRED_FLAGS = Object.freeze({
  "--owner": "the dev-host now belongs to the checkout you run in — cd to your worktree and drop --owner",
  "--slot": "slots were removed; each checkout has exactly one dev-host — cd to your worktree and drop --slot",
  "--activate": "there is no `active` pointer to select any more — the checkout you run in is the target",
  "--no-activate": "there is no `active` pointer to select any more — the checkout you run in is the target",
  "--require-owner": "ownership is structural now (one dev-host per checkout), so there is nothing to require",
  "--all": "there is only ever one dev-host per checkout, so `point-clear` already clears all of it",
});

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (RETIRED_FLAGS[a]) {
      throw new Error(`${SELF}: ${a} was removed by spec 448 — ${RETIRED_FLAGS[a]}`);
    }
    if (
      a === "--worktree" ||
      a === "--workspace" ||
      a === "--fixture" ||
      a === "--spec" ||
      a === "--slug" ||
      a === "--intent" ||
      a === "--repo"
    ) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${SELF}: ${a} requires a value`);
      out[a.slice(2)] = v;
    } else if (a.startsWith("--")) {
      throw new Error(`${SELF}: unknown flag ${a}`);
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** True when the process looks like a fleet agent (not a bare human shell). */
export function looksLikeAgentProcess(env = process.env) {
  return Boolean(
    env.TACHYON_AGENT_BRIDGE_TOKEN ||
      env.TACHYON_BRIDGE_TOKEN ||
      env.TACHYON_NODE_ID ||
      env.TACHYON_RUN_ID,
  );
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const sub = args._[0] ?? "help";
  // Explicit --repo wins (tests / overrides). Otherwise, if this checkout is a linked
  // git worktree, redirect the F5 pointer host to the primary monorepo checkout.
  // spec 448 — the dev-host is owned by THIS checkout. Previously `repoRoot` came from a redirect
  // that sent a linked worktree back to the primary monorepo, so one shared dev-host served every
  // checkout; that is exactly what this spec removes. The primary is still resolved, but only so
  // dependencies (node_modules, .tachyon/bin) can be borrowed from it.
  const scriptRoot = args.repo ? path.resolve(args.repo) : defaultRepoRoot();
  const repoRoot = scriptRoot;
  const primary =
    args.repo != null
      ? { primaryRepo: scriptRoot, checkout: scriptRoot, redirected: false }
      : resolvePrimaryRepoRoot(scriptRoot);
  const primaryRepo = primary.primaryRepo;
  if (primary.warning) console.warn(`${SELF}: ${primary.warning}`);
  const agentish = looksLikeAgentProcess();

  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(`Usage (run from the checkout you want to dogfood):
  npm run dogfood -- dev-host -- point --fixture SLUG [--spec NNN] [--slug SLUG]
  npm run dogfood -- dev-host -- point --workspace PATH [--spec NNN] [--slug SLUG]
  npm run dogfood -- dev-host -- fixture-new --slug SLUG [--spec NNN] [--intent focus|metrics]
  npm run dogfood -- dev-host -- point-status
  npm run dogfood -- dev-host -- point-clear

spec 448: the dev-host belongs to the checkout it serves — <checkout>/.tachyon/dev-host/.
  Every checkout (monorepo or linked worktree) has exactly one, so there is no slot to pick and
  no 'active' pointer to set. Two agents in two worktrees cannot collide by construction.

  Dogfood your work: cd to YOUR worktree, point, then open VS Code THERE and press F5.
  In a multi-root window VS Code labels each folder's entry, e.g. "Tachyon: Dev Host (my-worktree)".

Removed (spec 448, no deprecation window): --owner, --slot, --activate, --no-activate,
  --require-owner, --all. Each now fails with the replacement named.

--worktree is optional and defaults to the current checkout; pass it only to arm a different one.
--fixture resolves test/fixtures/<slug> or <slug>-dogfood under this checkout, then the primary.
Dependencies (node_modules, .tachyon/bin) are still borrowed from the primary checkout when absent.
`);
    return 0;
  }

  if (primary.warning) {
    console.error(`${SELF}: warning: ${primary.warning}`);
  }

  if (sub === "point") {
    // spec 448 — the checkout you run in IS the target; --worktree is an explicit override only.
    const worktree = args.worktree ?? repoRoot;
    let workspace = args.workspace;
    if (!workspace && args.fixture) {
      workspace = resolveFixturePath({
        worktree,
        repoRoot,
        fixture: args.fixture,
      });
    }
    if (!workspace) {
      throw new Error(`${SELF}: point requires --workspace PATH or --fixture SLUG`);
    }
    const meta = point({
      repoRoot,
      primaryRepo,
      worktree,
      workspace,
      spec: args.spec,
      slug: args.slug ?? (args.fixture ? String(args.fixture).replace(/-dogfood$/, "") : null),
    });
    console.log(`${SELF}: armed`);
    console.log(`  checkout:  ${repoRoot}`);
    console.log(`  worktree:  ${meta.worktree}`);
    console.log(`  workspace: ${meta.workspace}`);
    // t-f0efc5 — the mode decides which F5 configuration the human picks, so say it here rather than
    // leaving them to infer it from the fixture's contents.
    console.log(`  mode:      ${meta.workspaceMode}${meta.workspaceMode === "multi-root" ? ` (${(meta.workspaceFolders ?? []).join(", ")})` : ""}`);
    console.log(`  sha:       ${meta.sha}`);
    if (meta.spec) console.log(`  spec:      ${meta.spec}`);
    if (meta.slug) console.log(`  slug:      ${meta.slug}`);
    if (primary.redirected) console.log(`  deps from: ${primaryRepo} (borrowed node_modules/.tachyon/bin)`);
    console.log("");
    console.log("  launch.json: static, committed, ${workspaceFolder}/.tachyon/dev-host — nothing generated");
    console.log(
      meta.workspaceMode === "multi-root"
        ? "  workspace:   real per-folder mirror + .tachyon/dev-host/workspace.code-workspace"
        : "  workspace:   real mirror under .tachyon/dev-host/workspace",
    );
    console.log("  .tachyon:    real copy in mirror (not a symlink)");
    console.log("");
    console.log("Human next step:");
    for (const line of meta.howTo) console.log(`  • ${line}`);
    return 0;
  }

  if (sub === "fixture-new") {
    const result = fixtureNew({
      repoRoot,
      worktree: args.worktree,
      slug: args.slug,
      spec: args.spec,
      intent: args.intent,
    });
    console.log(`${SELF}: fixture-new ${result.root}`);
    console.log(`  intent: ${result.intent}`);
    console.log(`  git add -f ${path.join(result.root, ".tachyon")}`);
    console.log(`  then: npm run dogfood -- dev-host -- point --worktree … --fixture ${result.slug.replace(/-dogfood$/, "")}`);
    return 0;
  }

  if (sub === "status") {
    const st = await status(repoRoot);
    printStatus(st);
    console.log("---");
    console.log(JSON.stringify({ ...st, checkout: repoRoot, primaryRepo }, null, 2));
    return st.armed ? 0 : 1;
  }

  if (sub === "clear") {
    const r = await clear(repoRoot);
    console.log(`${SELF}: ${r.cleared ? `cleared dev-host of ${r.checkout}` : r.reason}`);
    if (r.reconciled) {
      console.log(`  engine: ${r.reconciled.engine?.state ?? r.reconciled.engine}`);
      console.log(`  bridge: ${r.reconciled.bridge?.state ?? r.reconciled.bridge}`);
    }
    return 0;
  }

  throw new Error(`${SELF}: unknown subcommand '${sub}' (try help)`);
}

const isMain =
  process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
