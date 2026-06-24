/**
 * spec 242 — the pure, node-testable sort for the sidebar lists (Agents + Terminals). Kept out of the webview
 * layer ("decision logic in the vscode layer escapes CI", spec 240) and GENERIC so both lists reuse it. The
 * sort is name-only (A–Z / Z–A) — always STABLE, so a status change only recolors the dot in place (no reflow).
 * (The live `status` reorder mode was dropped — only the two alphabetical directions remain.)
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
