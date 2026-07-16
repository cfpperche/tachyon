import fs from "node:fs";
import type { GitExec, WorktreeOccupancyProbe } from "../worktree/WorktreeManager.js";
import { classifyDelivery, containedInBase, type DeliveryLiveness } from "./classify.js";
import type { GitDelivery, GitDeliveryActor } from "./types.js";

export interface PruneInput {
  id: string;
  expectedVersion: number;
  forceLoseCommits?: boolean;
  doomedShas?: string[];
  abandon?: boolean;
}

export interface PruneDeps {
  workspaceRoot: string;
  git: GitExec;
  liveness: DeliveryLiveness;
  worktreeOccupancy?: WorktreeOccupancyProbe;
  now?: () => string;
  /**
   * spec 392 — preferred removal path (WorktreeManager / ManagedWorktreeService).
   * When absent, falls back to raw `git worktree remove` for unit tests that only inject git.
   */
  removeManagedWorktree?: (
    worktreePath: string,
    opts?: { deleteBranch?: boolean; branch?: string; tachyonCreatedBranch?: boolean; baseRef?: string; force?: boolean },
  ) => Promise<{ removed: boolean; branchDeleted: boolean; error?: string }>;
}

export type PruneResult =
  | { ok: true; removedWorktree: boolean; deletedBranch: boolean; lostShas?: string[]; message: string }
  | { ok: false; reasons: string[] };

