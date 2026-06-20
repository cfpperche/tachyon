/**
 * Pure feed logic for the Activity view (spec 238 perf + Tier 2). No preact/DOM/vscode — the decision rules
 * the webview draws from, extracted so they're unit-testable in the node harness (the webview .tsx layer
 * itself is only exercised in EDH). Keep this side-effect-free.
 */
import type { ActivityItem } from "../../activity/activityView.js";

/** How much of a tool's full output to fold into the search haystack — bounds per-rebuild work so a 600-item
 *  feed with multi-MB tool bodies can't make search janky. */
export const SEARCH_BODY_CAP = 2000;

/** Items in the live tail stay fully rendered (exact height for bottom-stick); older items get
 *  content-visibility so the browser skips their offscreen layout/paint. */
export const TAIL_LIVE = 30;

export interface SearchEntry {
  it: ActivityItem;
  /** Lowercased, body-capped haystack — precomputed once per item list, reused across keystrokes. */
  hay: string;
}

/** Build the lowercased search index ONCE per item list (not per keystroke). */
export function buildSearchIndex(items: ActivityItem[]): SearchEntry[] {
  return items.map((it) => ({
    it,
    hay: `${it.title ?? ""}\n${it.detail ?? ""}\n${it.result ?? ""}\n${(it.resultFull ?? "").slice(0, SEARCH_BODY_CAP)}`.toLowerCase(),
  }));
}

/** Filter the index by a (possibly empty) query — case-insensitive substring over the precomputed haystack. */
export function filterIndex(index: SearchEntry[], query: string): ActivityItem[] {
  const q = query.trim().toLowerCase();
  return q ? index.filter((e) => e.hay.includes(q)).map((e) => e.it) : index.map((e) => e.it);
}

/** The smallest `sequence` that stays OUT of content-visibility — i.e. items with `sequence >= this` are the
 *  live tail. Measured in item space (sequences are monotonic) so interleaved day separators can't shrink
 *  the fully-rendered tail below `tail`. Returns -Infinity when there's no item to exclude. */
export function tailFromSequence(items: ActivityItem[], tail = TAIL_LIVE): number {
  return items.length > tail ? items[items.length - tail].sequence : -Infinity;
}

/** True when the host trimmed the oldest items to a render cap — drives the visible "recent N of M" notice.
 *  Suppressed while a search is active (the filtered view isn't the full loaded window). */
export function isCapped(totalItems: number | undefined, loadedCount: number, query: string): boolean {
  return !query.trim() && typeof totalItems === "number" && totalItems > loadedCount;
}
