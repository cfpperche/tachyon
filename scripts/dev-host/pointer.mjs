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
 * F5 "Tachyon: Dev Host" always reads `${workspaceFolder}/.tachyon/dev-host` from the
 * **VS Code monorepo window** (primary checkout). When `point`/`point-status`/`point-clear`
 * are invoked from a linked git worktree checkout (`.git` is a file), the pointer must land
 * under the primary worktree — not under the feature worktree's own `.tachyon/dev-host`.
 *
 * Pure for tests: pass `readGitCommonDir(checkout) => absolute .git path`.
 *
 * @returns {{ hostRepo: string, scriptRepo: string, redirected: boolean, warning?: string }}
 */
export function resolveF5HostRepoRoot(fromCheckout, { readGitCommonDir } = {}) {
  const scriptRepo = path.resolve(fromCheckout);
  const gitPath = path.join(scriptRepo, ".git");
  let isLinkedWorktree = false;
  try {
    isLinkedWorktree = fs.existsSync(gitPath) && fs.statSync(gitPath).isFile();
  } catch {
    return { hostRepo: scriptRepo, scriptRepo, redirected: false };
  }
  if (!isLinkedWorktree) {
    return { hostRepo: scriptRepo, scriptRepo, redirected: false };
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
      hostRepo: scriptRepo,
      scriptRepo,
      redirected: false,
      warning: `linked worktree but git-common-dir failed (${err instanceof Error ? err.message : String(err)}); pointer stays under this checkout`,
    };
  }
  if (!common) {
    return {
      hostRepo: scriptRepo,
      scriptRepo,
      redirected: false,
      warning: "linked worktree but empty git-common-dir; pointer stays under this checkout",
    };
  }

  // git-common-dir is <primary>/.git — primary checkout is its parent.
  const hostRepo = path.resolve(path.dirname(common));
  if (hostRepo === scriptRepo) {
    return { hostRepo: scriptRepo, scriptRepo, redirected: false };
  }
  if (!fs.existsSync(path.join(hostRepo, "package.json"))) {
    return {
      hostRepo: scriptRepo,
      scriptRepo,
      redirected: false,
      warning: `linked worktree primary ${hostRepo} has no package.json; pointer stays under this checkout`,
    };
  }
  return { hostRepo, scriptRepo, redirected: true };
}

export function devHostDir(repoRoot) {
  return path.join(repoRoot, ".tachyon", DIR_NAME);
}

