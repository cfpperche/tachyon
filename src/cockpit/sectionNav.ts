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

/** Top-level Control sections in product order — the launcher grid's sole catalog. */
export const CONTROL_SECTION_NAV: readonly ControlSectionNav[] = COCKPIT_SECTION_ORDER.map((id) => {
  const meta = NAV_BY_ID.get(id);
  if (!meta) {
    // Approvals/validations are on COCKPIT_SECTION_IDS but not COCKPIT_SECTION_ORDER — should never hit.
    throw new Error(`CONTROL_SECTION_NAV: missing metadata for section '${id}'`);
  }
  return { id, ...meta };
});
