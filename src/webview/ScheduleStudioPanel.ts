import type { StudioPanelState } from "./shared/studio/StudioPanelManagerBase.js";
import type { ScheduleStudioPatch } from "./schedule-studio-shell/domain.js";

export const SCHEDULE_STUDIO_SHELL_VIEW_TYPE = "tachyonScheduleStudioShell";

/**
 * t-610705 (SDD 410 Phase D, D1a) — the standalone Schedule Studio panel was retired: it's a Control
 * route now (studio-new/studio-edit, studio:"schedule" — studios-routes-design.md). src/webview/
 * schedule-studio-shell/App.tsx stays, lazy-imported by cockpit/App.tsx. The trusted serializer for
 * the legacy "tachyonScheduleStudioShell" viewType stays registered in extension.ts: a revived
 * pre-410 panel disposes itself and redirects into Control → the mapped studio route. The old
 * `refreshReferenceData()` fan-out (external tachyon.yml command/agent changes) is now
 * `refreshCockpitStudioReferenceData()` (Cockpit.ts) → `refreshStudioReferenceData` (studioHost.ts).
 */
export type ScheduleStudioPanelState = StudioPanelState<ScheduleStudioPatch>;
