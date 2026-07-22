import type { StudioPanelState } from "./shared/studio/StudioPanelManagerBase.js";
import type { RunbookStudioPatch } from "./runbook-studio-shell/domain.js";

export const RUNBOOK_STUDIO_SHELL_VIEW_TYPE = "tachyonRunbookStudioShell";

/**
 * t-610705 (SDD 410 Phase D, D1a) — the standalone Runbook Studio panel was retired: it's a Control
 * route now (studio-new/studio-edit, studio:"runbook" — studios-routes-design.md). src/webview/
 * runbook-studio-shell/App.tsx stays, lazy-imported by cockpit/App.tsx. The trusted serializer for
 * the legacy "tachyonRunbookStudioShell" viewType stays registered in extension.ts: a revived
 * pre-410 panel disposes itself and redirects into Control → the mapped studio route. The old
 * `refreshReferenceData()` fan-out (external tachyon.yml command changes) is now
 * `refreshCockpitStudioReferenceData()` (Cockpit.ts) → `refreshStudioReferenceData` (studioHost.ts).
 */
export type RunbookStudioPanelState = StudioPanelState<RunbookStudioPatch>;