export function pathsOf(repoRoot) {
  const root = devHostDir(repoRoot);
  return {
    root,
    extension: path.join(root, "extension"),
    workspace: path.join(root, "workspace"),
    runtime: path.join(root, "runtime"),
    meta: path.join(root, "meta.json"),
    userData: path.join(root, "user-data"),
    extensions: path.join(root, "extensions"),
    tmux: path.join(root, "tmux"),
    cache: path.join(root, "cache"),
  };
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

/** Portable F5 shape for WSL Remote parent windows (must stay under ${workspaceFolder}). */
export function portableDevHostLaunchConfig() {
  // Do NOT set --extensions-dir / --user-data-dir: empty private dirs drop
  // ms-vscode-remote.remote-wsl on the local (Windows) side of the EDH window.
  // Do NOT write absolute machine paths: they force a fresh WSL re-entry
  // ("Disconnected from WSL" / "Extension 'WSL' is required").
  // Match Run Tachyon (demo/fixture): folder + extensionDevelopmentPath under workspaceFolder.
  return {
    name: LAUNCH_CONFIG_NAME,
    type: "extensionHost",
    request: "launch",
    args: [
      "${workspaceFolder}/.tachyon/dev-host/workspace",
      "--extensionDevelopmentPath=${workspaceFolder}/.tachyon/dev-host/extension",
      "--disable-workspace-trust",
    ],
    env: {
      TACHYON_DEV_HOST: "1",
      TACHYON_DEV_HOST_ENGINE_RUNTIME: "${workspaceFolder}/.tachyon/dev-host/runtime",
      TACHYON_DEV_HOST_PROFILE_HOME: "${workspaceFolder}/.tachyon/dev-host/profile-home",
      TMUX_TMPDIR: "${workspaceFolder}/.tachyon/dev-host/tmux",
      XDG_CACHE_HOME: "${workspaceFolder}/.tachyon/dev-host/cache",
      XDG_STATE_HOME: "${workspaceFolder}/.tachyon/dev-host/state",
      XDG_DATA_HOME: "${workspaceFolder}/.tachyon/dev-host/data",
    },
    outFiles: ["${workspaceFolder}/.tachyon/dev-host/extension/dist/**/*.js"],
    preLaunchTask: "tachyon: build-dev-host",
    presentation: {
      hidden: false,
      group: "dogfood",
      order: 1,
    },
  };
}

/**
 * Ensure launch.json Dev Host entry uses the portable template (never machine-local paths).
 * @deprecated name kept as alias — prefer ensurePortableLaunchConfig
 */
export function writeAbsoluteLaunchConfig(repoRoot, _worktreeAbs, _workspaceAbs) {
  return ensurePortableLaunchConfig(repoRoot);
}

/** Write / restore portable Dev Host launch entry (safe to leave committed). */
export function ensurePortableLaunchConfig(repoRoot) {
  const launchPath = path.join(repoRoot, ".vscode", "launch.json");
  if (!fs.existsSync(launchPath)) {
    // Tests and bare checkouts without .vscode — pointer still works for CLI status.
    return null;
  }
  const raw = fs.readFileSync(launchPath, "utf8");
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${SELF}: ${launchPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(doc.configurations)) {
    throw new Error(`${SELF}: ${launchPath} has no configurations array`);
  }
  const cfg = portableDevHostLaunchConfig();
  const idx = doc.configurations.findIndex((c) => c && c.name === LAUNCH_CONFIG_NAME);
  if (idx >= 0) doc.configurations[idx] = cfg;
  else doc.configurations.unshift(cfg);
  fs.mkdirSync(path.dirname(launchPath), { recursive: true });
  fs.writeFileSync(launchPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return launchPath;
}

/** Restore portable template paths (idempotent with ensurePortableLaunchConfig). */
export function restoreTemplateLaunchConfig(repoRoot) {
  const launchPath = ensurePortableLaunchConfig(repoRoot);
  if (!launchPath) return { restored: false, reason: "no launch.json" };
  return { restored: true, path: launchPath };
}

/**
 * Point the stable Dev Host launcher at a worktree + fixture.
 * @returns {object} meta written to disk
 */
export function point(opts) {
  const repoRoot = path.resolve(opts.repoRoot);
  const worktree = assertWorktreeLooksValid(opts.worktree);
  const workspace = assertWorkspaceDir(opts.workspace);
  assertWorkspaceNotRepoRoot(workspace, repoRoot);

  const p = pathsOf(repoRoot);
  assertPointerSessionIdle(p.root);
  ensureDir(p.root);
  ensureDir(p.userData);
  ensureDir(p.extensions);
  ensureDir(p.tmux);
  ensureDir(p.cache);

  const nm = ensureNodeModules(worktree, repoRoot);
  const tools = ensureWorktreeToolBin(worktree, repoRoot);
  // extension: symlink is fine for --extensionDevelopmentPath (remote loads package.json/dist).
  replaceSymlink(p.extension, worktree);
  // A local Electron test host may need adjacent shared libraries after process.execPath is copied.
  // Point at the Node executable running this CLI; the engine store will copy and hash that instead.
  replaceSymlink(p.runtime, fs.realpathSync(process.execPath));
  // workspace: real dir + child symlinks so Explorer works under WSL Remote F5.
  // (`.tachyon` is copied — see materializeWorkspaceMirror.)
  materializeWorkspaceMirror(p.workspace, workspace);

  let packageName = null;
  try {
    packageName = JSON.parse(fs.readFileSync(path.join(worktree, "package.json"), "utf8")).name ?? null;
  } catch {
    /* ignore */
  }

  const meta = {
    schemaVersion: 1,
    generation: randomUUID(),
    kind: "dev-host",
    worktree,
    workspace,
    extensionLink: p.extension,
    workspaceLink: p.workspace,
    workspaceMirror: true,
    spec: opts.spec ?? null,
    slug: opts.slug ?? null,
    owner: opts.owner ?? null,
    packageName,
    sha: readShortSha(worktree),
    nodeModulesLinked: nm.linked,
    toolBinLinked: tools.linked,
    toolBinLinkCount: tools.count,
    preparedAt: new Date().toISOString(),
    launchConfig: "Tachyon: Dev Host",
    howTo: [
      'Run and Debug → select "Tachyon: Dev Host"',
      "Press F5 (builds the pointed worktree, opens Extension Development Host on the fixture)",
      "Drive only the EDH window; do not reload the monorepo fleet window",
      "When done: npm run dogfood:dev-host -- point-clear",
      "If you remove the worktree, run point-clear so the pointer is not left stale",
    ],
  };
  fs.writeFileSync(p.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  // Always portable ${workspaceFolder} paths — never machine-local absolutes (WSL F5).
  const launchPath = ensurePortableLaunchConfig(repoRoot);
  if (launchPath) {
    meta.launchJson = launchPath;
    meta.launchNote =
      "launch.json Dev Host entry uses portable ${workspaceFolder} paths; workspace is a real mirror dir under .tachyon/dev-host/";
  }
  fs.writeFileSync(p.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
}

export async function status(repoRoot, opts = {}) {
  const probeEngine = opts.probeEngine ?? probeFixtureEngine;
  const p = pathsOf(path.resolve(repoRoot));
  if (!fs.existsSync(p.meta)) {
    return {
      armed: false,
      broken: true,
      reason: "no meta.json — run: npm run dogfood:dev-host -- point …",
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
 * Stop any persistent engine/Bridge owned by this Dev Host pointer before its storage is touched.
 * `.tachyon/dev-host/{state,data}` (the engine's storage root / bundle install root, materialized by
 * the engine itself at runtime — see portableDevHostLaunchConfig's XDG_STATE_HOME/XDG_DATA_HOME) live
 * under the same fixed mirror path across every F5 session, so a persistent engine started under an
 * earlier point() outlives point-clear unless it is stopped first. Stopping it here — before its
 * storage is wiped — is what prevents a later session's supervisor from finding that engine still
 * alive with no verified rollback bundle left to fall back to (ROLLBACK_BUNDLE_UNAVAILABLE, t-e357dc).
 * `stopFixtureEngine`/`stopFixtureBridge` key strictly off this pointer's own mirror workspace path,
 * so this can never reach a normal Tachyon window or a different Dev Host pointer's engine.
 */
export async function reconcileDevHostOccupant(repoRoot, opts = {}) {
  const stopEngine = opts.stopEngine ?? stopFixtureEngine;
  const stopBridge = opts.stopBridge ?? stopFixtureBridge;
  const root = devHostDir(path.resolve(repoRoot));
  const engine = await stopEngine(root);
  const bridge = await stopBridge(root);
  return { engine, bridge };
}

export async function clear(repoRoot, opts = {}) {
  const p = pathsOf(path.resolve(repoRoot));
  if (!fs.existsSync(p.root)) {
    return { cleared: false, reason: "already clear" };
  }
  assertPointerSessionIdle(p.root);
  // Reconcile before touching storage: never wipe state/data out from under a live engine.
  const reconciled = await reconcileDevHostOccupant(repoRoot, opts);
  // Only remove pointer + isolation dirs under .tachyon/dev-host — never the worktree/fixture targets
  fs.rmSync(p.root, { recursive: true, force: true });
  const launch = restoreTemplateLaunchConfig(repoRoot);
  return { cleared: true, launch, reconciled };
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

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (
      a === "--worktree" ||
      a === "--workspace" ||
      a === "--fixture" ||
      a === "--spec" ||
      a === "--slug" ||
      a === "--owner" ||
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

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const sub = args._[0] ?? "help";
  // Explicit --repo wins (tests / overrides). Otherwise, if this checkout is a linked
  // git worktree, redirect the F5 pointer host to the primary monorepo checkout.
  const scriptRoot = args.repo ? path.resolve(args.repo) : defaultRepoRoot();
  const host =
    args.repo != null
      ? { hostRepo: scriptRoot, scriptRepo: scriptRoot, redirected: false }
      : resolveF5HostRepoRoot(scriptRoot);
  const repoRoot = host.hostRepo;

  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(`Usage:
  npm run dogfood:dev-host -- point --worktree PATH --workspace PATH [--spec NNN] [--slug SLUG] [--owner NAME]
  npm run dogfood:dev-host -- point --worktree PATH --fixture SLUG [--spec NNN] [--slug SLUG] [--owner NAME]
  npm run dogfood:dev-host -- fixture-new --slug SLUG [--spec NNN] [--intent focus|metrics] [--worktree PATH]
  npm run dogfood:dev-host -- point-status
  npm run dogfood:dev-host -- point-clear

Stable F5 config name: "Tachyon: Dev Host"
Pointer dir: <monorepo>/.tachyon/dev-host/  (F5 host = primary checkout, not a linked worktree)
Linked worktree: point/status/clear auto-redirect to the primary monorepo so F5 finds the pointer.
On point: mirrors fixture into .tachyon/dev-host/workspace (real dir; .tachyon copied) and portable launch.json.
--fixture resolves test/fixtures/<slug> or <slug>-dogfood under worktree, then monorepo.
`);
    return 0;
  }

  if (host.warning) {
    console.error(`${SELF}: warning: ${host.warning}`);
  }
  if (host.redirected && (sub === "point" || sub === "status" || sub === "clear")) {
    console.log(`${SELF}: F5 host is primary monorepo ${repoRoot}`);
    console.log(`  (command ran from linked worktree ${host.scriptRepo})`);
    console.log(`  pointer path: ${path.join(repoRoot, ".tachyon", DIR_NAME)}`);
  }

  if (sub === "point") {
    if (!args.worktree) {
      throw new Error(`${SELF}: point requires --worktree`);
    }
    let workspace = args.workspace;
    if (!workspace && args.fixture) {
      workspace = resolveFixturePath({
        worktree: args.worktree,
        repoRoot,
        fixture: args.fixture,
      });
    }
    if (!workspace) {
      throw new Error(`${SELF}: point requires --workspace PATH or --fixture SLUG`);
    }
    const slug = args.slug ?? (args.fixture ? String(args.fixture).replace(/-dogfood$/, "") : null);
    const meta = point({
      repoRoot,
      worktree: args.worktree,
      workspace,
      spec: args.spec,
      slug,
      owner: args.owner,
    });
    console.log(`${SELF}: armed`);
    console.log(`  f5-host:   ${repoRoot}`);
    console.log(`  worktree:  ${meta.worktree}`);
    console.log(`  workspace: ${meta.workspace}`);
    console.log(`  sha:       ${meta.sha}`);
    if (meta.spec) console.log(`  spec:      ${meta.spec}`);
    if (meta.slug) console.log(`  slug:      ${meta.slug}`);
    console.log("");
    console.log("  launch.json: portable ${workspaceFolder} Dev Host paths (WSL-safe)");
    console.log("  workspace:   real mirror dir under monorepo .tachyon/dev-host/workspace");
    console.log("  .tachyon:    real copy in mirror (not a symlink — Soul-safe)");
    console.log("");
    console.log("Human next step (from monorepo VS Code window):");
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
    console.log(JSON.stringify({ ...st, f5HostRepo: repoRoot, scriptRepo: host.scriptRepo, redirected: host.redirected }, null, 2));
    return st.armed ? 0 : 1;
  }

  if (sub === "clear") {
    const r = await clear(repoRoot);
    console.log(`${SELF}: ${r.cleared ? "cleared" : r.reason}`);
    if (r.reconciled) {
      console.log(`  engine: ${r.reconciled.engine.state}`);
      console.log(`  bridge: ${r.reconciled.bridge.state}`);
    }
    if (host.redirected) console.log(`  (cleared monorepo pointer at ${repoRoot})`);
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
