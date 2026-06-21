import type { AgentStatus } from "./types";

/**
 * spec 242 — the pure, node-testable sort for status-bearing sidebar lists (Agents + Terminals). Kept out of
 * the webview layer (the "decision logic in the vscode layer escapes CI" lesson, spec 240) and GENERIC so both
 * lists reuse it. Default `name-asc` is STABLE — a status change only recolors the dot in place (no reflow);
 * `status` is the opt-in "live" mode that intentionally reorders.
 */

export type SortMode = "name-asc" | "name-desc" | "status";

export const SORT_MODES: SortMode[] = ["name-asc", "name-desc", "status"];

export const SORT_LABEL: Record<SortMode, string> = {
  "name-asc": "Name (A–Z)",
  "name-desc": "Name (Z–A)",
  status: "Status (live)",
};

/** Canonical status precedence for the `status` sort (most-active first). */
const STATUS_RANK: Record<AgentStatus, number> = { running: 0, needs: 1, idle: 2, stopped: 3, crashed: 4 };

/** Coerce an arbitrary string to a known SortMode (defaults to name-asc) — for persisted/unknown values. */
export function asSortMode(v: unknown): SortMode {
  return v === "name-desc" || v === "status" ? v : "name-asc";
}

/**
 * Return a NEW sorted array (never mutates the input). name compares locale-aware (case-insensitive, numeric);
 * `status` uses STATUS_RANK with a name tiebreak. V8's sort is stable, so equal-keyed rows keep input order.
 */
export function sortStatusRows<T>(rows: readonly T[], mode: SortMode, getName: (r: T) => string, getStatus: (r: T) => AgentStatus): T[] {
  const byName = (a: T, b: T): number => getName(a).localeCompare(getName(b), undefined, { sensitivity: "base", numeric: true });
  const out = [...rows];
  if (mode === "name-desc") out.sort((a, b) => byName(b, a));
  else if (mode === "status") out.sort((a, b) => STATUS_RANK[getStatus(a)] - STATUS_RANK[getStatus(b)] || byName(a, b));
  else out.sort(byName);
  return out;
}
