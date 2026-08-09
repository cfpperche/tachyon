/**
 * t-6e2952 — shared Control section navigation metadata (icon + English label) for the launcher
 * grid and any other surface that must open the same tabs in the same order.
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
  ["inbox", { icon: "inbox", label: "Inbox" }],
  ["mission", { icon: "checklist", label: "Board" }],
  ["worktrees", { icon: "folder-library", label: "Worktrees" }],
  ["runtime", { icon: "graph", label: "Runtime Ops" }],
  ["runtime-config", { icon: "settings", label: "Runtime Config" }],
  ["tmux", { icon: "terminal-tmux", label: "tmux" }],
  ["plugins", { icon: "extensions", label: "Plugins" }],
  ["settings", { icon: "settings-gear", label: "Settings" }],
]);

/**
 * The launcher grid's order — the tiles, in product order.
 *
 * SDD 485 C5 — this is no longer `COCKPIT_SECTION_ORDER` itself. `mission` (Board) left that list when it
 * became a standalone app, and the launcher is the door to it either way: it lists what the human can OPEN,
 * not what Control happens to render. Keeping the two lists distinct is what lets a migration change a
 * destination without moving a tile, which is exactly what Phase D did ten more times.
 *
 * t-5f2b5b — and what lets a tile be DELETED without touching the id it named. `fleet` left this list
 * (owner decision, 2026-08-07: the sidebar Agents tab is the only fleet, so the tile had nowhere worth
 * going) while staying a `CockpitSectionId`: it is still the parent section of the agent-activity and
 * agent-probes subroutes and of five studios, so it must still decode. Eleven tiles now, not twelve.
 */
const LAUNCHER_ORDER: readonly CockpitSectionId[] = [
  "overview",
  "engine",
  "inbox",
  "mission",
  "worktrees",
  "runtime",
  "runtime-config",
  "tmux",
  "plugins",
  "settings",
];

/** the ids whose tile opens a standalone app instead of navigating Control (SDD 485). */
const STANDALONE_APPS = new Set<CockpitSectionId>(LAUNCHER_ORDER);

/** Top-level launcher entries in product order — the launcher grid's sole catalog. */
export const CONTROL_SECTION_NAV: readonly ControlSectionNav[] = LAUNCHER_ORDER.map((id) => {
  const meta = NAV_BY_ID.get(id);
  if (!meta) {
    // Approvals/validations are on COCKPIT_SECTION_IDS but never on the launcher — should never hit.
    throw new Error(`CONTROL_SECTION_NAV: missing metadata for section '${id}'`);
  }
  return { id, ...meta, ...(STANDALONE_APPS.has(id) ? { standalone: true as const } : {}) };
});

/**
 * The codicon a section is drawn with, wherever it is drawn.
 *
 * t-icon — the editor TAB of a standalone section app is the second place a section wears an icon, and
 * until now each app declared its own `iconName` beside the launcher's. Two declarations of one fact drift
 * by default: `mission` was shipping the launcher's `checklist` glyph under the name `tasklist`, and
 * `runtime` declared `graph` against an asset that did not exist — so the Runtime Ops tab had NO icon at
 * all, because `panelIcon` builds a Uri and a missing file is a silent fallback to VS Code's generic one.
 *
 * `SectionPanelManager` resolves through here for any app whose manifest row names a `section`, so the two
 * surfaces cannot disagree: there is one name, and changing it changes both.
 */
export function controlSectionIcon(id: CockpitSectionId): string {
  const meta = NAV_BY_ID.get(id);
  // Every caller passes a literal from the manifest, so a miss is a typo at startup, not a runtime branch.
  if (!meta) throw new Error(`controlSectionIcon: no launcher metadata for section '${id}'`);
  return meta.icon;
}

/** Every section Control renders must have a tile — a new section without one is unreachable. */
for (const id of COCKPIT_SECTION_ORDER) {
  if (!LAUNCHER_ORDER.includes(id)) {
    throw new Error(`CONTROL_SECTION_NAV: Control renders section '${id}' but the launcher offers no tile for it`);
  }
}
