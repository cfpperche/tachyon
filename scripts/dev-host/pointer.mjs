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
 *   extension  → worktree root (symlink)
 *   workspace  → fixture dir opened in EDH (symlink)
 *   meta.json  — pointer metadata for agents/humans
 *   user-data/, extensions/, tmux/, cache/ — isolation dirs for the launch config
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
  replaceSymlink(p.extension, worktree);
  replaceSymlink(p.workspace, workspace);

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
  const wsOk = fs.existsSync(p.workspace);
  return {
    armed: extOk && wsOk,
    meta,
    extensionResolves: extOk ? fs.realpathSync(p.extension) : null,
    workspaceResolves: wsOk ? fs.realpathSync(p.workspace) : null,
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
  return { cleared: true };
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
  npm run dogfood:dev-host -- dev-host point --worktree PATH --workspace PATH [--spec NNN] [--slug SLUG] [--owner NAME]
  npm run dogfood:dev-host -- dev-host status
  npm run dogfood:dev-host -- point-clear

Stable F5 config name: "Tachyon: Dev Host"
Pointer dir: <repo>/.tachyon/dev-host/
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
