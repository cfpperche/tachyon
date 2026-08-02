/**
 * t-48f504 — binding a spawn to a board task, so the two records that name an agent's work cannot
 * disagree.
 *
 * ## The two authorities
 *
 * A freshly launched agent is told what it is for by two different documents:
 *
 *  1. the SPAWN CONTRACT (spec 246 — `spawn_agent`'s task/context/constraints/deliverable), free
 *     text authored by the spawner and frozen at the moment of the call;
 *  2. the WORK ON RECORD section (`sessionWorkRecord.ts`), projected LIVE from the board at launch
 *     out of `assignee == me && status == active`.
 *
 * They are not redundant and must not be collapsed: the contract is the only place the DIRECTIVE
 * exists (nobody else writes it), while the board is the shared register a human, the Interface or
 * another agent can change after the spawn. What was missing is that nothing tied them together, so
 * a spawn could name `t-abc123` in its contract while the board said the agent held nothing —
 * measured three times on 2026-08-01, each time costing a full launch and a refusal.
 *
 * `claim_task` closes that by construction: the same call that launches the agent moves the task to
 * `active` with the child as assignee, so the contract and the record are ONE fact for the claimed
 * task rather than two that happen to agree. `primer.ts` states the precedence for every spawn that
 * does NOT claim, because an unclaimed spawn can still diverge and the product now says which wins.
 *
 * ## What this module owns
 *
 * The DECISION only — pure, table-testable, no store. Whether a given board row may be claimed by a
 * given agent, and the sentence a refusal says. The Bridge handler owns applying it.
 *
 * ## What it deliberately does not do
 *
 * It does not skip triage. `inbox` is refused BY NAME, for the same reason `TASK_RECONCILE_TRANSITIONS`
 * refuses it (TaskStore.ts): triage answers "is this work we wanted?", and pointing a spawn at a task
 * is not an answer to that question — it is someone asserting the work is wanted by the act of
 * starting it. The four operations behind t-48f504 collapse to two (`triaged`, then spawn), and the
 * one that disappears is the mechanical `active`+`assignee` pair, never the human decision.
 */

/** The part of a board row this decision reads. Narrow on purpose, so the module stays a leaf. */
export interface ClaimableTaskRow {
  id: string;
  status: string;
  assignee?: string;
}

export type SpawnTaskClaimDecision =
  /** The row must be moved to `active` with this agent as assignee, in one store transaction. */
  | { kind: "claim" }
  /** Already `active` and already this agent's: the records agree, so nothing is written. */
  | { kind: "already-held" }
  /** The claim cannot happen; `reason` is the sentence the caller hears at the call. */
  | { kind: "refuse"; reason: string };

/** Statuses that positively mean the work is over — the same set the session record treats as closed. */
const CLOSED_STATUSES = new Set(["landed", "done", "dropped"]);

/**
 * May `agent` claim this row by spawning at it?
 *
 * Every refusal names the status it refused from and the operation that would make the spawn legal,
 * because a refusal that only forbids gets worked around (the lesson `PARENT_CWD_REFUSAL` records).
 */
export function decideSpawnTaskClaim(task: ClaimableTaskRow, agent: string): SpawnTaskClaimDecision {
  if (task.status === "inbox") {
    return {
      kind: "refuse",
      reason:
        `spawn_agent cannot claim '${task.id}' for '${agent}': it is in inbox. Triage is a human decision, and ` +
        "spawning an agent at a task is not one — a task nobody has evaluated must not become work merely " +
        "because someone pointed a launch at it. Triage it first (update_task with status 'triaged'), then " +
        "spawn again with the same claim.",
    };
  }
  if (CLOSED_STATUSES.has(task.status)) {
    return {
      kind: "refuse",
      reason:
        `spawn_agent cannot claim '${task.id}' for '${agent}': it is '${task.status}', and that work is closed. ` +
        "Spawning does not reopen a task; retriage it deliberately (update_task with status 'triaged') if it " +
        "must be redone, or create a new task for the remaining work.",
    };
  }
  if (task.status === "active" && task.assignee !== undefined && task.assignee !== agent) {
    return {
      kind: "refuse",
      reason:
        `spawn_agent cannot claim '${task.id}' for '${agent}': it is already active and assigned to ` +
        `'${task.assignee}'. Two agents holding one task is the disagreement this claim exists to prevent. ` +
        "Hand it back first, or spawn with a task of its own.",
    };
  }
  if (task.status === "active" && task.assignee === agent) return { kind: "already-held" };
  // `triaged` (the claimable lane) and the store-impossible `active` with no assignee both take the
  // one store transaction: `status: active` + `assignee`, which `assertTransition` accepts as a unit.
  return { kind: "claim" };
}
