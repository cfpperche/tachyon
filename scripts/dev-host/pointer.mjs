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
/** Multi-slot v1 (t-efe06d): each owner/agent keeps an isolated pointer under slots/<id>/. */
export const DEFAULT_SLOT = "default";
const SLOTS_SUBDIR = "slots";
const ACTIVE_LINK = "active";

export function defaultRepoRoot(fromFile = fileURLToPath(import.meta.url)) {
  return path.resolve(path.dirname(fromFile), "../..");
}

/** Sanitize slot id: agents/owners map 1:1; human path uses DEFAULT_SLOT. */
export function normalizeSlotId(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!s || s === "." || s === "..") {
    throw new Error(`${SELF}: invalid slot id '${raw}'`);
  }
  return s;
}

/**
 * Resolve which slot to use.
 * Priority: explicit slot → owner → env TACHYON_DEV_HOST_SLOT → env TACHYON_AGENT_NAME → default.
 * When `requireOwner` and no owner/slot/agent env, throws (agent fail-closed).
 */
export function resolveSlotId(opts = {}) {
  const env = opts.env ?? process.env;
  if (opts.slot != null && String(opts.slot).trim()) return normalizeSlotId(opts.slot);
  if (opts.owner != null && String(opts.owner).trim()) return normalizeSlotId(opts.owner);
  if (env.TACHYON_DEV_HOST_SLOT && String(env.TACHYON_DEV_HOST_SLOT).trim()) {
    return normalizeSlotId(env.TACHYON_DEV_HOST_SLOT);
  }
  if (env.TACHYON_AGENT_NAME && String(env.TACHYON_AGENT_NAME).trim()) {
    return normalizeSlotId(env.TACHYON_AGENT_NAME);
  }
  if (opts.requireOwner) {
    throw new Error(
      `${SELF}: agents must pass --owner (or set TACHYON_AGENT_NAME / TACHYON_DEV_HOST_SLOT); refusing unscoped last-writer-wins point`,
    );
  }
  return DEFAULT_SLOT;
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

export function slotsDir(repoRoot) {
  return path.join(devHostDir(repoRoot), SLOTS_SUBDIR);
}

export function activeLinkPath(repoRoot) {
  return path.join(devHostDir(repoRoot), ACTIVE_LINK);
}

/**
 * Paths for one Dev Host slot (isolated pointer).
 * @param {string} repoRoot
 * @param {string} [slotId]
 */
export function pathsOf(repoRoot, slotId = DEFAULT_SLOT) {
  const slot = normalizeSlotId(slotId);
  const base = devHostDir(repoRoot);
  const root = path.join(base, SLOTS_SUBDIR, slot);
  return {
    base,
    slotId: slot,
    root,
    extension: path.join(root, "extension"),
    workspace: path.join(root, "workspace"),
    runtime: path.join(root, "runtime"),
    meta: path.join(root, "meta.json"),
    userData: path.join(root, "user-data"),
    extensions: path.join(root, "extensions"),
    tmux: path.join(root, "tmux"),
    cache: path.join(root, "cache"),
    profileHome: path.join(root, "profile-home"),
  };
}

/** True if the pre-multi-slot flat layout is present (meta + extension at base root). */
export function isFlatPointerLayout(repoRoot) {
  const base = devHostDir(repoRoot);
  return fs.existsSync(path.join(base, "meta.json")) || fs.existsSync(path.join(base, "extension"));
}

/**
 * One-shot migrate flat `.tachyon/dev-host/{extension,workspace,…}` → `slots/default/`.
 * Returns { migrated, slotId } .
 */
export function migrateFlatPointerToSlots(repoRoot) {
  const base = devHostDir(path.resolve(repoRoot));
  if (!fs.existsSync(base)) return { migrated: false, slotId: null };
  if (fs.existsSync(path.join(base, SLOTS_SUBDIR))) {
    // Already multi-slot; leave any leftover flat files alone until clear.
    return { migrated: false, slotId: null };
  }
  if (!isFlatPointerLayout(repoRoot)) return { migrated: false, slotId: null };

  const dest = path.join(base, SLOTS_SUBDIR, DEFAULT_SLOT);
  ensureDir(path.join(base, SLOTS_SUBDIR));
  ensureDir(dest);
  const moveNames = [
    "extension",
    "workspace",
    "runtime",
    "meta.json",
    "user-data",
    "extensions",
    "tmux",
    "cache",
    "state",
    "data",
    "profile-home",
    "session.json",
  ];
  for (const name of moveNames) {
    const from = path.join(base, name);
    const to = path.join(dest, name);
    if (!fs.existsSync(from)) continue;
    try {
      fs.renameSync(from, to);
    } catch {
      // Cross-device or busy: copy+rm best effort
      try {
        fs.cpSync(from, to, { recursive: true });
        fs.rmSync(from, { recursive: true, force: true });
      } catch {
        /* leave in place; slot may be partial */
      }
    }
  }
  setActiveSlot(repoRoot, DEFAULT_SLOT);
  console.error(
    `${SELF}: migrated legacy flat pointer → slots/${DEFAULT_SLOT}/ (t-efe06d multi-slot). Re-point per agent with --owner to avoid clobber.`,
  );
  return { migrated: true, slotId: DEFAULT_SLOT };
}

/** Point `active` symlink at slots/<slotId> for the default F5 launch entry. */
export function setActiveSlot(repoRoot, slotId) {
  const slot = normalizeSlotId(slotId);
  const base = devHostDir(repoRoot);
  const target = path.join(base, SLOTS_SUBDIR, slot);
  if (!fs.existsSync(target)) {
    throw new Error(`${SELF}: cannot activate missing slot '${slot}' (${target})`);
  }
  ensureDir(base);
  const link = activeLinkPath(repoRoot);
  try {
    fs.lstatSync(link);
    fs.rmSync(link, { recursive: true, force: true });
  } catch {
    /* missing */
  }
  // Relative link so the monorepo tree stays relocatable
  fs.symlinkSync(path.join(SLOTS_SUBDIR, slot), link);
  return link;
}

export function readActiveSlotId(repoRoot) {
  const link = activeLinkPath(repoRoot);
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null;
    const raw = fs.readlinkSync(link);
    const base = path.basename(raw.replace(/\\/g, "/"));
    return base && base !== "." && base !== ".." ? normalizeSlotId(base) : null;
  } catch {
    return null;
  }
}

