/**
 * t-610705 (SDD 410 Phase C.0) — revive-precedence coordination between the Cockpit's own trusted
 * panel serializer and every retired panel's dispose+redirect shim (Approvals/Plugins/Board/tmux).
 *
 * VS Code does not guarantee the order multiple persisted panels revive in. Without this flag, a
 * legacy shim that fires before Cockpit's own revival can open a fresh Control panel on ITS route,
 * which the real revival then either fights over or silently loses to (found in the router design
 * dueto, "retired-panel revive redirects can overwrite a live cockpit session"). A tiny standalone
 * module — not exported from Cockpit.ts itself — so the panel-manager shims (ApprovalPanel.ts,
 * PluginsPanel.ts) can import it without a circular dependency on Cockpit.ts.
 *
 * Once claimed, a shim's redirect becomes a no-op reveal (or nothing at all, since the shim panel
 * disposes itself either way) — it must NOT re-navigate an already-open/restored Control. Cleared
 * on Cockpit panel dispose so a later legitimate revive can freely reopen Control.
 */
let claimed = false;

export function isCockpitSingletonClaimed(): boolean {
  return claimed;
}

export function markCockpitSingletonClaimed(): void {
  claimed = true;
}

export function clearCockpitSingletonClaim(): void {
  claimed = false;
}
