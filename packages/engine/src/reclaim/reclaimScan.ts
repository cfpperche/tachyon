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
  /** override the kernel process tree (tests); production reads `/proc`. */
  procRoot?: string;
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

/**
 * The runtimes some live engine is EXECUTING, read from the kernel rather than from a record anyone
 * had to remember to write. An engine process carries `tachyon-engine:<hash>` as its title, and its
 * `/proc/<pid>/exe` resolves to the staged runtime's `node`.
 *
 * `measured` separates "looked, found none running" from "could not look at all". Only the first is
 * evidence; the second holds everything, because a runtime deleted out from under a starting engine
 * is a broken install, and disk is cheaper than that.
 */
function liveEngineRuntimeIds(runtimesRoot: string, procRoot: string): { measured: boolean; ids: Set<string> } {
  const ids = new Set<string>();
  let pids: string[];
  try {
    pids = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return { measured: false, ids };
  }
  const root = path.resolve(runtimesRoot);
  for (const pid of pids) {
    let title: string;
    try { title = fs.readFileSync(path.join(procRoot, pid, "cmdline"), "utf8"); } catch { continue; }
    if (!title.startsWith("tachyon-engine:")) continue;
    // `readlink`, not `realpath`: the kernel keeps the ORIGINAL path in the link and appends
    // " (deleted)" once the file is unlinked. Resolving would throw exactly when the answer matters
    // most — a live engine whose runtime someone already removed still names the runtime it needs,
    // and a measurement that goes blind there would invite the same deletion twice.
    let executable: string;
    try { executable = fs.readlinkSync(path.join(procRoot, pid, "exe")); } catch { continue; }
    const rel = path.relative(root, path.resolve(executable.replace(/ \(deleted\)$/, "")));
    if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const id = rel.split(path.sep)[0];
    if (id !== undefined && id.length > 0) ids.add(id);
  }
  return { measured: true, ids };
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
  // t-7e1b68 — a runtime is in use when a LIVE ENGINE IS EXECUTING IT.
  //
  // This used to ask each retained bundle's manifest for a `runtimeId`, and no manifest has ever
  // carried that key, so the set was always empty and the conservative fallback below marked every
  // runtime in use. The rule could not fire: measured on this machine, 5 runtimes and 760MB, one of
  // them live, none ever collectable.
  //
  // The key was not missing by accident — it was unfillable. A bundle is BUILT (by `npm run release`,
  // on a machine that is not the user's); a runtime is the user's own Extension Host node, copied at
  // activation and content-addressed by its bytes (`stageEngineRuntime`). The pair is per INSTALL,
  // never per build, so the bundle manifest is the wrong place to look and always was.
  //
  // The kernel already answers the real question: `/proc/<pid>/exe` of a live engine IS the runtime
  // binary it is running. That fact needs no producer to remember to write it.
  const live = liveEngineRuntimeIds(runtimesRoot, options.procRoot ?? "/proc");
  const runtimes: RuntimeEntry[] = listDirectories(runtimesRoot).map((entry) => ({
    id: entry.name,
    path: entry.path,
    bytes: directoryBytes(entry.path),
    // An EMPTY answer is not an answer (0.93.46). The first shipped version treated "looked, found no
    // engine running" as evidence and kept "the newest by mtime" as a belt. Both were wrong, and
    // together they deleted the runtime of a live engine on the author's machine: the scan ran in the
    // activation window — old engine already stopped, new one not yet started — so nothing was
    // identified, and the newest DIRECTORY was an older runtime, not the one about to be used.
    //
    // A runtime is collected only when this scan positively identified some runtime as in use: the
    // t-f5769a method applied to the empty case, where not knowing is a reason to keep.
    inUse: !live.measured || live.ids.size === 0 || live.ids.has(entry.name),
    whyInUse: !live.measured
      ? "the process table could not be read here, so nothing about runtimes was measured"
      : live.ids.size === 0
        ? "no engine was running when this was measured, and an empty answer is not evidence of disuse"
        : live.ids.has(entry.name)
          ? "a live engine is running on this runtime"
          : undefined,
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
