import type { StudioPanelState } from "./shared/studio/StudioPanelManagerBase.js";
import type { TaskPatch } from "./task-studio/domain.js";

export const TASK_STUDIO_VIEW_TYPE = "tachyonTaskStudio";

/**
 * t-610705 (SDD 410 Phase D, D2) — the standalone Task Studio panel was retired: it's a Control
 * studio-edit route now (studios-routes-design.md). src/webview/task-studio/App.tsx stays,
 * lazy-imported by cockpit/App.tsx. The trusted serializer for the legacy "tachyonTaskStudio"
 * viewType stays registered in extension.ts: a revived pre-410 panel disposes itself and redirects
 * into Control → the task's studio-edit route (or Mission, for the rare malformed/legacy "new"-mode
 * panel state — task is never id-less in practice, so there's no studio-new route to redirect to).
 */
export type TaskStudioPanelState = StudioPanelState<TaskPatch>;
