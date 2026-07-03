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

export interface EditSessionLike { stale: boolean; pending: boolean }

/** dogfood round 3 (#3) — a submit already in flight (`pending`) must never be resubmitted: disabling the
 *  input to show that pending state auto-blurs it (a disabled element can't hold focus), and that blur
 *  re-invokes the SAME onBlur-triggered submit with the ORIGINAL (now-stale) CAS `expect` — a duplicate
 *  request that lands right after the real one already succeeded and fails its own CAS check (the board-side
 *  variant of the detail tab's `afe12fa` bug, here surfacing via `disabled` instead of unmount). Reusing the
 *  session's own `pending` flag as the guard needs no new ref: the flag is already set by the time the
 *  duplicate call happens, since setting it is what caused the disable/blur in the first place. */
export function canSubmitEdit<T extends EditSessionLike>(session: T | undefined): session is T {
  return !!session && !session.stale && !session.pending;
}

export interface CardMenuAction {
  id: "move-to-dropped" | "open-in-studio";
  label: string;
  icon: string;
}

/** t-c0e711 (dogfood round 2 addendum) — the board card's right-click menu, extensible: a card's actions
 *  are computed from the SAME `allowedDropStatuses` affordance data the drag path already uses, never a
 *  separately-invented rule surface. "Edit in Studio" (spec 339) is always offered — Task Studio has no
 *  status-dependent gate, unlike the transition-gated "Move to Dropped" entry. */
export function cardMenuActions(allowedDropStatuses: TaskStatus[]): CardMenuAction[] {
  const actions: CardMenuAction[] = [{ id: "open-in-studio", label: "Edit in Studio", icon: "edit" }];
  if (allowedDropStatuses.includes("dropped")) actions.push({ id: "move-to-dropped", label: "Move to Dropped", icon: "archive" });
  return actions;
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
