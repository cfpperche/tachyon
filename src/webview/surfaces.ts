/**
 * spec 279 — the canonical manifest of EVERY Tachyon webview surface. One convention, declared in one place:
 * the convention guard (`scripts/check-webview-convention.sh`) reads it, the spec-278 preview harness/catalog
 * spans it, and `converted` tracks the inline→preact migration (flipped per lane; all true = the split is gone).
 *
 * Pure data (no vscode, no DOM) so it's unit-testable and importable anywhere.
 */

/** runtime contract: `live` = ready handshake + host message listener + actions; `static` = render-once. */
export type WebviewMode = "live" | "static";

/** spec 410 — where editor UI should live long-term (sidebar stays separate). */
export type WebviewEditorHome =
  | "sidebar"
  | "cockpit"
  | "standalone"
  | "standalone-multi"
  | "dev-only"
  | "legacy-redirect";

export interface WebviewSurface {
  /** the createWebviewPanel id / WebviewView viewType. */
  viewId: string;
  /** the bundle/dir name: `src/webview/<view>/main.tsx` → `dist/webview/<view>.js`. */
  view: string;
  /** the vscode-bound host file that creates the panel. */
  hostFile: string;
  mode: WebviewMode;
  /** false ⇒ still an inline-HTML panel (guard-allowlisted until its lane lands); true ⇒ a preact bundle. */
  converted: boolean;
  /**
   * spec 410 — preferred editor home after cockpit-single-app migration.
   * `legacy-redirect`: host retained for serializer/revive; new opens should go to cockpit.
   * `standalone-multi`: multi-instance panels (task detail / handoff / probes) — thin-host exception.
   */
  editorHome?: WebviewEditorHome;
  /** When editorHome is cockpit or legacy-redirect, the CockpitSectionId to open. */
  cockpitSectionId?: string;
}

