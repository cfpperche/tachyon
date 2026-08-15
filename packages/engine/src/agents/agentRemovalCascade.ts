/**
 * t-e722ce — the two occupancy-and-checkout steps that every agent removal runs, extracted from
 * `extensionOperationService` so BOTH doors can call the same code instead of two copies drifting.
 *
 * They used to live next to the `config.agent.delete` operation, which made them reachable only from
 * the engine's operation layer. Agent Studio's Forget now runs the same cascade (it is the single
 * human door), and `Workspace` cannot import the operation service without a cycle — so the shared
 * behaviour moved down to where both callers can reach it. Nothing about what they do changed;
 * `removeAgentWorktree` now returns its receipt as a typed value rather than pre-serialised JSON,
 * because the cascade above it has to READ `checkoutAlreadyAbsent` and the operation case is the
 * only caller that ever needed it as a wire payload.
 */
import type { AgentOccupancyVerdict } from "./AgentManager.js";
import type { WorktreeRecord, WorktreeRemovalResult, WorktreeAbsence } from "../worktree/WorktreeManager.js";
import { AgentProfileRefusal } from "@tachyon/shared/config/agentProfileRefusal.js";

export interface AgentDeleteSessionManager {
  probeAgentOccupancy(agent: string): Promise<AgentOccupancyVerdict>;
  kill(agent: string): Promise<void>;
}

/**
 * Removal is one confirmed destructive action: its plan promises to tear down a live session before
 * deleting saved state. A stopped remain-on-exit pane is still present in tmux, so it needs the same
 * teardown as a running pane before canonical forget can prove zero occupancy.
 *
 * t-4736b4 — this used to ask `agentStates()`, which serves the last known-good inventory when the
 * tmux read is ambiguous. On the removal path that fallback is a lie in both directions: a stale
 * LIVE entry makes teardown chase a session that is already gone and then declare it unkillable, and
 * a stale ABSENT entry lets the removal skip teardown on an agent that is still up. It now asks for a
 * MEASURED verdict, and an unmeasurable one refuses out loud instead of picking a side.
 *
 * An unknown verdict before the kill still gets the kill attempted — the human already confirmed the
 * teardown, and `kill` on an absent session is a caught no-op — but only a measured `free` afterwards
 * lets the removal continue.
 */
export async function stopAgentSessionForDelete(
  manager: AgentDeleteSessionManager,
  agent: string,
): Promise<void> {
  const before = await manager.probeAgentOccupancy(agent);
  if (before.state === "free") return;
  await manager.kill(agent).catch(() => undefined);
  const after = await manager.probeAgentOccupancy(agent);
  if (after.state === "occupied") {
    throw new Error(`could not stop '${agent}' — it was not removed (${after.detail})`);
  }
  if (after.state === "unknown") {
    throw new Error(
      `could not confirm '${agent}' stopped: occupancy unverifiable — ${after.detail}. `
      + "Removal refuses to guess; nothing durable was deleted. Retry once the tmux server answers.",
    );
  }
}

/**
 * t-05dff5 — the narrow slice of the Workspace this removal actually touches, so the recovery
 * behaviour below is testable without standing up a whole engine. `Workspace` satisfies it.
 */
export interface AgentWorktreeRemovalPorts {
  manager: {
    liveDescendants(agent: string): Promise<string[]>;
    probeAgentOccupancy(agent: string): Promise<AgentOccupancyVerdict>;
    kill(agent: string): Promise<unknown>;
    releaseOwnedWorktreeForRemoval(agent: string, worktreePath: string): Promise<void>;
  };
  ledger: {
    get(agent: string): { worktree?: WorktreeRecord } | undefined;
    clearWorktree(agent: string): void;
  };
  worktrees: {
    remove(
      rec: WorktreeRecord,
      deleteBranch: boolean,
      opts: { force: false; refuseUnlessForceIfDirty: true },
    ): Promise<WorktreeRemovalResult>;
  };
  managedWorktrees: { syncAgentRecord(agent: string, rec: WorktreeRecord | null): void };
}

