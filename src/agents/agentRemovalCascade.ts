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
  if (!result.removed && !result.absent) throw new Error(result.error ?? `could not remove '${agent}' worktree`);
  ports.ledger.clearWorktree(agent);
  ports.managedWorktrees.syncAgentRecord(agent, null);
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
