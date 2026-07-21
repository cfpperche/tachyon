export const PROBES_VIEW_TYPE = "tachyonProbes";

/**
 * t-610705 (SDD 410 Phase C.2) — the standalone Probes panel was retired: it's a Control subroute
 * now (fleet/agent/<name>/probes when `caller` is set, else the unfiltered fleet/probes debug route
 * — src/webview/probes/App.tsx stays, lazy-imported by cockpit/App.tsx). The trusted serializer for
 * the legacy "tachyonProbes" viewType stays registered in extension.ts: a revived pre-410 panel
 * disposes itself and redirects into Control → the matching probes subroute.
 */
export interface ProbesPanelState {
  schemaVersion: 1;
  view: typeof PROBES_VIEW_TYPE;
  wsHash: string;
  caller?: string;
}
