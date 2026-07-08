import type { Task, TaskStatus, TaskView } from "./types.js";

/**
 * Listing (Mission Control tool) sort priority — actionable work first, terminal/archive last.
 * t-f64a90: the previous read-layer sort was `createdAt` ascending, which surfaced the oldest
 * terminal tasks (done/landed/dropped) and silently truncated triaged/active under the default
 * limit=100 cap. This order keeps the default list_tasks surface alive even at modest limits.
 */
export const LISTING_STATUS_ORDER: Record<TaskStatus, number> = {
  active: 0,
  triaged: 1,
  inbox: 2,
  landed: 3,
  done: 4,
  dropped: 5,
};

/**
 * t-5cca25: single exported source of truth for actionable/newest-first task ordering. Both
 * TaskStore's internal read sort and this module's `orderTaskViewsForListing` (used by the
 * list_tasks Bridge tool) call this same comparator instead of each keeping its own copy.
 *
 * Within a status group, the most recently touched task sorts first (newest-updated desc); ties
 * fall back to createdAt desc, then id, for determinism.
 */
export function compareTasksForListing(a: Task, b: Task): number {
  const sa = LISTING_STATUS_ORDER[a.status] ?? 99;
  const sb = LISTING_STATUS_ORDER[b.status] ?? 99;
  if (sa !== sb) return sa - sb;
  if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt); // newest-updated first
  if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
  return a.id.localeCompare(b.id); // stable, deterministic tiebreak
}

/**
 * Pure listing sort + optional status filter for the list_tasks Bridge tool (t-f64a90).
 * Does NOT touch TaskStore persistence or the board's read path — applied at the tool layer only.
 * Returns a NEW array; the caller re-slices to its own limit cap.
 */
export function orderTaskViewsForListing(views: readonly TaskView[], status?: TaskStatus): TaskView[] {
  const filtered = status ? views.filter((v) => v.task.status === status) : views.slice();
  return filtered.sort((a, b) => compareTasksForListing(a.task, b.task));
}
