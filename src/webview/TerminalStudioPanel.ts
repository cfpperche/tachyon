import type { StudioPanelState } from "./shared/studio/StudioPanelManagerBase.js";
import type { TerminalStudioPatch } from "./terminal-studio-shell/domain.js";

export const TERMINAL_STUDIO_SHELL_VIEW_TYPE = "tachyonTerminalStudioShell";

/**
 * t-610705 (SDD 410 Phase D, D1a) — the standalone Terminal Studio panel was retired: it's a Control
 * route now (studio-new/studio-edit, studio:"terminal" — studios-routes-design.md). src/webview/
 * terminal-studio-shell/App.tsx stays, lazy-imported by cockpit/App.tsx. The trusted serializer for
 * the legacy "tachyonTerminalStudioShell" viewType stays registered in extension.ts: a revived
 * pre-410 panel disposes itself and redirects into Control → the mapped studio route.
 */
export type TerminalStudioPanelState = StudioPanelState<TerminalStudioPatch>;
