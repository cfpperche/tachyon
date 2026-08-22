import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { engineBundleInstallRoot, engineRuntimeInstallRoot } from "../engine-service/engineBundleStore.js";
import { workspaceIdentityPath } from "../workspace/workspaceIdentity.js";
import { parseWorkspaceProvenance, WORKSPACE_PROVENANCE_STATE_KEY } from "./provenance.js";
import { planReclaim, type BundleEntry, type EngineStateEntry, type ReclaimPlan, type RuntimeEntry, type WorktreeEntry } from "./reclaimPlan.js";

/**
 * t-f5769a — the disk, measured, turned into a plan. Read-only: it opens nothing it does not need
 * and removes nothing at all; `applyReclaim` is the only thing that deletes, and only from a plan.
 */

/** Where per-workspace engine state lives, mirroring engineStorageRoot's XDG resolution. */
export function engineStatesRoot(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local"), "Tachyon", "engine-state");
  }
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Tachyon", "engine-state");
  return path.join(env.XDG_STATE_HOME?.trim() || path.join(home, ".local", "state"), "tachyon", "engines");
}

export interface ReclaimScanOptions {
  /** override roots (tests); production reads the XDG locations the product already uses. */
  bundlesRoot?: string;
  runtimesRoot?: string;
  enginesStateRoot?: string;
  worktreesRoot?: string;
  globalStorageRoot?: string;
  keepBundles?: number;
  /** bundle ids a running engine is executing (from the unit's ExecStart / live processes). */
  liveBundleIds?: ReadonlySet<string>;
  now?: Date;
}

function directoryBytes(target: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(child); continue; }
      try { total += fs.statSync(child).size; } catch { /* raced away */ }
    }
  };
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return stat.size;
  } catch { return 0; }
  walk(target);
  return total;
}

function listDirectories(root: string): { name: string; path: string; mtimeMs: number }[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out: { name: string; path: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* keep 0 — oldest */ }
    out.push({ name: entry.name, path: full, mtimeMs });
  }
  return out;
}

function readProvenance(stateDir: string): EngineStateEntry["provenance"] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, "state", "state.json"), "utf8")) as Record<string, unknown>;
    return parseWorkspaceProvenance(raw[WORKSPACE_PROVENANCE_STATE_KEY]);
  } catch {
    return undefined;
  }
}

const runGit = promisify(execFile);

/**
 * Uncommitted changes, and commits the workspace never took — the two reasons to leave one alone.
 *
 * Asynchronous on purpose: `cxWedgeBehavior` forbids synchronous child_process under `src`, and it
 * is right to — this walk shells out once per worktree, and a machine with 59 of them would block
 * the engine's event loop for as long as git takes on all of them.
 */
async function inspectWorktree(worktreePath: string): Promise<{ dirty: boolean; unmerged: boolean }> {
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await runGit("git", args, { cwd: worktreePath, encoding: "utf8", timeout: 15_000 });
    return typeof stdout === "string" ? stdout : String(stdout);
  };
  try {
    const dirty = (await git(["status", "--porcelain"])).trim().length > 0;
    // A worktree whose HEAD is contained by no other ref carries work nothing else has.
    let unmerged = false;
    try {
      const head = (await git(["rev-parse", "HEAD"])).trim();
      const contains = (await git(["branch", "--all", "--contains", head])).trim().split("\n").filter((line) => line.trim().length > 0);
      unmerged = contains.length <= 1;
    } catch {
      unmerged = true; // unreadable history is a reason to keep, never to delete
    }
    return { dirty, unmerged };
  } catch {
    // Not a git worktree any more (its repository moved or died): nothing can vouch for it.
    return { dirty: false, unmerged: false };
  }
}

