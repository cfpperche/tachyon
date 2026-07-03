/**
 * spec 335 — pure decision helpers for the board's drag/edit-session interactions, extracted so the tricky
 * concurrency edges (dueto F3/F5/F7) are unit-testable without a DOM. The Preact components own state
 * (which session is open, what's being dragged); every actual DECISION funnels through here.
 */

import type { Task, TaskPriority, TaskStatus, TaskUpdateExpect, TaskUpdateInput } from "../../tasks/types";

/** dueto F5 — a priority quick-edit always composes `rank:null` so a rank minted in another priority lane
 *  never leaks into the new one (board-side composition; no store change needed). */
export function priorityPatch(priority: TaskPriority | null, expect: TaskUpdateExpect): TaskUpdateInput {
  return { priority, rank: null, expect };
}

export function assigneePatch(assignee: string | null, expect: TaskUpdateExpect): TaskUpdateInput {
  return { assignee, expect };
}

/** The store rejects a CAS mismatch with `precondition-failed: …` (TaskStore.assertExpect) — a stale editor
 *  needs an explicit retry from the refreshed value, never a silent overwrite or a silent discard (dueto F7). */
export function isStaleError(message: string): boolean {
  return message.startsWith("precondition-failed");
}

export interface DragSession {
  taskId: string;
  fromStatus: TaskStatus;
  startUpdatedAt: string;
}

export type DropDecision =
  | { action: "commit"; patch: TaskUpdateInput }
  | { action: "noop" }
  | { action: "cancel"; reason: "stale-board" }
  | { action: "reject"; reason: "not-allowed" };

/**
 * dueto F3 (generalized to ALL drags, not just reorder) — validate a drop against the LATEST known task, not
 * the one the drag started from. A push arriving mid-drag is held by the caller (queued, DOM untouched until
 * drag end); this is what actually decides, at drop time, whether that queued state invalidates the drag.
 */
export function resolveDrop(session: DragSession, latestTask: Task | undefined, targetStatus: TaskStatus, allowedDropStatuses: TaskStatus[]): DropDecision {
  if (targetStatus === session.fromStatus) return { action: "noop" }; // dropped back in its own column
  if (!latestTask || latestTask.status !== session.fromStatus || latestTask.updatedAt !== session.startUpdatedAt) {
    return { action: "cancel", reason: "stale-board" };
  }
  if (!allowedDropStatuses.includes(targetStatus)) return { action: "reject", reason: "not-allowed" };
  return {
    action: "commit",
    patch: { status: targetStatus, expect: { status: session.fromStatus, updatedAt: session.startUpdatedAt } },
  };
}
