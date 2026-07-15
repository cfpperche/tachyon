#!/usr/bin/env node
/**
 * Dev Host pointer — arm F5 so the monorepo window loads extension bits from a
 * worktree and opens an isolated fixture workspace (never the monorepo root).
 *
 * Usage (from monorepo root):
 *   node scripts/dev-host/pointer.mjs point --worktree PATH --workspace PATH [--spec NNN] [--slug SLUG] [--owner NAME]
 *   node scripts/dev-host/pointer.mjs status
 *   node scripts/dev-host/pointer.mjs clear
 *   (CLI: npm run dogfood:dev-host -- point|point-status|point-clear)
 *
 * Layout under <repo>/.tachyon/dev-host/ (gitignored via .tachyon/):
 *   extension  → worktree root (symlink) — --extensionDevelopmentPath
 *   workspace  → real directory opened in EDH (child symlinks into fixture)
 *   meta.json  — pointer metadata for agents/humans
 *   tmux/, cache/ — private TMUX_TMPDIR / XDG_CACHE_HOME for the EDH process
 *   user-data/, extensions/ — reserved for CLI launch only (not F5; drops Remote-WSL)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = "dev-host";
const DIR_NAME = "dev-host";

export function defaultRepoRoot(fromFile = fileURLToPath(import.meta.url)) {
  return path.resolve(path.dirname(fromFile), "../..");
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
    if (name === ".dev-host-source") continue;
    fs.symlinkSync(path.join(fixture, name), path.join(mirrorDir, name));
  }
  fs.writeFileSync(path.join(mirrorDir, ".dev-host-source"), `${fixture}\n`, "utf8");
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
      TMUX_TMPDIR: "${workspaceFolder}/.tachyon/dev-host/tmux",
      XDG_CACHE_HOME: "${workspaceFolder}/.tachyon/dev-host/cache",
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
  ensureDir(p.root);
  ensureDir(p.userData);
  ensureDir(p.extensions);
  ensureDir(p.tmux);
  ensureDir(p.cache);

  const nm = ensureNodeModules(worktree, repoRoot);
  // extension: symlink is fine for --extensionDevelopmentPath (remote loads package.json/dist).
  replaceSymlink(p.extension, worktree);
  // workspace: real dir + child symlinks so Explorer works under WSL Remote F5.
  materializeWorkspaceMirror(p.workspace, workspace);

  let packageName = null;
  try {
    packageName = JSON.parse(fs.readFileSync(path.join(worktree, "package.json"), "utf8")).name ?? null;
  } catch {
    /* ignore */
  }

  const meta = {
    schemaVersion: 1,
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
    preparedAt: new Date().toISOString(),
    launchConfig: "Tachyon: Dev Host",
    howTo: [
      'Run and Debug → select "Tachyon: Dev Host"',
      "Press F5 (builds the pointed worktree, opens Extension Development Host on the fixture)",
      "Drive only the EDH window; do not reload the monorepo fleet window",
      "When done: npm run dogfood:dev-host -- point-clear",
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

export function status(repoRoot) {
  const p = pathsOf(path.resolve(repoRoot));
  if (!fs.existsSync(p.meta)) {
    return { armed: false, reason: "no meta.json — run: npm run dogfood:dev-host -- point …" };
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));
  } catch (err) {
    return { armed: false, reason: `meta.json unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const extOk = fs.existsSync(p.extension);
  const wsOk = fs.existsSync(p.workspace) && fs.statSync(p.workspace).isDirectory();
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
  return {
    armed: extOk && wsOk,
    meta,
    extensionResolves: extOk ? fs.realpathSync(p.extension) : null,
    // Mirror is a real directory; report fixture source (marker) or the mirror path.
    workspaceResolves: workspaceSource ?? (wsOk ? path.resolve(p.workspace) : null),
    workspaceIsMirror: Boolean(workspaceSource),
    broken: !extOk || !wsOk,
  };
}

export function clear(repoRoot) {
  const p = pathsOf(path.resolve(repoRoot));
  if (!fs.existsSync(p.root)) {
    return { cleared: false, reason: "already clear" };
  }
  // Only remove pointer + isolation dirs under .tachyon/dev-host — never the worktree/fixture targets
  fs.rmSync(p.root, { recursive: true, force: true });
  const launch = restoreTemplateLaunchConfig(repoRoot);
  return { cleared: true, launch };
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (
      a === "--worktree" ||
      a === "--workspace" ||
      a === "--spec" ||
      a === "--slug" ||
      a === "--owner" ||
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

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const sub = args._[0] ?? "help";
  const repoRoot = args.repo ? path.resolve(args.repo) : defaultRepoRoot();

  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(`Usage:
  npm run dogfood:dev-host -- point --worktree PATH --workspace PATH [--spec NNN] [--slug SLUG] [--owner NAME]
  npm run dogfood:dev-host -- point-status
  npm run dogfood:dev-host -- point-clear

Stable F5 config name: "Tachyon: Dev Host"
Pointer dir: <repo>/.tachyon/dev-host/
On point: mirrors fixture into .tachyon/dev-host/workspace (real dir) and keeps portable launch.json.
`);
    return 0;
  }

  if (sub === "point") {
    if (!args.worktree || !args.workspace) {
      throw new Error(`${SELF}: point requires --worktree and --workspace`);
    }
    const meta = point({
      repoRoot,
      worktree: args.worktree,
      workspace: args.workspace,
      spec: args.spec,
      slug: args.slug,
      owner: args.owner,
    });
    console.log(`${SELF}: armed`);
    console.log(`  worktree:  ${meta.worktree}`);
    console.log(`  workspace: ${meta.workspace}`);
    console.log(`  sha:       ${meta.sha}`);
    if (meta.spec) console.log(`  spec:      ${meta.spec}`);
    if (meta.slug) console.log(`  slug:      ${meta.slug}`);
    console.log("");
    console.log("  launch.json: portable ${workspaceFolder} Dev Host paths (WSL-safe)");
    console.log("  workspace:   real mirror dir under .tachyon/dev-host/workspace");
    console.log("");
    console.log("Human next step:");
    for (const line of meta.howTo) console.log(`  • ${line}`);
    return 0;
  }

  if (sub === "status") {
    const st = status(repoRoot);
    console.log(JSON.stringify(st, null, 2));
    return st.armed ? 0 : 1;
  }

  if (sub === "clear") {
    const r = clear(repoRoot);
    console.log(`${SELF}: ${r.cleared ? "cleared" : r.reason}`);
    return 0;
  }

  throw new Error(`${SELF}: unknown subcommand '${sub}' (try help)`);
}

const isMain =
  process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
