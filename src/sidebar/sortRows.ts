/**
 * spec 242 — the pure, node-testable sort for the sidebar lists (Agents + Terminals). Kept out of the webview
 * layer ("decision logic in the vscode layer escapes CI", spec 240) and GENERIC so both lists reuse it. The
 * sort is name-only (A–Z / Z–A) — always STABLE, so a status change only recolors the dot in place (no reflow).
 * (The live `status` reorder mode was dropped — only the two alphabetical directions remain.)
 *
 * spec 304 — this module also holds `groupByParent`, a separate post-sort step that groups a spawned
 * (Temporary) agent's row next to its parent. `sortRows` itself stays name-only and parent-unaware; only the
 * Agents list composes the two (Terminals has no `parent` concept).
 */

export type SortMode = "name-asc" | "name-desc";

export const SORT_MODES: SortMode[] = ["name-asc", "name-desc"];

export const SORT_LABEL: Record<SortMode, string> = {
  "name-asc": "Name (A–Z)",
  "name-desc": "Name (Z–A)",
};

/** Coerce an arbitrary string to a known SortMode (defaults to name-asc) — for persisted/unknown values. */
export function asSortMode(v: unknown): SortMode {
  return v === "name-desc" ? "name-desc" : "name-asc";
}

/**
 * Return a NEW sorted array (never mutates the input). name compares locale-aware (case-insensitive, numeric);
 * V8's sort is stable, so equal-keyed rows keep input order.
 */
export function sortRows<T>(rows: readonly T[], mode: SortMode, getName: (r: T) => string): T[] {
  const byName = (a: T, b: T): number => getName(a).localeCompare(getName(b), undefined, { sensitivity: "base", numeric: true });
  const out = [...rows];
  out.sort(mode === "name-desc" ? (a, b) => byName(b, a) : byName);
  return out;
}

/**
 * spec 304 — post-sort grouping: re-emit an already-sorted row list so each spawned agent's row lands
 * immediately after the row it names as `parent` (recursively, so an incidental depth-2+ chain still groups
 * correctly — not a tested contract beyond one level, just a free side effect of the walk). A row whose
 * `parent` doesn't match any row currently in the list (e.g. the parent already exited) is treated as
 * top-level and keeps its normal sorted position. Never mutates the input; same length/rows out as in —
 * a final cleanup pass appends any row only reachable through a `parent` reference cycle (never expected in
 * practice, but the walk must not silently drop it) in its original sorted position.
 */
export function groupByParent<T>(rows: readonly T[], getName: (r: T) => string, getParent: (r: T) => string | undefined): T[] {
  const byName = new Map<string, T>();
  for (const r of rows) byName.set(getName(r), r);

  const childrenOf = new Map<string, T[]>();
  const isChild = (r: T): boolean => {
    const p = getParent(r);
    return !!p && p !== getName(r) && byName.has(p);
  };
  for (const r of rows) {
    if (!isChild(r)) continue;
    const p = getParent(r) as string;
    const list = childrenOf.get(p);
    if (list) list.push(r);
    else childrenOf.set(p, [r]);
  }

  const visited = new Set<string>();
  const out: T[] = [];
  const emit = (r: T): void => {
    const name = getName(r);
    if (visited.has(name)) return;
    visited.add(name);
    out.push(r);
    for (const child of childrenOf.get(name) ?? []) emit(child);
  };

  for (const r of rows) if (!isChild(r)) emit(r);
  for (const r of rows) emit(r); // cycle cleanup: only reachable rows left unvisited are cycle members

  return out;
}