/** List slot ids that have meta.json. */
export function listSlotIds(repoRoot) {
  const dir = slotsDir(repoRoot);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(dir, name, "meta.json")))
    .sort();
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
 * Portable F5 shape. Default config uses `active` symlink → slots/<id>.
 * Per-slot configs use slots/<id>/ so concurrent agents can F5 without clobber.
 * @param {{ slotId?: string, label?: string }} [opts]
 */
export function portableDevHostLaunchConfig(opts = {}) {
  // Do NOT set --extensions-dir / --user-data-dir: empty private dirs drop
  // ms-vscode-remote.remote-wsl on the local (Windows) side of the EDH window.
  // Do NOT write absolute machine paths: they force a fresh WSL re-entry
  // ("Disconnected from WSL" / "Extension 'WSL' is required").
  const slotId = opts.slotId ? normalizeSlotId(opts.slotId) : null;
  const rel = slotId
    ? `\${workspaceFolder}/.tachyon/dev-host/slots/${slotId}`
    : "${workspaceFolder}/.tachyon/dev-host/active";
  const name = slotId
    ? `${LAUNCH_CONFIG_NAME} · ${slotId}`
    : LAUNCH_CONFIG_NAME;
  return {
    name,
    type: "extensionHost",
    request: "launch",
    args: [
      `${rel}/workspace`,
      `--extensionDevelopmentPath=${rel}/extension`,
      "--disable-workspace-trust",
    ],
    env: {
      TACHYON_DEV_HOST: "1",
      ...(slotId ? { TACHYON_DEV_HOST_SLOT: slotId } : {}),
      TACHYON_DEV_HOST_ENGINE_RUNTIME: `${rel}/runtime`,
      TACHYON_DEV_HOST_PROFILE_HOME: `${rel}/profile-home`,
      TMUX_TMPDIR: `${rel}/tmux`,
      XDG_CACHE_HOME: `${rel}/cache`,
      XDG_STATE_HOME: `${rel}/state`,
      XDG_DATA_HOME: `${rel}/data`,
    },
    outFiles: [`${rel}/extension/dist/**/*.js`],
    preLaunchTask: "tachyon: build-dev-host",
    presentation: {
      hidden: false,
      group: "dogfood",
      order: slotId ? 2 : 1,
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

/** Write / restore portable Dev Host launch entries (default active + per-slot). */
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
  const wanted = [portableDevHostLaunchConfig()];
  for (const slotId of listSlotIds(repoRoot)) {
    if (slotId === DEFAULT_SLOT) continue; // default covered by active entry + explicit if needed
    wanted.push(portableDevHostLaunchConfig({ slotId }));
  }
  // Always include default slot entry when it exists (named), so agents can F5 without flipping active.
  if (listSlotIds(repoRoot).includes(DEFAULT_SLOT)) {
    wanted.push(portableDevHostLaunchConfig({ slotId: DEFAULT_SLOT }));
  }
  // Dedupe by name
  const byName = new Map();
  for (const c of wanted) byName.set(c.name, c);
  const keepNames = new Set(byName.keys());
  // Drop stale "Tachyon: Dev Host · *" configs not in keepNames
  doc.configurations = doc.configurations.filter((c) => {
    if (!c || typeof c.name !== "string") return true;
    if (c.name === LAUNCH_CONFIG_NAME) return false; // replace
    if (c.name.startsWith(`${LAUNCH_CONFIG_NAME} · `)) return false; // regenerate
    return true;
  });
  // Insert our configs at front in stable order
  const ordered = [byName.get(LAUNCH_CONFIG_NAME), ...[...byName.values()].filter((c) => c.name !== LAUNCH_CONFIG_NAME)].filter(
    Boolean,
  );
  doc.configurations = [...ordered, ...doc.configurations];
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
  const repoRoot = path.resolve(opts.repoRoot);
  const worktree = assertWorktreeLooksValid(opts.worktree);
  const workspace = assertWorkspaceDir(opts.workspace);
  assertWorkspaceNotRepoRoot(workspace, repoRoot);

  migrateFlatPointerToSlots(repoRoot);

  const slotId = resolveSlotId({
    owner: opts.owner,
    slot: opts.slot,
    requireOwner: opts.requireOwner === true,
    env: opts.env,
  });
  const p = pathsOf(repoRoot, slotId);
  assertPointerSessionIdle(p.root);
  ensureDir(p.base);
  ensureDir(path.join(p.base, SLOTS_SUBDIR));
  ensureDir(p.root);
  ensureDir(p.userData);
  ensureDir(p.extensions);
  ensureDir(p.tmux);
  ensureDir(p.cache);
  ensureDir(p.profileHome);

  const nm = ensureNodeModules(worktree, repoRoot);
  const tools = ensureWorktreeToolBin(worktree, repoRoot);
  // extension: symlink is fine for --extensionDevelopmentPath (remote loads package.json/dist).
  replaceSymlink(p.extension, worktree);
  // Point at the Node executable running this CLI; the engine store will copy and hash that instead.
  replaceSymlink(p.runtime, fs.realpathSync(process.execPath));
  // workspace: real dir + child symlinks so Explorer works under WSL Remote F5.
  materializeWorkspaceMirror(p.workspace, workspace);

  // Activate for F5 default: explicit flag, or human/default path (no owner).
  // Agent slots with --owner do not steal active unless --activate or first slot ever.
  const wantActivate =
    opts.activate === true ||
    (opts.activate !== false && (!opts.owner || slotId === DEFAULT_SLOT));
  if (wantActivate) {
    setActiveSlot(repoRoot, slotId);
  } else if (!readActiveSlotId(repoRoot)) {
    // First slot ever → become active so bare F5 still works.
    setActiveSlot(repoRoot, slotId);
  }

  let packageName = null;
  try {
    packageName = JSON.parse(fs.readFileSync(path.join(worktree, "package.json"), "utf8")).name ?? null;
  } catch {
    /* ignore */
  }

  const isActive = readActiveSlotId(repoRoot) === slotId;
  const launchName = isActive ? LAUNCH_CONFIG_NAME : `${LAUNCH_CONFIG_NAME} · ${slotId}`;

  const meta = {
    schemaVersion: 2,
    generation: randomUUID(),
    kind: "dev-host",
    slotId,
    worktree,
    workspace,
    extensionLink: p.extension,
    workspaceLink: p.workspace,
    workspaceMirror: true,
    spec: opts.spec ?? null,
    slug: opts.slug ?? null,
    owner: opts.owner ?? (slotId !== DEFAULT_SLOT ? slotId : null),
    packageName,
    sha: readShortSha(worktree),
    nodeModulesLinked: nm.linked,
    toolBinLinked: tools.linked,
    toolBinLinkCount: tools.count,
    preparedAt: new Date().toISOString(),
    launchConfig: launchName,
    howTo: [
      `Run and Debug → select "${launchName}"${isActive ? " (active F5 slot)" : " (or set active with point --activate)"}`,
      "Press F5 (builds this slot's worktree, opens Extension Development Host on the fixture)",
      "Drive only the EDH window; do not reload the monorepo fleet window",
      `When done: npm run dogfood:dev-host -- point-clear --owner ${opts.owner ?? slotId}`,
      "Other agents' slots are untouched — use point-status --all to list",
    ],
  };
  fs.writeFileSync(p.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  const launchPath = ensurePortableLaunchConfig(repoRoot);
  if (launchPath) {
    meta.launchJson = launchPath;
    meta.launchNote =
      "launch.json: default entry uses .tachyon/dev-host/active → slots/<id>; per-slot entries under slots/<id>/";
  }
  fs.writeFileSync(p.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
}

export async function status(repoRoot, opts = {}) {
  const probeEngine = opts.probeEngine ?? probeFixtureEngine;
  const resolved = path.resolve(repoRoot);
  migrateFlatPointerToSlots(resolved);
  let slotId;
  if (opts.slotId != null && String(opts.slotId).trim()) {
    slotId = normalizeSlotId(opts.slotId);
  } else if (opts.slot != null && String(opts.slot).trim()) {
    slotId = normalizeSlotId(opts.slot);
  } else if (opts.owner != null && String(opts.owner).trim()) {
    slotId = normalizeSlotId(opts.owner);
  } else {
    slotId = readActiveSlotId(resolved) ?? DEFAULT_SLOT;
  }
  const activeId = readActiveSlotId(resolved);
  const p = pathsOf(resolved, slotId);
  if (!fs.existsSync(p.meta)) {
    const slots = listSlotIds(resolved);
    return {
      armed: false,
      broken: true,
      reason: slots.length
        ? `no meta for slot '${slotId}' — armed slots: ${slots.join(", ")} (point-status --all)`
        : "no meta.json — run: npm run dogfood:dev-host -- point …",
      slotId,
      active: activeId === slotId,
      activeSlotId: activeId,
      slots,
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
      slotId,
      active: activeId === slotId,
      activeSlotId: activeId,
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
    slotId,
    active: activeId === slotId,
    activeSlotId: activeId,
    slots: listSlotIds(resolved),
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

/** Doctor for every armed slot (point-status --all). */
export async function statusAll(repoRoot, opts = {}) {
  const resolved = path.resolve(repoRoot);
  migrateFlatPointerToSlots(resolved);
  const ids = listSlotIds(resolved);
  const activeSlotId = readActiveSlotId(resolved);
  const items = [];
  for (const id of ids) {
    items.push(await status(resolved, { ...opts, slotId: id }));
  }
  return {
    armed: items.some((s) => s.armed),
    activeSlotId,
    slots: items,
    slotIds: ids,
  };
}

/** Pretty-print doctor lines for humans/agents (stdout). */
export function printStatus(st) {
  if (!st.armed && st.reason && !st.meta) {
    console.log(`${SELF}: unarmed — ${st.reason}`);
    return;
  }
  console.log(`${SELF}: ${st.armed ? "armed" : "BROKEN / not ready"}`);
  if (st.slotId) console.log(`  slot:           ${st.slotId}${st.active ? "  (active F5)" : ""}`);
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
  migrateFlatPointerToSlots(resolved);
  const base = devHostDir(resolved);

  if (opts.all) {
    if (!fs.existsSync(base)) {
      return { cleared: false, reason: "already clear", all: true };
    }
    const ids = listSlotIds(resolved);
    // Also include slot dirs that exist without meta (partial failures)
    let dirIds = [];
    try {
      if (fs.existsSync(slotsDir(resolved))) {
        dirIds = fs
          .readdirSync(slotsDir(resolved), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      }
    } catch {
      /* ignore */
    }
    const unique = [...new Set([...ids, ...dirIds])];
    const reconciledAll = [];
    for (const id of unique) {
      const p = pathsOf(resolved, id);
      if (!fs.existsSync(p.root)) continue;
      assertPointerSessionIdle(p.root);
      reconciledAll.push({ slotId: id, ...(await reconcileDevHostOccupant(p.root, opts)) });
    }
    // Flat leftovers (pre-migrate race)
    if (isFlatPointerLayout(resolved)) {
      assertPointerSessionIdle(base);
      reconciledAll.push({ slotId: "(flat)", ...(await reconcileDevHostOccupant(base, opts)) });
    }
    fs.rmSync(base, { recursive: true, force: true });
    const launch = restoreTemplateLaunchConfig(resolved);
    return {
      cleared: true,
      all: true,
      slots: unique,
      launch,
      reconciled: reconciledAll[0] ?? { engine: { state: "absent" }, bridge: { state: "absent" } },
      reconciledAll,
    };
  }

  // Explicit owner/slot/env → that slot. Bare human clear → active, else default.
  // opts.env isolates tests from the real agent process env when set (even to {}).
  const env = opts.env !== undefined ? opts.env : process.env;
  let slotId;
  if (opts.slot != null && String(opts.slot).trim()) {
    slotId = normalizeSlotId(opts.slot);
  } else if (opts.owner != null && String(opts.owner).trim()) {
    slotId = normalizeSlotId(opts.owner);
  } else if (env.TACHYON_DEV_HOST_SLOT && String(env.TACHYON_DEV_HOST_SLOT).trim()) {
    slotId = normalizeSlotId(env.TACHYON_DEV_HOST_SLOT);
  } else if (env.TACHYON_AGENT_NAME && String(env.TACHYON_AGENT_NAME).trim()) {
    slotId = normalizeSlotId(env.TACHYON_AGENT_NAME);
  } else {
    slotId = readActiveSlotId(resolved) ?? DEFAULT_SLOT;
  }

  if (opts.requireOwner === true) {
    resolveSlotId({
      owner: opts.owner,
      slot: opts.slot,
      requireOwner: true,
      env,
    });
  }

  const p = pathsOf(resolved, slotId);
  if (!fs.existsSync(p.root)) {
    // Nothing for this slot — if base is empty/orphan, treat as already clear
    if (!fs.existsSync(base) || (listSlotIds(resolved).length === 0 && !isFlatPointerLayout(resolved))) {
      if (fs.existsSync(base) && listSlotIds(resolved).length === 0) {
        // empty multi-slot shell
        try {
          fs.rmSync(base, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      return { cleared: false, reason: "already clear", slotId };
    }
    return { cleared: false, reason: `slot '${slotId}' not armed`, slotId };
  }

  assertPointerSessionIdle(p.root);
  // Reconcile before touching storage: never wipe state/data out from under a live engine.
  const reconciled = await reconcileDevHostOccupant(p.root, opts);
  fs.rmSync(p.root, { recursive: true, force: true });

  // Retarget or drop active symlink
  if (readActiveSlotId(resolved) === slotId) {
    const remaining = listSlotIds(resolved);
    if (remaining.length > 0) {
      try {
        setActiveSlot(resolved, remaining[0]);
      } catch {
        try {
          fs.rmSync(activeLinkPath(resolved), { force: true });
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        fs.rmSync(activeLinkPath(resolved), { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  // Last slot gone → wipe base (active, slots/, leftovers) for a clean unarmed tree
  if (listSlotIds(resolved).length === 0) {
    if (fs.existsSync(base)) {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }

  const launch = restoreTemplateLaunchConfig(resolved);
  return { cleared: true, slotId, launch, reconciled };
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
      a === "--slot" ||
      a === "--intent" ||
      a === "--repo"
    ) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${SELF}: ${a} requires a value`);
      out[a.slice(2)] = v;
    } else if (a === "--all") {
      out.all = true;
    } else if (a === "--activate") {
      out.activate = true;
    } else if (a === "--no-activate") {
      out.activate = false;
    } else if (a === "--require-owner") {
      out.requireOwner = true;
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
  const scriptRoot = args.repo ? path.resolve(args.repo) : defaultRepoRoot();
  const host =
    args.repo != null
      ? { hostRepo: scriptRoot, scriptRepo: scriptRoot, redirected: false }
      : resolveF5HostRepoRoot(scriptRoot);
  const repoRoot = host.hostRepo;
  const agentish = looksLikeAgentProcess();

  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(`Usage:
  npm run dogfood:dev-host -- point --worktree PATH --workspace PATH [--spec NNN] [--slug SLUG] [--owner NAME] [--slot ID] [--activate|--no-activate]
  npm run dogfood:dev-host -- point --worktree PATH --fixture SLUG [--spec NNN] [--slug SLUG] [--owner NAME]
  npm run dogfood:dev-host -- fixture-new --slug SLUG [--spec NNN] [--intent focus|metrics] [--worktree PATH]
  npm run dogfood:dev-host -- point-status [--owner NAME] [--slot ID] [--all]
  npm run dogfood:dev-host -- point-clear [--owner NAME] [--slot ID] [--all]

Multi-slot (t-efe06d): each owner keeps slots/<id>/ under <monorepo>/.tachyon/dev-host/.
  active → symlink to the default F5 slot; launch.json also has "Tachyon: Dev Host · <slot>".
  Agents: pass --owner $TACHYON_AGENT_NAME (or set TACHYON_AGENT_NAME / TACHYON_DEV_HOST_SLOT).
  Humans: omit --owner → slot "default". point-clear --all frees the whole environment.

Stable F5 config name: "Tachyon: Dev Host" (reads .tachyon/dev-host/active/…)
Linked worktree: point/status/clear auto-redirect to the primary monorepo so F5 finds the pointer.
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
    const requireOwner =
      args.requireOwner === true ||
      (agentish && !args.owner && !args.slot && !process.env.TACHYON_AGENT_NAME && !process.env.TACHYON_DEV_HOST_SLOT);
    const slug = args.slug ?? (args.fixture ? String(args.fixture).replace(/-dogfood$/, "") : null);
    const meta = point({
      repoRoot,
      worktree: args.worktree,
      workspace,
      spec: args.spec,
      slug,
      owner: args.owner,
      slot: args.slot,
      activate: args.activate,
      requireOwner,
    });
    console.log(`${SELF}: armed`);
    console.log(`  f5-host:   ${repoRoot}`);
    console.log(`  slot:      ${meta.slotId}${meta.launchConfig === LAUNCH_CONFIG_NAME ? " (active F5)" : ""}`);
    console.log(`  worktree:  ${meta.worktree}`);
    console.log(`  workspace: ${meta.workspace}`);
    console.log(`  sha:       ${meta.sha}`);
    if (meta.owner) console.log(`  owner:     ${meta.owner}`);
    if (meta.spec) console.log(`  spec:      ${meta.spec}`);
    if (meta.slug) console.log(`  slug:      ${meta.slug}`);
    console.log("");
    console.log("  launch.json: portable ${workspaceFolder} paths via active/ + per-slot configs");
    console.log(`  workspace:   real mirror under slots/${meta.slotId}/workspace`);
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
    if (args.all) {
      const all = await statusAll(repoRoot);
      console.log(`${SELF}: ${all.slotIds.length} slot(s)${all.activeSlotId ? ` · active=${all.activeSlotId}` : ""}`);
      for (const st of all.slots) {
        console.log("");
        printStatus(st);
      }
      if (all.slotIds.length === 0) {
        console.log(`${SELF}: unarmed — no slots (npm run dogfood:dev-host -- point …)`);
      }
      console.log("---");
      console.log(JSON.stringify({ ...all, f5HostRepo: repoRoot, scriptRepo: host.scriptRepo, redirected: host.redirected }, null, 2));
      return all.armed ? 0 : 1;
    }
    const st = await status(repoRoot, { owner: args.owner, slot: args.slot, slotId: args.slot });
    printStatus(st);
    console.log("---");
    console.log(JSON.stringify({ ...st, f5HostRepo: repoRoot, scriptRepo: host.scriptRepo, redirected: host.redirected }, null, 2));
    return st.armed ? 0 : 1;
  }

  if (sub === "clear") {
    if (
      agentish &&
      !args.all &&
      !args.owner &&
      !args.slot &&
      !process.env.TACHYON_AGENT_NAME &&
      !process.env.TACHYON_DEV_HOST_SLOT
    ) {
      throw new Error(
        `${SELF}: agents must pass --owner (or --slot / TACHYON_AGENT_NAME) for point-clear; use --all only when intentionally freeing every slot`,
      );
    }
    const r = await clear(repoRoot, {
      owner: args.owner,
      slot: args.slot,
      all: args.all === true,
      requireOwner: args.requireOwner === true,
    });
    if (r.all) {
      console.log(`${SELF}: ${r.cleared ? "cleared all slots" : r.reason}`);
    } else {
      console.log(`${SELF}: ${r.cleared ? `cleared slot '${r.slotId}'` : r.reason}`);
    }
    if (r.reconciled) {
      console.log(`  engine: ${r.reconciled.engine?.state ?? r.reconciled.engine}`);
      console.log(`  bridge: ${r.reconciled.bridge?.state ?? r.reconciled.bridge}`);
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
