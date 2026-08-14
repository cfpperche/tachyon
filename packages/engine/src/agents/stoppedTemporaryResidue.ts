/**
 * t-01a425 — classify Temporary ledger rows that outlived a host/machine crash.
 *
 * After a full tmux loss, LifecycleMonitor has no before-state, so every absent Temporary looks
 * "stopped". That is only sometimes true. This module answers which rows kill() would already have
 * collected (safe auto-collect) and which ones still offer Resume / postmortem and must stay until a
 * human (or an explicit dismiss_agent) decides.
 *
 * Present means a tmux session exists under the name — live OR a remain-on-exit dead pane. A dead
 * pane is a deliberate postmortem surface; auto-collect must not tear the ledger out from under it.
 */

import { isTemporaryInstance } from "./agentInstancePolicy.js";
import type { SessionRecord } from "../resume/SessionLedger.js";

export type StoppedTemporaryDisposition = "auto-collect" | "human-review";

export interface StoppedTemporaryResidue {
  name: string;
  disposition: StoppedTemporaryDisposition;
  /** Why this disposition — durable fact, not a guess about crash vs stop. */
  reason:
    | "kill-parity-no-worktree"
    | "owned-worktree"
    | "fork"
    | "clean-exited";
}

export interface ClassifyStoppedTemporaryInput {
  /** Names declared in tachyon.yml (Saved Agents) — never residue. */
  declaredNames: ReadonlySet<string>;
  /** Names with ANY tmux session right now (alive or dead pane). */
  presentSessions: ReadonlySet<string>;
}

/**
 * Classify one ledger row. Returns null when the row is not crash/stop residue of a Temporary
 * listing (Saved, still present in tmux, or missing a Temporary def).
 */
export function classifyStoppedTemporaryResidue(
  name: string,
  rec: SessionRecord,
  input: ClassifyStoppedTemporaryInput,
): StoppedTemporaryResidue | null {
  if (input.declaredNames.has(name)) return null;
  if (input.presentSessions.has(name)) return null;
  if (!rec.def) return null;
  if (!isTemporaryInstance(rec)) return null;

  // kill() keeps forks across Stop; only explicit Dismiss drops them.
  if (rec.def.fork === true) {
    return { name, disposition: "human-review", reason: "fork" };
  }
  // Clean-exit marks the intentional postmortem/resume surface until dismiss.
  if (rec.lifecycle?.state === "clean-exited") {
    return { name, disposition: "human-review", reason: "clean-exited" };
  }
  // kill() keeps a Temporary that still claims a checkout so the removal doors can finish it.
  // Path-on-disk absence is NOT enough to auto-dismiss: the transcript under the old cwd may still
  // be resumable. Human bulk dismiss is the honest door.
  if (rec.worktree) {
    return { name, disposition: "human-review", reason: "owned-worktree" };
  }
  // kill() would have called removeEphemeralFootprint here. Crash skipped that door.
  return { name, disposition: "auto-collect", reason: "kill-parity-no-worktree" };
}

/** Partition every Temporary residue row for a non-ambiguous startup inventory. */
export function partitionStoppedTemporaryResidue(
  ledger: Iterable<readonly [string, SessionRecord]>,
  input: ClassifyStoppedTemporaryInput,
): { autoCollect: StoppedTemporaryResidue[]; humanReview: StoppedTemporaryResidue[] } {
  const autoCollect: StoppedTemporaryResidue[] = [];
  const humanReview: StoppedTemporaryResidue[] = [];
  for (const [name, rec] of ledger) {
    const classified = classifyStoppedTemporaryResidue(name, rec, input);
    if (!classified) continue;
    if (classified.disposition === "auto-collect") autoCollect.push(classified);
    else humanReview.push(classified);
  }
  autoCollect.sort((a, b) => a.name.localeCompare(b.name));
  humanReview.sort((a, b) => a.name.localeCompare(b.name));
  return { autoCollect, humanReview };
}

/** Short name list for notices: up to four quoted names, then "and N more". */
export function formatResidueNames(names: readonly string[], limit = 4): string {
  const sorted = [...names].sort();
  const head = sorted.slice(0, limit).map((n) => `'${n}'`).join(", ");
  if (sorted.length <= limit) return head;
  return `${head}, and ${sorted.length - limit} more`;
}
