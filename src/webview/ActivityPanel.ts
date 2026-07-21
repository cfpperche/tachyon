export const ACTIVITY_VIEW_TYPE = "tachyonActivity";

/**
 * t-610705 (SDD 410 Phase C.2) — the standalone Activity panel was retired: it's a Control subroute
 * now (fleet/agent/<name>/activity — src/webview/activity/App.tsx stays, lazy-imported by
 * cockpit/App.tsx; Cockpit.ts builds the feed via src/cockpit/activityFeed.ts, ported verbatim from
 * this file's retired `watch()` method). The trusted serializer for the legacy "tachyonActivity"
 * viewType stays registered in extension.ts: a revived pre-410 panel disposes itself and redirects
 * into Control → the agent's activity subroute.
 */
export interface ActivityPanelState {
  schemaVersion: 1;
  view: typeof ACTIVITY_VIEW_TYPE;
  wsHash: string;
  agent: string;
}
