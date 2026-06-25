/**
 * spec 264 — the ASYNC git facts the (sync) install preview consumes. The engine is sync (specs 250/263); git
 * I/O is subprocess I/O, so the async caller (the panel, or applyInstall) gathers these facts ONCE and injects
 * them into `previewInstall` — which then plans + fingerprints synchronously. Read-only.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { GitRepo } from "./gitRepo.js";
import { GitHookStore, type OwnershipRecord } from "./gitHookRegistry.js";
import { defaultGitRun, type GitRun } from "./fetcher.js";

/** The identity of a captured prior hook (bound into the consent fingerprint so a change re-prompts). */
export interface PriorHookIdentity {
  path: string;
  mode: number;
  type: "file" | "symlink";
  symlinkTarget?: string;
  contentHash: string;
}

export interface GitHookState {
  /** false ⇒ not a git work tree (git-hook install impossible here). */
  isRepo: boolean;
  /** true ⇒ `extensions.worktreeConfig` is on; Tachyon refuses to manage hooks (ambiguous scope). */
  worktreeConfig: boolean;
  /** current `core.hooksPath` (raw + top-level-resolved), or undefined when unset. */
  hooksPath?: { raw: string; resolved: string };
  /** per requested event → the chainable prior-hook identity (null = none). */
  priorHooks: Record<string, PriorHookIdentity | null>;
  /** the managed ownership record, when Tachyon already owns `core.hooksPath`. */
  ownership?: OwnershipRecord;
}

/** Capture a hook file's identity iff it is a chainable real hook: an executable regular/symlink file, not a
 *  `.sample`. (A `.sample`, a non-executable, or a dir → not a prior hook → null.) */
export function capturePriorHook(file: string): PriorHookIdentity | null {
  if (file.endsWith(".sample")) return null;
  let lst: fs.Stats;
  try { lst = fs.lstatSync(file); } catch { return null; }
  const type: "file" | "symlink" | null = lst.isSymbolicLink() ? "symlink" : lst.isFile() ? "file" : null;
  if (!type) return null;
  let real: fs.Stats;
  let content: Buffer;
  let symlinkTarget: string | undefined;
  try {
    if (type === "symlink") symlinkTarget = fs.readlinkSync(file);
    real = fs.statSync(file); // follow symlink for mode + content
    if (!real.isFile()) return null; // a symlink to a non-file is not a runnable hook
    content = fs.readFileSync(file);
  } catch {
    return null;
  }
  if ((real.mode & 0o111) === 0) return null; // git only runs an executable hook
  return { path: file, mode: real.mode, type, symlinkTarget, contentHash: crypto.createHash("sha256").update(content).digest("hex") };
}

/** Gather the git-hook state for `events`. Read-only; never writes. */
export async function gatherGitHookState(workspaceRoot: string, events: readonly string[], git: GitRun = defaultGitRun): Promise<GitHookState> {
  const repo = new GitRepo(workspaceRoot, git);
  if (!(await repo.isWorkTree())) return { isRepo: false, worktreeConfig: false, priorHooks: {} };
  const worktreeConfig = await repo.worktreeConfigEnabled();
  const hooksPath = await repo.getHooksPath();

  const store = new GitHookStore(workspaceRoot);
  let ownership: OwnershipRecord | undefined;
  try { ownership = store.readOwnership(); } catch { ownership = undefined; } // corrupt → treat as not-owned (apply re-checks fail-closed)
  const managedResolved = ownership ? path.resolve(workspaceRoot, ownership.managedPath) : undefined;
  const owns = !!hooksPath && !!managedResolved && path.resolve(hooksPath.resolved) === managedResolved;

  // when already managed, the prior hook each event chains to was captured at the FIRST claim (in the snapshot);
  // when not managed, the chainable prior hook is `<hooksPath>/<event>` if set, else the default hooks dir.
  const snapshot = owns ? safeSnapshot(store) : undefined;
  const priorHooks: Record<string, PriorHookIdentity | null> = {};
  for (const event of events) {
    if (owns) {
      const ph = snapshot?.events[event]?.priorHook ?? null;
      priorHooks[event] = ph ? { path: ph.origin.path, mode: ph.origin.mode, type: ph.origin.type, symlinkTarget: ph.origin.symlinkTarget, contentHash: ph.contentHash } : null;
    } else {
      const file = hooksPath ? path.join(hooksPath.resolved, event) : await repo.hookPath(event);
      priorHooks[event] = capturePriorHook(file);
    }
  }
  return { isRepo: true, worktreeConfig, hooksPath, priorHooks, ownership };
}

function safeSnapshot(store: GitHookStore) {
  try { return store.readSnapshot(); } catch { return undefined; }
}
