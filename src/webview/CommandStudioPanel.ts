import type { StudioPanelState } from "./shared/studio/StudioPanelManagerBase.js";
import type { CommandStudioPatch } from "./command-studio-shell/domain.js";

export const COMMAND_STUDIO_SHELL_VIEW_TYPE = "tachyonCommandStudioShell";

/**
 * t-610705 (SDD 410 Phase D, D0) — the standalone Command Studio panel was retired: it's the pilot
 * Control route now (studio-new/studio-edit with studio:"command" — studios-routes-design.md).
 * src/webview/command-studio-shell/App.tsx stays, lazy-imported by cockpit/App.tsx. The trusted
 * serializer for the legacy "tachyonCommandStudioShell" viewType stays registered in extension.ts:
 * a revived pre-410 panel disposes itself and redirects into Control → the mapped studio route.
 */
export type CommandStudioPanelState = StudioPanelState<CommandStudioPatch>;
