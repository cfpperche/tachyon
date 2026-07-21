export const MISSION_CONTROL_VIEW_TYPE = "tachyonMissionControl";

/**
 * t-610705 (SDD 410 Phase B #6) — the standalone Mission Control panel was retired: the Board is a
 * cockpit section only now (src/webview/mission-control/App.tsx stays, lazy-imported by
 * cockpit/App.tsx; Cockpit.ts routes every board action and builds the VM via
 * src/cockpit/missionVm.ts, which carries the panel's bounded/coalesced agent-liveness pass).
 * What survives here is the persisted-state shape: the trusted serializer in extension.ts disposes
 * a revived pre-410 panel and redirects into Control → Mission scoped to state.wsHash.
 */
export interface MissionControlPanelState {
  schemaVersion: 1;
  view: typeof MISSION_CONTROL_VIEW_TYPE;
  wsHash: string;
}
