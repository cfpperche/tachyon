import fs from "node:fs";
import type { GitExec } from "../worktree/WorktreeManager.js";
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
  now?: () => string;
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

  const branchWorktrees = await worktreesUsingBranch(delivery.branchRef, deps);
  const otherWorktree = branchWorktrees.find((p) => fs.realpathSync.native?.(p) !== safeRealpath(delivery.worktreePath));
  if (otherWorktree) reasons.push(`branch is checked out by another worktree: ${otherWorktree}`);

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
  if (live.worktreeExists) {
    const rm = await deps.git(["worktree", "remove", "--force", delivery.worktreePath], deps.workspaceRoot);
    if (rm.code !== 0) return { result: { ok: false, reasons: [`git worktree remove failed: ${rm.stderr.trim() || rm.stdout.trim()}`] } };
    removedWorktree = true;
  }

  let deletedBranch = false;
  const deleteBranch = live.branchExists && (!abandoned || !!input.forceLoseCommits);
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

async function worktreesUsingBranch(branch: string, deps: Pick<PruneDeps, "git" | "workspaceRoot">): Promise<string[]> {
  const out = await deps.git(["worktree", "list", "--porcelain"], deps.workspaceRoot).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (out.code !== 0) return [];
  const paths: string[] = [];
  let currentPath = "";
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length).trim();
    if (line.trim() === `branch refs/heads/${branch}` && currentPath) paths.push(currentPath);
  }
  return paths;
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
