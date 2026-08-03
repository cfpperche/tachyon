/**
 * t-6e2952 — shared Control section navigation metadata (icon + English label) for the launcher
 * grid and any other surface that must open the same twelve tabs in the same order.
 *
 * Icons match Control's TabsBar (`TAB_META` in cockpit/App.tsx). Labels match `strings()` in
 * Cockpit.ts (English source of `vscode.l10n.t`); the host re-localizes when pushing tiles.
 *
 * Approvals/Validations stay deep-link-only and are intentionally absent here — the launcher
 * opens the same top-level set as COCKPIT_SECTION_ORDER.
 */

import { COCKPIT_SECTION_ORDER, type CockpitSectionId } from "./model.js";

export interface ControlSectionNav {
  id: CockpitSectionId;
  /** codicon name (no `codicon-` prefix). */
  icon: string;
  /** English product label; localize at the host boundary. */
  label: string;
  /**
   * SDD 485 — true when this tile opens a STANDALONE APP in its own editor tab rather than navigating the
   * Control panel. The tile, the icon and the position are unchanged; what differs is where the click lands,
   * and the label the human reads for it ("Open Board", not "Open Control — Board"). `tachyon.openControl`
   * is still the one door: it routes the id, so the sidebar never has to know which apps exist.
   */
  standalone?: true;
}

/** Top-level only (not approvals/validations deep-links). Keyed by id for O(1) lookup. */
const NAV_BY_ID: ReadonlyMap<CockpitSectionId, Omit<ControlSectionNav, "id">> = new Map([
  ["overview", { icon: "dashboard", label: "Overview" }],
  ["engine", { icon: "server-environment", label: "Engine" }],
  ["fleet", { icon: "organization", label: "Fleet" }],
  ["inbox", { icon: "inbox", label: "Inbox" }],
  ["mission", { icon: "checklist", label: "Board" }],
  ["worktrees", { icon: "folder-library", label: "Worktrees" }],
  ["execution-graph", { icon: "type-hierarchy", label: "Execution" }],
  ["runtime", { icon: "graph", label: "Runtime Ops" }],
  ["runtime-config", { icon: "settings", label: "Runtime Config" }],
  ["tmux", { icon: "terminal-tmux", label: "tmux" }],
  ["plugins", { icon: "extensions", label: "Plugins" }],
  ["settings", { icon: "settings-gear", label: "Settings" }],
]);

/**
 * The launcher grid's order — the twelve tiles, unchanged as a product surface.
 *
 * SDD 485 C5 — this is no longer `COCKPIT_SECTION_ORDER` itself. `mission` (Board) left that list when it
 * became a standalone app, and the launcher is the door to it either way: it lists what the human can OPEN,
 * not what Control happens to render. Keeping the two lists distinct is what lets a migration change a
 * destination without moving a tile, which is exactly what Phase D will do ten more times.
 */
const LAUNCHER_ORDER: readonly CockpitSectionId[] = [
  "overview",
  "engine",
  "fleet",
  "inbox",
  "mission",
  "worktrees",
  "execution-graph",
  "runtime",
  "runtime-config",
  "tmux",
  "plugins",
  "settings",
];

/** the ids whose tile opens a standalone app instead of navigating Control (SDD 485). */
const STANDALONE_APPS = new Set<CockpitSectionId>(["mission", "tmux", "plugins", "runtime", "inbox"]);

/** Top-level launcher entries in product order — the launcher grid's sole catalog. */
export const CONTROL_SECTION_NAV: readonly ControlSectionNav[] = LAUNCHER_ORDER.map((id) => {
  const meta = NAV_BY_ID.get(id);
  if (!meta) {
    // Approvals/validations are on COCKPIT_SECTION_IDS but never on the launcher — should never hit.
    throw new Error(`CONTROL_SECTION_NAV: missing metadata for section '${id}'`);
  }
  return { id, ...meta, ...(STANDALONE_APPS.has(id) ? { standalone: true as const } : {}) };
});

/** Every section Control renders must have a tile — a new section without one is unreachable. */
for (const id of COCKPIT_SECTION_ORDER) {
  if (!LAUNCHER_ORDER.includes(id)) {
    throw new Error(`CONTROL_SECTION_NAV: Control renders section '${id}' but the launcher offers no tile for it`);
  }
}