export interface AgentWorktreeRemovalReceipt {
  removed: boolean;
  branchDeleted: boolean;
  /** t-05dff5 — the checkout was PROVED already gone; nothing was deleted, ownership was released. */
  checkoutAlreadyAbsent?: true;
  absence?: WorktreeAbsence;
  path?: string;
  gitMessage?: string;
  error?: string;
}

/** t-eb25ba — WorktreeManager dirtiness lines (soft remove / refuseUnlessForceIfDirty). */
export function isWorktreeDirtyRefusal(message: string): boolean {
  return /pass confirmDirty=true|worktree is dirty|dirtiness unknown/i.test(message);
}

/**
 * t-eb25ba — agent end-of-life doors soft-remove and refuse dirty trees; they never accept
 * `confirmDirty`. WorktreeManager still says "pass confirmDirty=true" because that parameter is
 * real on `remove_worktree`. A refusal that names a closed door pushed operators to `rm -rf`
 * someone else's checkout. Name exits that work: commit (branch kept when unmerged) or discard
 * the dirt and retry the same kill/dismiss.
 */
export function agentEndOfLifeDirtyRefusal(worktreePath: string, underlying?: string): string {
  const dirtUnknown = /dirtiness unknown/i.test(underlying ?? "");
  if (dirtUnknown) {
    return (
      `worktree dirtiness unknown at ${worktreePath}; agent end-of-life doors (kill_agent, dismiss_agent) ` +
      "never force-remove. Fix git/permissions so dirtiness can be measured, then either commit any " +
      "uncommitted work in that checkout and retry (a branch holding unmerged commits is kept), or " +
      "discard the uncommitted files there and retry. confirmDirty is accepted only by remove_worktree, " +
      "not by kill_agent or dismiss_agent."
    );
  }
  return (
    `worktree is dirty at ${worktreePath}; agent end-of-life doors (kill_agent, dismiss_agent) never ` +
    "force-remove uncommitted work. Commit it in that checkout and retry (a branch holding unmerged " +
    "commits is kept), or discard the uncommitted files there and retry. confirmDirty is accepted only " +
    "by remove_worktree, not by kill_agent or dismiss_agent."
  );
}

/**
 * Remove the checkout an agent owns, and stop owning it.
 *
 * t-05dff5 — IDEMPOTENT when the checkout is already gone. The other door (Control → Worktrees)
 * could remove the same checkout, and a human can delete it by hand; this one then found `git
 * worktree remove` failing with `is not a working tree` and threw BEFORE clearing the ledger, so
 * the row kept owning a directory that did not exist and nothing could release it — forget refused
 * ("still owns a worktree"), and every retry of this action failed the same way.
 *
 * Unlike a confirmed worktree deletion plan, none of the four agent end-of-life doors (UI delete,
 * Bridge dismiss, Agent Studio Forget, Bridge kill) previews uncommitted files. They therefore all
 * use a soft removal and refuse on dirty or unmeasurable state. This deliberately shares the
 * failed-launch rollback's invariant — never erase a write the human has not seen — while differing
 * in outcome: a clean deliberate dismissal finishes cleanup; an unexpected failed launch preserves
 * its checkout regardless, because a time-of-check/time-of-use gap could hide an ignored write.
 *
 * A proved-absent checkout is not a failure: what this action promises is already true, so it
 * finishes the promise — clear the ledger, drop the registry record — and says so in the receipt
 * rather than pretending it deleted something. The proof comes from `WorktreeManager.probeAbsence`
 * (repository + disk), never from the shape of a git error, so a lock, a permission error or a
 * dirty refusal still throws.
 *
 * t-28bf8f — READ THIS AS A TRANSACTION, because a refusal here used to leave half of one. Every
 * durable record mutation is in the last two lines; everything before them either measures or tears
 * down the pane. The pane teardown is not a registry mutation and is what the caller asked for anyway,
 * and since t-28bf8f it no longer collects a Temporary row that still owns this checkout — so a
 * refusal by the descendant gate, either occupancy gate, `releaseOwnedWorktreeForRemoval` (a live root
 * process; the field case) or git itself leaves the agent listed, addressable and retryable, with the
 * checkout, the branch and the registry entry all still claimed by the row that owns them. "Nothing
 * moved" is the only acceptable shape of a refusal on this path; "half moved" strands a checkout that
 * no governed door can reach.
 */
