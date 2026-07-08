import type { TaskStatus, TaskView } from "./types.js";

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
 * Pure listing sort + optional status filter for the list_tasks Bridge tool (t-f64a90).
 * Does NOT touch TaskStore persistence or the board's read path — applied at the tool layer only.
 *
 * Within a status group, the most recently touched task sorts first (newest-updated desc), so a
 * freshly triaged task lands above a stale triaged one; ties fall back to id for determinism.
 * Returns a NEW array; the caller re-slices to its own limit cap.
 */
export function orderTaskViewsForListing(views: readonly TaskView[], status?: TaskStatus): TaskView[] {
  const filtered = status ? views.filter((v) => v.task.status === status) : views.slice();
  return filtered.sort(byListingOrder);
}

function byListingOrder(a: TaskView, b: TaskView): number {
  const sa = LISTING_STATUS_ORDER[a.task.status] ?? 99;
  const sb = LISTING_STATUS_ORDER[b.task.status] ?? 99;
  if (sa !== sb) return sa - sb;
  const ua = a.task.updatedAt ?? "";
  const ub = b.task.updatedAt ?? "";
  if (ua !== ub) return ub.localeCompare(ua); // newest-updated first
  return a.task.id.localeCompare(b.task.id); // stable, deterministic tiebreak
}
