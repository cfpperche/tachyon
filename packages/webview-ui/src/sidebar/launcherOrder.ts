/**
 * t-539851 — launcher tile order: the product catalog, A–Z, or a user arrangement.
 *
 * Persistence is the existing sidebar sort pref (`setSort` section `"launcher"`). Absent still
 * means product order (SDD 500 positions). A custom arrangement is that same string, encoded as
 * `custom:id,id,…` — a list of ids, not a new memento key.
 *
 * The third mode is entered by rearranging, never by the A–Z flip: a drag or a keyboard paste
 * while the grid is in product/A–Z writes the custom encoding and leaves A–Z. That is a
 * constraint (keyboard cut/paste cannot live in a transient press-and-hold), not a taste.
 */

import { sortRows, type SortMode } from "./sortRows";

export const LAUNCHER_CUSTOM_PREFIX = "custom:";

export type LauncherPref =
  | { kind: "product" }
  | { kind: "name"; mode: SortMode }
  | { kind: "custom"; ids: readonly string[] };

/**
 * Token shape a custom encoding will accept (section ids are kebab-case).
 *
 * 514 — one colon is allowed, for `app:<id>`. Without it a custom order containing an installed
 * app's tile is rejected here and never persists, while the optimistic update in the sidebar makes
 * the arrangement look correct until the next reload throws it away. Rejected `app-<id>`: it would
 * fit the old token, at the cost of putting collision with a built-in back on the naming convention
 * this prefix exists to take it off of.
 */
const ID_TOKEN = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$/;

export function encodeLauncherCustom(ids: readonly string[]): string {
  return LAUNCHER_CUSTOM_PREFIX + ids.join(",");
}

/**
 * Host write-guard: only name-asc/name-desc or a well-formed custom encoding persist.
 * Garbage stays out of the memento — the same rule the two list sections already have.
 */
export function isPersistedLauncherMode(mode: string): boolean {
  if (mode === "name-asc" || mode === "name-desc") return true;
  if (!mode.startsWith(LAUNCHER_CUSTOM_PREFIX)) return false;
  const rest = mode.slice(LAUNCHER_CUSTOM_PREFIX.length);
  if (!rest) return false;
  return rest.split(",").every((id) => ID_TOKEN.test(id));
}

/**
 * Read a persisted launcher pref.
 *
 * Unknown non-custom strings coerce to name-asc — the same `asSortMode` rule the list sections
 * use — so a corrupt value cannot silently restore product order and hide that a choice was made.
 */
export function parseLauncherPref(v: unknown): LauncherPref {
  if (v === undefined || v === null || v === "") return { kind: "product" };
  if (v === "name-asc" || v === "name-desc") return { kind: "name", mode: v };
  if (typeof v === "string" && v.startsWith(LAUNCHER_CUSTOM_PREFIX)) {
    const ids = v.slice(LAUNCHER_CUSTOM_PREFIX.length).split(",").filter((id) => id.length > 0);
    return { kind: "custom", ids };
  }
  return { kind: "name", mode: "name-asc" };
}

/**
 * Apply a saved custom id list to the current catalog.
 *
 * Unknown (catalog id the saved list does not name): appended at the END, in catalog (product)
 * order. A newly installed app must not insert into an arrangement the user already made.
 *
 * Orphan (saved id the catalog no longer has): dropped here, at apply time. Painting does not
 * rewrite the memento; the next user reorder persists the cleaned list.
 *
 * Duplicates in the saved list keep the first occurrence.
 */
export function applyLauncherOrder<T extends { id: string }>(
  catalog: readonly T[],
  savedIds: readonly string[],
): T[] {
  const byId = new Map(catalog.map((tile) => [tile.id, tile]));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const id of savedIds) {
    const tile = byId.get(id);
    if (!tile || seen.has(id)) continue;
    seen.add(id);
    out.push(tile);
  }
  for (const tile of catalog) {
    if (seen.has(tile.id)) continue;
    out.push(tile);
  }
  return out;
}

/**
 * Move `fromId` so it occupies the current index of `toId`.
 *
 * `[A,B,C,D]` dropped A onto C → `[B,C,A,D]`. Same function for pointer drop and keyboard paste.
 */
export function moveLauncherTile(ids: readonly string[], fromId: string, toId: string): string[] {
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return [...ids];
  const next = [...ids];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** The tiles in the order the grid should paint for this pref. */
export function orderLauncherTiles<T extends { id: string; label: string }>(
  catalog: readonly T[],
  pref: LauncherPref,
): T[] {
  if (pref.kind === "name") return sortRows(catalog, pref.mode, (tile) => tile.label);
  if (pref.kind === "custom") return applyLauncherOrder(catalog, pref.ids);
  return [...catalog];
}
