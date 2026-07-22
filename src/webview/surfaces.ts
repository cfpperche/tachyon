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
  // t-610705 (SDD 410 Phase C.2, 2026-07-21) — the standalone Activity panel was retired: it's a
  // Control subroute now (src/webview/activity/App.tsx stays, lazy-imported by cockpit/App.tsx;
  // standalone bundle + harness route retired — use ?view=cockpit&fixture=agent-activity instead).
  // The trusted serializer for the legacy "tachyonActivity" viewType stays registered in
  // extension.ts: a revived pre-410 panel disposes itself and redirects into Control → the agent's
  // activity subroute.
  // t-610705 (SDD 410 Phase C.3, 2026-07-21) — the standalone Project Handoff panel was retired:
  // it's a Control section now (src/webview/handoff/App.tsx stays, lazy-imported by cockpit/App.tsx;
  // standalone bundle + harness route retired — use ?view=cockpit&fixture=handoff instead). The
  // trusted serializer for the legacy "tachyonHandoff" viewType stays registered in extension.ts: a
  // revived pre-410 panel disposes itself and redirects into Control → Handoff.
  { viewId: "tachyonApprovals", view: "approval", hostFile: "src/webview/ApprovalPanel.ts", mode: "live", converted: true, editorHome: "legacy-redirect", cockpitSectionId: "approvals" },
  // The standalone Plugins panel was retired (t-d23f93, 2026-07-20) — Plugins is a cockpit section
  // only (src/webview/plugins/App.tsx stays, lazy-imported by cockpit/App.tsx; the per-workspace
  // need is served by Control's shell workspace selector, t-d16a39). The trusted serializer for
  // the legacy "tachyonPlugins" viewType stays registered in extension.ts: a revived pre-410 panel
  // disposes itself and redirects into Control → Plugins.
  { viewId: "tachyonPinStudio", view: "pin-studio", hostFile: "src/webview/PinStudioPanel.ts", mode: "live", converted: true, editorHome: "standalone" },
  // spec 279 conversions (flip `converted` as each lane lands)
  // t-610705 (SDD 410 Phase C.2, 2026-07-21) — the standalone Probes panel was retired: it's a
  // Control subroute now (src/webview/probes/App.tsx stays, lazy-imported by cockpit/App.tsx;
  // standalone bundle + harness route retired — use ?view=cockpit&fixture=agent-probes instead).
  // The trusted serializer for the legacy "tachyonProbes" viewType stays registered in
  // extension.ts: a revived pre-410 panel disposes itself and redirects into Control → the matching
  // probes subroute.
  // The standalone tmux Server Inspector panel was retired (t-610705, SDD 410 Phase B #5, 2026-07-20) —
  // tmux is a cockpit section only (src/webview/inspector/App.tsx stays, lazy-imported by cockpit/App.tsx;
  // no per-workspace scoping needed — the tmux socket is cross-workspace by design). The trusted serializer
  // for the legacy "tachyonServerInspector" viewType stays registered in extension.ts: a revived pre-410
  // panel disposes itself and redirects into Control → tmux (same command the live open path uses).
  { viewId: "tachyonCockpit", view: "cockpit", hostFile: "src/webview/Cockpit.ts", mode: "live", converted: true, editorHome: "cockpit" },
  // The Engine/Bridge Control Inspector POC was removed as dead code (t-b5dcae, 2026-07-20):
  // ControlInspector.ts and src/webview/control-inspector/* had zero real importers — Cockpit's
  // Engine tab was already built on its own JSX + EngineLogPanel.tsx, using src/control-inspector/
  // model.ts's types directly (that pure model survives). The dispose-only serializer for the
  // legacy "tachyonControlInspector" viewType stays registered in extension.ts, same defensive
  // reasoning as the other retired panels: any still-persisted pre-migration window state.
  // pin-preview is hosted in SidebarPrototype.previewPin but renders via its own preact bundle (spec 279 Lane E).
  { viewId: "tachyonPinPreview", view: "pin-preview", hostFile: "src/webview/SidebarPrototype.ts", mode: "static", converted: true, editorHome: "sidebar" },
  // spec 335/339 panels — always preact, just predated this manifest; added on spec 342 dogfood round 2 (#4)
  // when they gained a webview-preview harness route (this list is what the catalog-completeness test spans).
  // The standalone Mission Control (Board) panel was retired (t-610705, SDD 410 Phase B #6, 2026-07-20) —
  // the Board is a cockpit section only (src/webview/mission-control/App.tsx stays, lazy-imported by
  // cockpit/App.tsx; the bounded agent-liveness pass moved to src/cockpit/missionVm.ts). The trusted
  // serializer for the legacy "tachyonMissionControl" viewType stays registered in extension.ts: a revived
  // pre-410 panel disposes itself and redirects into Control → Mission scoped to its persisted workspace.
  // t-610705 (SDD 410 Phase C.1, 2026-07-21) — the standalone Task Detail panel was retired: it's a
  // Control subroute now (src/webview/task-detail/App.tsx stays, lazy-imported by cockpit/App.tsx;
  // standalone bundle + harness route retired — use ?view=cockpit&fixture=task-detail instead). The
  // trusted serializer for the legacy "tachyonTaskDetail" viewType stays registered in extension.ts:
  // a revived pre-410 panel disposes itself and redirects into Control → the task's subroute.
  // t-610705 (SDD 410 Phase D, D2) — the standalone Task Studio panel was retired: it's a Control
  // studio route now (src/webview/task-studio/App.tsx stays, lazy-imported by cockpit/App.tsx via
  // CSS co-load, same as command/terminal/runbook/schedule/agent before it). The trusted serializer
  // for the legacy "tachyonTaskStudio" viewType stays registered in extension.ts: a revived pre-410
  // panel disposes itself and redirects into Control → the task's studio-edit route.
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
  // t-610705 (SDD 410 Phase D, D0/D1a/D1b) — the standalone Command/Terminal/Runbook/Schedule/Agent
  // Studio (shell) panels were retired: they're Control routes now (studio-new/studio-edit, studio:
  // "command"/"terminal"/"runbook"/"schedule"/"agent" — studios-routes-design.md; standalone bundles
  // + harness routes retired — use ?view=cockpit&fixture=studio-<name> instead). The trusted
  // serializer for each legacy viewType stays registered in extension.ts: a revived pre-410 panel
  // disposes itself and redirects into Control → the mapped studio route.
  // spec 349 T10/T11 — first-party relay for untrusted plugin UI surfaces.
  { viewId: "tachyonPluginSurface", view: "plugin-host", hostFile: "src/plugins/ui/host.ts", mode: "live", converted: true, editorHome: "standalone" },
  { viewId: "tachyonPluginSurfaces", view: "plugin-host", hostFile: "src/plugins/ui/host.ts", mode: "live", converted: true, editorHome: "standalone" },
];

/** surfaces still carrying inline-HTML app logic (acquireVsCodeApi / inline <script>) the guard allowlists. */
export function unconvertedInteractive(): WebviewSurface[] {
  return WEBVIEW_SURFACES.filter((s) => !s.converted && s.mode === "live");
}
