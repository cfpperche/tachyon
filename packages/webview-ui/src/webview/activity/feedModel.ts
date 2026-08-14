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

export const ACTIVITY_FILTER_CATEGORIES = ["chat", "tools", "system", "thinking", "media"] as const;
export type ActivityFilterCategory = (typeof ACTIVITY_FILTER_CATEGORIES)[number];
export type ActivityFilterState = Record<ActivityFilterCategory, boolean>;

export const DEFAULT_ACTIVITY_FILTERS: ActivityFilterState = {
  chat: true,
  tools: true,
  system: true,
  thinking: true,
  media: true,
};

export const ACTIVITY_FILTER_LABELS: Record<ActivityFilterCategory, string> = {
  chat: "Messages",
  tools: "Tools",
  system: "System",
  thinking: "Thinking",
  media: "Media",
};

export function activityCategory(kind: ActivityItem["kind"]): ActivityFilterCategory {
  switch (kind) {
    case "message":
    case "command":
      return "chat";
    case "tool":
    case "file":
    case "usage":
    case "error":
    case "raw":
      return "tools";
    case "nudge":
    case "injected":
    case "session":
    case "boundary":
      return "system";
    case "thinking":
      return "thinking";
    case "image":
      return "media";
  }
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

export function normalizeActivityFilters(input: Partial<Record<ActivityFilterCategory, boolean>> | undefined): ActivityFilterState {
  const next: ActivityFilterState = { ...DEFAULT_ACTIVITY_FILTERS, ...(input ?? {}) };
  return ACTIVITY_FILTER_CATEGORIES.some((category) => next[category]) ? next : { ...DEFAULT_ACTIVITY_FILTERS };
}

export function toggleActivityFilter(filters: ActivityFilterState, category: ActivityFilterCategory): ActivityFilterState {
  const next = { ...filters, [category]: !filters[category] };
  return ACTIVITY_FILTER_CATEGORIES.some((c) => next[c]) ? next : filters;
}

export function filterByActivityTypes(items: ActivityItem[], filters: ActivityFilterState): ActivityItem[] {
  return items.filter((it) => filters[activityCategory(it.kind)]);
}

export function hiddenByActivityTypes(items: ActivityItem[], filters: ActivityFilterState): number {
  return items.length - filterByActivityTypes(items, filters).length;
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