export async function scanReclaim(options: ReclaimScanOptions = {}): Promise<ReclaimPlan> {
  const bundlesRoot = options.bundlesRoot ?? engineBundleInstallRoot();
  const runtimesRoot = options.runtimesRoot ?? engineRuntimeInstallRoot();
  const enginesStateRoot = options.enginesStateRoot ?? engineStatesRoot();
  const worktreesRoot = options.worktreesRoot;
  const globalStorageRoot = options.globalStorageRoot;

  const bundles: BundleEntry[] = listDirectories(bundlesRoot).map((entry) => ({
    id: entry.name,
    path: entry.path,
    bytes: directoryBytes(entry.path),
    mtimeMs: entry.mtimeMs,
  }));

  const liveBundleIds = options.liveBundleIds ?? new Set<string>();
  const keepBundles = options.keepBundles ?? 3;
  const retainedIds = new Set([
    ...liveBundleIds,
    ...[...bundles].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.max(1, keepBundles)).map((bundle) => bundle.id),
  ]);
  // A runtime is in use when a bundle we are keeping declares it.
  const runtimesInUse = new Set<string>();
  for (const bundle of bundles) {
    if (!retainedIds.has(bundle.id)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(bundle.path, "engine-manifest.json"), "utf8")) as { runtimeId?: string };
      if (typeof manifest.runtimeId === "string") runtimesInUse.add(manifest.runtimeId);
    } catch { /* a bundle without a readable manifest pins nothing */ }
  }
  const runtimes: RuntimeEntry[] = listDirectories(runtimesRoot).map((entry) => ({
    id: entry.name,
    path: entry.path,
    bytes: directoryBytes(entry.path),
    // Conservative: with no manifest anywhere naming runtimes, keep them all rather than delete a
    // runtime a bundle silently needs.
    inUse: runtimesInUse.size === 0 || runtimesInUse.has(entry.name),
  }));

  const engineStates: EngineStateEntry[] = listDirectories(enginesStateRoot).map((entry) => ({
    hash: entry.name,
    path: entry.path,
    bytes: directoryBytes(entry.path),
    provenance: readProvenance(entry.path),
  }));

  const liveWorkspaceHashes = new Set<string>();
  // t-63955f — a hash is DEAD only when its state proves it: provenance recorded, and the workspace
  // behind it gone or replaced. Everything else (no state at all, no provenance) is neither, and a
  // token for it is kept.
  const deadWorkspaceHashes = new Set<string>();
  for (const state of engineStates) {
    const root = state.provenance?.root;
    if (!root) continue;
    if (fs.existsSync(root)) liveWorkspaceHashes.add(state.hash);
    else deadWorkspaceHashes.add(state.hash);
  }

  const worktrees: WorktreeEntry[] = [];
  if (worktreesRoot) {
    for (const workspaceDir of listDirectories(worktreesRoot)) {
      for (const kindDir of listDirectories(workspaceDir.path)) {
        for (const entry of listDirectories(kindDir.path)) {
          const inspected = await inspectWorktree(entry.path);
          worktrees.push({
            path: entry.path,
            bytes: directoryBytes(entry.path),
            workspaceHash: workspaceDir.name,
            dirty: inspected.dirty,
            unmerged: inspected.unmerged,
            live: liveWorkspaceHashes.has(workspaceDir.name),
          });
        }
      }
    }
  }

  const bridgeTokens: { path: string; bytes: number; hash: string }[] = [];
  if (globalStorageRoot) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(globalStorageRoot, { withFileTypes: true }); } catch { /* absent */ }
    for (const entry of entries) {
      const match = /^bridge-(?:external-)?token-([0-9a-f]+)$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const full = path.join(globalStorageRoot, entry.name);
      bridgeTokens.push({ path: full, bytes: directoryBytes(full), hash: match[1]! });
    }
  }

  return planReclaim({
    bundles,
    liveBundleIds,
    keepBundles,
    runtimes,
    engineStates,
    worktrees,
    bridgeTokens,
    liveWorkspaceHashes,
    deadWorkspaceHashes,
    probe: {
      rootExists: (root) => { try { return fs.existsSync(root); } catch { return false; } },
      identityAt: (root) => {
        try {
          const parsed = JSON.parse(fs.readFileSync(workspaceIdentityPath(root), "utf8")) as { id?: string };
          return typeof parsed.id === "string" ? parsed.id : undefined;
        } catch {
          return undefined;
        }
      },
    },
  });
}

export interface ReclaimResult {
  removed: string[];
  quarantined: { from: string; to: string }[];
  failed: { path: string; error: string }[];
  bytesFreed: number;
}

/**
 * Execute a plan. Quarantine MOVES rather than deletes — the state of a dead incarnation holds
 * provider API keys, and the ruling was that nothing carries forward, not that anything is
 * destroyed.
 */
export function applyReclaim(plan: ReclaimPlan, options: { quarantineRoot: string; now: Date }): ReclaimResult {
  const result: ReclaimResult = { removed: [], quarantined: [], failed: [], bytesFreed: 0 };
  for (const entry of plan.collect) {
    try {
      fs.rmSync(entry.path, { recursive: true, force: true });
      result.removed.push(entry.path);
      result.bytesFreed += entry.bytes;
    } catch (error) {
      result.failed.push({ path: entry.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const stamp = options.now.toISOString().replace(/[:.]/g, "-");
  for (const entry of plan.quarantine) {
    const destination = path.join(options.quarantineRoot, stamp, path.basename(entry.path));
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(entry.path, destination);
      result.quarantined.push({ from: entry.path, to: destination });
    } catch (error) {
      result.failed.push({ path: entry.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