export async function removeAgentWorktree(
  ports: AgentWorktreeRemovalPorts,
  agent: string,
  deleteBranch: boolean,
): Promise<AgentWorktreeRemovalReceipt> {
  const descendants = await ports.manager.liveDescendants(agent);
  if (descendants.length > 0) throw new Error(`cannot remove '${agent}' worktree while descendants are live: ${descendants.join(", ")}`);
  const record = ports.ledger.get(agent)?.worktree;
  if (!record) throw new Error(`'${agent}' has no worktree`);
  // t-4736b4 — measured occupancy, not the last-known-good snapshot: this gate sits on the same
  // removal path as canonical forget and inherited the same way of getting permanently stuck.
  if ((await ports.manager.probeAgentOccupancy(agent)).state !== "free") {
    await ports.manager.kill(agent).catch(() => undefined);
    const after = await ports.manager.probeAgentOccupancy(agent);
    if (after.state === "occupied") {
      throw new Error(`could not stop '${agent}' before removing its worktree (${after.detail})`);
    }
    if (after.state === "unknown") {
      throw new Error(
        `could not confirm '${agent}' stopped before removing its worktree: occupancy unverifiable — ${after.detail}. `
        + "The checkout was left in place; retry once the tmux server answers.",
      );
    }
  }
  await ports.manager.releaseOwnedWorktreeForRemoval(agent, record.path);
  const result = await ports.worktrees.remove(record, deleteBranch, {
    force: false,
    refuseUnlessForceIfDirty: true,
  });
  if (!result.removed && !result.absent) {
    // t-eb25ba — WorktreeManager's soft-remove refusal names `confirmDirty=true`, which is real for
    // `remove_worktree` and false for every agent end-of-life door that shares this cascade
    // (kill_agent, dismiss_agent, UI Remove, Forget). Those doors deliberately never force-remove:
    // they do not preview uncommitted files. Rewrite ONLY dirtiness refusals so the message names
    // exits the caller can take; occupancy / git failures keep their own text.
    const underlying = result.error ?? `could not remove '${agent}' worktree`;
    if (isWorktreeDirtyRefusal(underlying)) {
      throw new AgentProfileRefusal(
        "agent-profile/worktree-removal-dirty",
        agentEndOfLifeDirtyRefusal(record.path, underlying),
      );
    }
    throw new Error(underlying);
  }
  // t-28bf8f — registry first, ledger second, and that order is the invariant rather than a style.
  // These are two file writes and the second can fail; whichever way round they go, one ordering can
  // leave a registry entry whose owning row is gone — the ownerless state that has no governed door —
  // and the other leaves a row still owning an unregistered checkout, which every door can still
  // finish (the retry re-enters here, `probeAbsence` proves the checkout gone, and t-05dff5's
  // already-absent arm completes both records). Only one of those is recoverable.
  ports.managedWorktrees.syncAgentRecord(agent, null);
  ports.ledger.clearWorktree(agent);
  if (result.absent) {
    // The branch is deliberately left alone: nothing proved this checkout's work was merged, and
    // the branch has its own spelled-out delete action.
    return {
      removed: true,
      branchDeleted: false,
      checkoutAlreadyAbsent: true,
      absence: result.absent,
      path: record.path,
      ...(result.error ? { gitMessage: result.error } : {}),
    };
  }
  return { ...result };
}
