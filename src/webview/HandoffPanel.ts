export const HANDOFF_VIEW_TYPE = "tachyonHandoff";

/**
 * t-610705 (SDD 410 Phase C.3) — the standalone Project Handoff panel was retired: it's a Control
 * section now (src/webview/handoff/App.tsx stays, lazy-imported by cockpit/App.tsx). Unlike Fleet's
 * subroutes (C.2), Handoff folds directly into a section — it's workspace-scoped the same way
 * Approvals/Validations are, not an entity with its own immutable locator, so no new CockpitRoute
 * kind was needed. The trusted serializer for the legacy "tachyonHandoff" viewType stays registered
 * in extension.ts: a revived pre-410 panel disposes itself and redirects into Control → Handoff.
 */
export interface HandoffPanelState {
  schemaVersion: 1;
  view: typeof HANDOFF_VIEW_TYPE;
  wsHash: string;
}
