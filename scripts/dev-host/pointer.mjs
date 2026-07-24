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
 *   (CLI: npm run dogfood:dev-host -- point|point-status|point-clear|fixture-new)
 *
 * Layout under <repo>/.tachyon/dev-host/ (gitignored via .tachyon/):
 *   extension  → worktree root (symlink) — --extensionDevelopmentPath
 *   workspace  → real directory opened in EDH (child symlinks into fixture;
 *                `.tachyon` is a REAL copy — not a symlink — so Soul launch stays inside the workspace)
 *   meta.json  — pointer metadata for agents/humans
 *   runtime → the Node executable that may safely outlive the Extension Host
 *   tmux/, cache/ — private TMUX_TMPDIR / XDG_CACHE_HOME for the EDH process
 *   user-data/, extensions/ — reserved for CLI launch only (not F5; drops Remote-WSL)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeFixtureEngine, stopFixtureBridge, stopFixtureEngine } from "./stop-bridge.mjs";

const SELF = "dev-host";
const DIR_NAME = "dev-host";

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
export function materializeWorkspaceMirror(mirrorDir, fixtureAbs) {
  const fixture = path.resolve(fixtureAbs);
  try {
    fs.lstatSync(mirrorDir);
    fs.rmSync(mirrorDir, { recursive: true, force: true });
  } catch {
    /* missing */
  }
  fs.mkdirSync(mirrorDir, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(fixture)) {
    // CLI-only isolation dirs on the fixture — not needed for F5 and clutter Explorer.
    if (name === ".edh-cache" || name === ".edh-extensions" || name === ".edh-tmux" || name === ".edh-user-data") {
      continue;
    }
    if (name === ".dev-host-source" || name === ".tachyon-dev-host.json") continue;
    const src = path.join(fixture, name);
    const dest = path.join(mirrorDir, name);
    // `.tachyon` and tachyon.yml must be REAL entries under the mirror. The engine deliberately
    // opens authoritative config with a no-follow policy; a tachyon.yml symlink therefore fails
    // closed with ELOOP during real Dev Host Studio saves. Copying the config also keeps destructive
    // dogfood mutations inside the disposable mirror instead of writing back into a tracked fixture.
    // Engine AgentManager fails closed if `.tachyon` resolves outside the workspace
    // (SoulError: Soul launch reservation parent escapes workspace) — common when dogfood
    // fixtures seed tasks/continuity/sessions under fixture/.tachyon and pointer only
    // symlinks them. Other entries stay symlinks so Explorer still shows fixture files.
    if (name === ".tachyon") {
      fs.cpSync(src, dest, { recursive: true });
      continue;
    }
    if (name === "tachyon.yml") {
      fs.copyFileSync(src, dest);
      continue;
    }
    fs.symlinkSync(src, dest);
  }
  fs.writeFileSync(path.join(mirrorDir, ".dev-host-source"), `${fixture}\n`, "utf8");
  fs.writeFileSync(
    path.join(mirrorDir, ".tachyon-dev-host.json"),
    `${JSON.stringify({ schemaVersion: 1, kind: "tachyon-dev-host" }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return mirrorDir;
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
npm run dogfood:dev-host -- point \\
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
  ensureDir(p.tmux);
  ensureDir(p.cache);
  ensureDir(p.profileHome);

  const nm = ensureNodeModules(worktree, primaryRepo);
  const tools = ensureWorktreeToolBin(worktree, primaryRepo);
  // extension: symlink is fine for --extensionDevelopmentPath (remote loads package.json/dist).
  replaceSymlink(p.extension, worktree);
  // Point at the Node executable running this CLI; the engine store will copy and hash that instead.
  replaceSymlink(p.runtime, fs.realpathSync(process.execPath));
  // workspace: real dir + child symlinks so Explorer works under WSL Remote F5.
  materializeWorkspaceMirror(p.workspace, workspace);

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
    spec: opts.spec ?? null,
    slug: opts.slug ?? null,
    packageName,
    sha: readShortSha(worktree),
    nodeModulesLinked: nm.linked,
    toolBinLinked: tools.linked,
    toolBinLinkCount: tools.count,
    preparedAt: new Date().toISOString(),
    launchConfig: LAUNCH_CONFIG_NAME,
    howTo: [
      `Open VS Code on THIS checkout (${repoRoot}) — the dev-host belongs to it`,
      `Run and Debug → select "${LAUNCH_CONFIG_NAME}"`,
      "Press F5 (builds this checkout, opens Extension Development Host on the fixture)",
      "Drive only the EDH window; do not reload the monorepo fleet window",
      "When done: npm run dogfood:dev-host -- point-clear",
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
      reason: "no meta.json — run: npm run dogfood:dev-host -- point …",
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

  // Mirror `.tachyon` must be a real directory (Soul launch refuses parent-outside-workspace).
  const mirrorTachyon = path.join(p.workspace, ".tachyon");
  let tachyonMirrorIsRealDir = null;
  if (wsOk && fs.existsSync(mirrorTachyon)) {
    try {
      const st = fs.lstatSync(mirrorTachyon);
      tachyonMirrorIsRealDir = st.isDirectory() && !st.isSymbolicLink();
      if (!tachyonMirrorIsRealDir) {
        warnings.push("mirror .tachyon is a symlink — re-point (must be a real copy; SoulError risk)");
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
const RETIRED_FLAGS = Object.freeze({
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
  npm run dogfood:dev-host -- point --fixture SLUG [--spec NNN] [--slug SLUG]
  npm run dogfood:dev-host -- point --workspace PATH [--spec NNN] [--slug SLUG]
  npm run dogfood:dev-host -- fixture-new --slug SLUG [--spec NNN] [--intent focus|metrics]
  npm run dogfood:dev-host -- point-status
  npm run dogfood:dev-host -- point-clear

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
    console.log(`  sha:       ${meta.sha}`);
    if (meta.spec) console.log(`  spec:      ${meta.spec}`);
    if (meta.slug) console.log(`  slug:      ${meta.slug}`);
    if (primary.redirected) console.log(`  deps from: ${primaryRepo} (borrowed node_modules/.tachyon/bin)`);
    console.log("");
    console.log("  launch.json: static, committed, ${workspaceFolder}/.tachyon/dev-host — nothing generated");
    console.log("  workspace:   real mirror under .tachyon/dev-host/workspace");
    console.log("  .tachyon:    real copy in mirror (not a symlink — Soul-safe)");
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
    console.log(`  then: npm run dogfood:dev-host -- point --worktree … --fixture ${result.slug.replace(/-dogfood$/, "")}`);
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
