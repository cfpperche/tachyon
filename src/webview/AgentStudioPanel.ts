import type { StudioPanelState } from "./shared/studio/StudioPanelManagerBase.js";
import type { AgentStudioPatch } from "./agent-studio-shell/domain.js";

export const AGENT_STUDIO_SHELL_VIEW_TYPE = "tachyonAgentStudioShell";

/**
 * t-610705 (SDD 410 Phase D, D1b) — the standalone Agent Studio panel was retired: it's a Control
 * route now (studio-new/studio-edit, studio:"agent" — studios-routes-design.md). src/webview/
 * agent-studio-shell/App.tsx stays, lazy-imported by cockpit/App.tsx. The trusted serializer for the
 * legacy "tachyonAgentStudioShell" viewType stays registered in extension.ts: a revived pre-410 panel
 * disposes itself and redirects into Control → the mapped studio route. The soul-profile/evolution
 * domain-message dispatch (17 message types) that used to live here moved to
 * src/cockpit/agentStudioDomain.ts, wired through studioRegistry.ts's `agent` entry.
 */
export type AgentStudioPanelState = StudioPanelState<AgentStudioPatch>;
