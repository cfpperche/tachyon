/**
 * spec 335 — pure decision helpers for the board's drag/edit-session interactions, extracted so the tricky
 * concurrency edges (dueto F3/F5/F7) are unit-testable without a DOM. The Preact components own state
 * (which session is open, what's being dragged); every actual DECISION funnels through here.
 */

import { between } from "../../tasks/rank";
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
  /** dueto F1/F2 (Gated v1.1) — the dragged card's priority at drag-start, so `resolveReorder` can tell
   *  whether a hovered card is in the SAME status/priority lane (reorder is only defined "two cards with equal
   *  priority in the same column"); unused by status-transition drags (`resolveDrop`). */
  priority?: TaskPriority;
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

export type ReorderDecision =
  | { action: "commit"; patch: TaskUpdateInput }
  | { action: "rebalance"; laneStatus: TaskStatus; lanePriority?: TaskPriority; orderedIds: string[]; expect: Record<string, string> }
  | { action: "noop" }
  | { action: "cancel"; reason: "stale-board" };

/**
 * spec 335 (Gated v1.1, dueto F1/F2/F3/F5) — in-column rank reorder decision. Validates against the LATEST
 * known task first (dueto F3, same discipline as `resolveDrop`): a stale source cancels fail-closed. Then
 * tries a single-task write first: mints a midpoint rank between the drop point's neighbors (pure, exhaustively
 * tested `between()`); if a midpoint exists, commits `TaskStore.update` with CAS `expect:{status, updatedAt}`
 * — the store itself rejects a same-lane rank collision (dueto F2, two concurrent drags racing the same gap).
 * Only when `between()` finds no room does this ask for a store-owned lane rebalance (`TaskStore.reorderLane`).
 *
 * @param fullLaneOrdered every task currently in the dragged task's status/priority lane, INCLUDING the dragged
 *   task itself, already sorted in current display order (from the LATEST snapshot, not the stale drag-start
 *   one — dueto F3 generalizes to reorder too).
 * @param dropBeforeId the id of the sibling the dragged task should land immediately before; `undefined` means
 *   "append at the end of the lane".
 */
export function resolveReorder(
  session: DragSession,
  latestTask: Task | undefined,
  fullLaneOrdered: Task[],
  dropBeforeId: string | undefined,
): ReorderDecision {
  if (!latestTask || latestTask.status !== session.fromStatus || latestTask.updatedAt !== session.startUpdatedAt) {
    return { action: "cancel", reason: "stale-board" };
  }
  const withoutDragged = fullLaneOrdered.filter((t) => t.id !== latestTask.id);
  const targetIndex = dropBeforeId === undefined ? withoutDragged.length : withoutDragged.findIndex((t) => t.id === dropBeforeId);
  if (targetIndex === -1) return { action: "cancel", reason: "stale-board" }; // the drop's neighbor left the lane mid-drag

  const currentIndex = fullLaneOrdered.findIndex((t) => t.id === latestTask.id);
  const alreadyThere = dropBeforeId === undefined
    ? currentIndex === fullLaneOrdered.length - 1
    : fullLaneOrdered[currentIndex + 1]?.id === dropBeforeId;
  if (currentIndex !== -1 && alreadyThere) return { action: "noop" };

  const before = targetIndex > 0 ? withoutDragged[targetIndex - 1] : undefined;
  const after = targetIndex < withoutDragged.length ? withoutDragged[targetIndex] : undefined;
  const mid = between(before?.rank, after?.rank);
  if (mid !== undefined) {
    return {
      action: "commit",
      patch: { rank: mid, expect: { status: session.fromStatus, updatedAt: session.startUpdatedAt } },
    };
  }

  const orderedIds = [...withoutDragged.slice(0, targetIndex).map((t) => t.id), latestTask.id, ...withoutDragged.slice(targetIndex).map((t) => t.id)];
  const expect: Record<string, string> = { [latestTask.id]: latestTask.updatedAt };
  for (const t of withoutDragged) expect[t.id] = t.updatedAt;
  return { action: "rebalance", laneStatus: session.fromStatus, lanePriority: latestTask.priority, orderedIds, expect };
}