export const WEBVIEW_SURFACES: WebviewSurface[] = [
  // already preact (the 5 that established the convention)
  { viewId: "tachyonSidebar", view: "sidebar", hostFile: "src/webview/SidebarPrototype.ts", mode: "live", converted: true, editorHome: "sidebar" },
  { viewId: "tachyonActivity", view: "activity", hostFile: "src/webview/ActivityPanel.ts", mode: "live", converted: true, editorHome: "standalone-multi" },
  { viewId: "tachyonHandoff", view: "handoff", hostFile: "src/webview/HandoffPanel.ts", mode: "live", converted: true, editorHome: "standalone-multi" },
  { viewId: "tachyonApprovals", view: "approval", hostFile: "src/webview/ApprovalPanel.ts", mode: "live", converted: true, editorHome: "legacy-redirect", cockpitSectionId: "approvals" },
  { viewId: "tachyonPlugins", view: "plugins", hostFile: "src/webview/PluginsPanel.ts", mode: "live", converted: true, editorHome: "standalone" },
  { viewId: "tachyonPinStudio", view: "pin-studio", hostFile: "src/webview/PinStudioPanel.ts", mode: "live", converted: true, editorHome: "standalone" },
  // spec 279 conversions (flip `converted` as each lane lands)
  // probes re-pushes its model on refresh, so it's a `live` read-only surface (a listener, no inbound actions).
  { viewId: "tachyonProbes", view: "probes", hostFile: "src/webview/ProbeResultPanel.ts", mode: "live", converted: true, editorHome: "standalone-multi" },
  { viewId: "tachyonServerInspector", view: "inspector", hostFile: "src/webview/ServerInspector.ts", mode: "live", converted: true, editorHome: "standalone" },
  { viewId: "tachyonCockpit", view: "cockpit", hostFile: "src/webview/Cockpit.ts", mode: "live", converted: true, editorHome: "cockpit" },
  // Superseded by Control in production; retained as a preview surface and disposed if VS Code restores an old panel.
  { viewId: "tachyonControlInspector", view: "control-inspector", hostFile: "src/webview/ControlInspector.ts", mode: "live", converted: true, editorHome: "dev-only" },
  // pin-preview is hosted in SidebarPrototype.previewPin but renders via its own preact bundle (spec 279 Lane E).
  { viewId: "tachyonPinPreview", view: "pin-preview", hostFile: "src/webview/SidebarPrototype.ts", mode: "static", converted: true, editorHome: "sidebar" },
  // spec 335/339 panels — always preact, just predated this manifest; added on spec 342 dogfood round 2 (#4)
  // when they gained a webview-preview harness route (this list is what the catalog-completeness test spans).
  { viewId: "tachyonMissionControl", view: "mission-control", hostFile: "src/webview/MissionControlPanel.ts", mode: "live", converted: true, editorHome: "standalone" },
  { viewId: "tachyonTaskDetail", view: "task-detail", hostFile: "src/webview/TaskDetailPanel.ts", mode: "live", converted: true, editorHome: "standalone-multi" },
  { viewId: "tachyonTaskStudio", view: "task-studio", hostFile: "src/webview/TaskStudioPanel.ts", mode: "live", converted: true, editorHome: "standalone" },
  // spec 367 Phase 1's WebviewView (RuntimeOpsView.ts) was retired (t-ed3067, 2026-07-20) — it was never
  // registered (no registerWebviewViewProvider call), unreachable in production. Runtime Ops lives ONLY as
  // a cockpit section now (view: "runtime-ops" the directory still exists — src/webview/runtime-ops/App.tsx
  // is lazy-imported by cockpit/App.tsx). The dispose-only serializer for the legacy "tachyonRuntimeOpsView"
  // viewType stays registered in extension.ts regardless of this manifest entry — real defensive code for
  // any still-persisted pre-migration window state, independent of whether the class exists.
  // spec 350 T4 — Pipeline Studio (Fake 1), the studio-shell's Phase 1 proof surface. Dev-flag-hidden: this
  // manifest entry is a dev-tooling/catalog-completeness concern (preview harness + convention guard), NOT a
  // user-facing activation — extension.ts never instantiates PipelineStudioPanelManager or registers a command.
  { viewId: "tachyonPipelineStudio", view: "pipeline-studio", hostFile: "src/webview/PipelineStudioPanel.ts", mode: "live", converted: true, editorHome: "dev-only" },
  // spec 350 T5 — Agent-entity fixture (Fake 2), region-composition proof. Same dev-tooling-only status as
  // Pipeline Studio above: never instantiated or registered from extension.ts.
  { viewId: "tachyonAgentFixtureStudio", view: "agent-studio-fixture", hostFile: "src/webview/AgentFixtureStudioPanel.ts", mode: "live", converted: true, editorHome: "dev-only" },
  // spec 350 Phase 3 — Agent Studio (shell), the per-entity single-document agent-kind studio.
  { viewId: "tachyonAgentStudioShell", view: "agent-studio-shell", hostFile: "src/webview/AgentStudioPanel.ts", mode: "live", converted: true, editorHome: "standalone" },
  // Phase 4 — remaining first-party studio shells.
  { viewId: "tachyonTerminalStudioShell", view: "terminal-studio-shell", hostFile: "src/webview/TerminalStudioPanel.ts", mode: "live", converted: true, editorHome: "standalone" },
  { viewId: "tachyonCommandStudioShell", view: "command-studio-shell", hostFile: "src/webview/CommandStudioPanel.ts", mode: "live", converted: true, editorHome: "standalone" },
  { viewId: "tachyonRunbookStudioShell", view: "runbook-studio-shell", hostFile: "src/webview/RunbookStudioPanel.ts", mode: "live", converted: true, editorHome: "standalone" },
  { viewId: "tachyonScheduleStudioShell", view: "schedule-studio-shell", hostFile: "src/webview/ScheduleStudioPanel.ts", mode: "live", converted: true, editorHome: "standalone" },
  // spec 349 T10/T11 — first-party relay for untrusted plugin UI surfaces.
  { viewId: "tachyonPluginSurface", view: "plugin-host", hostFile: "src/plugins/ui/host.ts", mode: "live", converted: true, editorHome: "standalone" },
  { viewId: "tachyonPluginSurfaces", view: "plugin-host", hostFile: "src/plugins/ui/host.ts", mode: "live", converted: true, editorHome: "standalone" },
];

/** surfaces still carrying inline-HTML app logic (acquireVsCodeApi / inline <script>) the guard allowlists. */
export function unconvertedInteractive(): WebviewSurface[] {
  return WEBVIEW_SURFACES.filter((s) => !s.converted && s.mode === "live");
}