export async function pruneDeliveryRecord(delivery: GitDelivery, input: PruneInput, actor: GitDeliveryActor, deps: PruneDeps): Promise<{ result: PruneResult; next?: GitDelivery }> {
  const live = await classifyDelivery(delivery, deps);
  const reasons: string[] = [];
  const targetPhase = input.abandon ? "abandoned" : delivery.phase;

  if (live.liveState !== "not_live") reasons.push(`agent liveness is ${live.liveState}`);
  if (live.worktreeExists && !live.clean) reasons.push("worktree is dirty");
  if (live.worktreeExists) {
    let occupant: Awaited<ReturnType<WorktreeOccupancyProbe>> | undefined;
    let occupancyUnknown: string | undefined;
    try {
      if (!deps.worktreeOccupancy) {
        occupancyUnknown = "worktree occupancy is unknown";
      } else {
        occupant = await deps.worktreeOccupancy(delivery.worktreePath);
      }
    } catch (err) {
      occupancyUnknown = `worktree occupancy is unknown: ${err instanceof Error ? err.message : String(err)}`;
    }
    // Occupancy is always fail-closed (spec 392). abandon/forceLoseCommits may force
    // *dirty* git remove after occupancy clears, but never override a live/unknown occupant.
    if (occupant) {
      reasons.push(
        `worktree is ${occupant.state === "dirty" ? "quarantined by" : "occupied by live"} agent ${occupant.agent}`,
      );
    } else if (occupancyUnknown) {
      reasons.push(occupancyUnknown);
    }
  }

  const worktrees = await listGitWorktrees(deps);
  const deliveryRealpath = safeRealpath(delivery.worktreePath);
  const deliveryWorktree = worktrees.find((w) => safeRealpath(w.path) === deliveryRealpath);
  const expectedBranchRef = `refs/heads/${delivery.branchRef}`;
  const otherWorktree = worktrees.find((w) => w.branch === expectedBranchRef && safeRealpath(w.path) !== deliveryRealpath);
  if (otherWorktree) reasons.push(`branch is checked out by another worktree: ${otherWorktree.path}`);
  if (live.worktreeExists && deliveryWorktree?.branch !== expectedBranchRef) {
    reasons.push(`worktree path is not registered for branch ${expectedBranchRef}`);
  }

  if (!live.branchExists && !live.worktreeExists) {
    const next = transition(delivery, "pruned", actor, deps.now?.() ?? new Date().toISOString(), "missing_ref close");
    return { result: { ok: true, removedWorktree: false, deletedBranch: false, message: "closed missing_ref delivery as pruned" }, next };
  }

  const contained = await containedInBase(delivery, live.currentHeadSha, deps).catch(() => false);
  const abandoned = targetPhase === "abandoned" || delivery.phase === "abandoned";
  if (!abandoned && !(delivery.phase === "integrated" && contained)) {
    reasons.push("delivery is not phase integrated with live containedInBase proof");
  }
  if (delivery.phase === "integrated_unverified") reasons.push("integrated_unverified cannot be branch-pruned without explicit data-loss force");
  if (!delivery.tachyonCreatedBranch && !abandoned) reasons.push("branch was not Tachyon-created");

  let lostShas: string[] = [];
  if (live.branchExists && !contained) {
    lostShas = await commitsNotInBase(delivery.branchRef, delivery.baseRef, deps);
    if (!abandoned || input.forceLoseCommits) {
      const supplied = new Set(input.doomedShas ?? []);
      const missing = lostShas.filter((sha) => !supplied.has(sha));
      if (missing.length > 0) reasons.push(`forceLoseCommits requires doomedShas to list live unintegrated commits: ${missing.join(",")}`);
    }
  }
  if (reasons.length > 0) return { result: { ok: false, reasons } };

  let removedWorktree = false;
  let deletedBranch = false;
  const deleteBranch = live.branchExists && (!abandoned || !!input.forceLoseCommits);
  const forceRemove = !!(input.abandon || input.forceLoseCommits);

  if (live.worktreeExists) {
    if (deps.removeManagedWorktree) {
      // Engine path: occupancy already validated above. force only means dirty/data-loss
      // git remove — never occupancy override (manager refuses occupants even with force).
      const eng = await deps.removeManagedWorktree(delivery.worktreePath, {
        deleteBranch: false, // branch deletion stays below for forceLoseCommits -D vs -d
        branch: delivery.branchRef,
        tachyonCreatedBranch: delivery.tachyonCreatedBranch,
        baseRef: delivery.baseRef,
        force: forceRemove,
      });
      if (!eng.removed) {
        return { result: { ok: false, reasons: [`managed worktree remove failed: ${eng.error ?? "refused"}`] } };
      }
      removedWorktree = true;
    } else {
      const rm = await deps.git(["worktree", "remove", "--force", delivery.worktreePath], deps.workspaceRoot);
      if (rm.code !== 0) return { result: { ok: false, reasons: [`git worktree remove failed: ${rm.stderr.trim() || rm.stdout.trim()}`] } };
      removedWorktree = true;
    }
  }

  if (deleteBranch) {
    const args = input.forceLoseCommits ? ["branch", "-D", delivery.branchRef] : ["branch", "-d", delivery.branchRef];
    const del = await deps.git(args, deps.workspaceRoot);
    if (del.code !== 0) return { result: { ok: false, reasons: [`git branch delete failed after worktree removal: ${del.stderr.trim() || del.stdout.trim()}`] } };
    deletedBranch = true;
  }
  await deps.git(["worktree", "prune"], deps.workspaceRoot).catch(() => ({ code: 0, stdout: "", stderr: "" }));
  const next = transition(delivery, "pruned", actor, deps.now?.() ?? new Date().toISOString(), abandoned && !deletedBranch ? "abandoned worktree pruned; branch kept" : "pruned");
  return { result: { ok: true, removedWorktree, deletedBranch, ...(input.forceLoseCommits ? { lostShas } : {}), message: deletedBranch ? "worktree and branch pruned" : "worktree pruned; branch kept" }, next };
}

function transition(delivery: GitDelivery, to: GitDelivery["phase"], by: GitDeliveryActor, at: string, reason: string): GitDelivery {
  return {
    ...delivery,
    phase: to,
    transitions: [...delivery.transitions, { at, from: delivery.phase, to, by, reason }],
  };
}

interface GitWorktreeEntry {
  path: string;
  branch?: string;
}

async function listGitWorktrees(deps: Pick<PruneDeps, "git" | "workspaceRoot">): Promise<GitWorktreeEntry[]> {
  const out = await deps.git(["worktree", "list", "--porcelain"], deps.workspaceRoot).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (out.code !== 0) return [];
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | undefined;
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim() };
      entries.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).trim();
    }
  }
  return entries;
}

async function commitsNotInBase(branch: string, base: string, deps: Pick<PruneDeps, "git" | "workspaceRoot">): Promise<string[]> {
  const out = await deps.git(["rev-list", `${base}..${branch}`], deps.workspaceRoot).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  return out.code === 0 ? out.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}
