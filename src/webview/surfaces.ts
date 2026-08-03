/**
 * spec 279 — the canonical manifest of EVERY Tachyon webview surface. One convention, declared in one place:
 * the convention guard (`scripts/check-webview-convention.sh`) reads it, the spec-278 preview harness/catalog
 * spans it, and `converted` tracks the inline→preact migration (flipped per lane; all true = the split is gone).
 *
 * Pure data (no vscode, no DOM) so it's unit-testable and importable anywhere.
 */

import { SHELL_EXTENSION_POINTS, type ShellExtensionPoint } from "./shared/shell.js";

/** runtime contract: `live` = ready handshake + host message listener + actions; `static` = render-once. */
export type WebviewMode = "live" | "static";

/**
 * spec 485 A1 — the conformance POSTURE of a surface against the shared shell + design system. SDD 410's
 * mechanism for keeping one design system enforceable was "one runtime, two apps"; 485 puts the app count
 * back, so the mechanism has to be this declaration plus the test that checks it (`webviewConvention.test.ts`).
 *
 *  - `conform`  mounts the shared shell, uses the kit + tokens as they come. The default; costs nothing.
 *  - `extend`   shared shell, but composes its own chrome into it through the shell's NAMED extension points
 *               (`SHELL_EXTENSION_POINTS`). First-class, NOT an exception — it just has to say which points.
 *  - `replace`  brings its own shell. Allowed, with a non-empty reason, and read as a decision.
 *
 * What fails the build is an UNDECLARED departure, never a declared one. Two rules keep the declaration
 * honest, both enforced by the test: a point named here must actually be used (no blanket-declaring), and a
 * departure found in the source with no matching declaration names the offending surface.
 */
export type WebviewPosture =
  | { posture: "conform" }
  | { posture: "extend"; extensionPoints: readonly ShellExtensionPoint[] }
  | { posture: "replace"; reason: string };

/** spec 410 — where editor UI should live long-term (sidebar stays separate). */
export type WebviewEditorHome =
  | "sidebar"
  | "cockpit"
  | "standalone"
  | "dev-only";

interface WebviewSurfaceBase {
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
   * spec 410 — preferred editor home after cockpit-single-app migration. Every migrated
   * section/studio's OLD panel is retired to a types-only stub (its own doc comment explains the
   * retirement) and DROPS OUT of this manifest entirely — a manifest row only exists for a surface
   * that still genuinely creates a panel.
   *
   * Two values were removed here after going unused (Phase E audit, t-610705, 2026-07-22):
   * `standalone-multi` (the multi-instance thin-host exception for task detail/handoff/probes —
   * Phase C closed all three into Control subroutes) and `legacy-redirect` + the `cockpitSectionId`
   * field it paired with (Approvals was the only user; its manager is a pure redirect stub with no
   * `createWebviewPanel` call left at all, same shape as every other retired panel below — it just
   * hadn't dropped out of this manifest yet). Re-add the shape if a future retirement genuinely needs
   * to describe "revive redirects into a specific Control section" again — don't keep it unused.
   */
  editorHome?: WebviewEditorHome;
}

/** spec 485 A1 — every surface carries its posture; the union makes "extend names its points" and "replace
 *  carries a reason" a TYPE error to omit, and the test makes them non-empty and true. */
export type WebviewSurface = WebviewSurfaceBase & WebviewPosture;

export const WEBVIEW_SURFACES: WebviewSurface[] = [
  // t-6e2952 — the Control launcher is NOT a surface: it is a TAB inside the sidebar webview
  // (src/webview/sidebar/App.tsx), so it has no viewType, no bundle and no host file of its own. The
  // first delivery registered it as a separate WebviewView ("tachyonControlLauncher") and it rendered
  // as a second collapsible section stacked above the Tachyon panel — one panel is the requirement.
  // already preact (the 5 that established the convention)
  // spec 485 A1 — 410's standing sidebar exception, now EXPLICIT: the sidebar lives in the side-bar surface,
  // not the editor, so sidebar.css overrides the design system's editor background and page pad on `html, body`
  // (its own comment says so). Shared shell, shared kit, own page chrome → `extend`, not an exception entry.
  { viewId: "tachyonSidebar", view: "sidebar", hostFile: "src/webview/SidebarPrototype.ts", mode: "live", converted: true, editorHome: "sidebar", posture: "extend", extensionPoints: ["page-chrome"] },
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
  // t-610705 (SDD 410 Phase A/B pilot, found + closed in the Phase E audit, 2026-07-22) — the
  // standalone Approvals panel was retired: it's a Control section now (src/webview/approval/App.tsx
  // stays, lazy-imported by cockpit/App.tsx). ApprovalPanelManager (src/webview/ApprovalPanel.ts) is
  // a pure redirect stub — it never calls createWebviewPanel, matching every other retired panel's
  // shape below. The trusted serializer for the legacy "tachyonApprovals" viewType stays registered
  // in extension.ts: a revived pre-410 panel disposes itself and redirects into Control → Approvals.
  // The standalone Plugins panel was retired (t-d23f93, 2026-07-20) — Plugins is a cockpit section
  // only (src/webview/plugins/App.tsx stays, lazy-imported by cockpit/App.tsx; the per-workspace
  // need is served by Control's shell workspace selector, t-d16a39). The trusted serializer for
  // the legacy "tachyonPlugins" viewType stays registered in extension.ts: a revived pre-410 panel
  // disposes itself and redirects into Control → Plugins.
  // t-610705 (SDD 410 Phase D, D3) — the standalone Pin Studio panel (spec 255) was retired: it's a
  // Control studio route now (src/webview/pin-studio/App.tsx stays, lazy-imported by cockpit/App.tsx
  // via CSS co-load, same as command/terminal/runbook/schedule/agent/task before it). The trusted
  // serializer for the legacy "tachyonPinStudio" viewType stays registered in extension.ts
  // (registerLegacyStudioRedirect): a revived pre-410 panel disposes itself and redirects into
  // Control → the pin's studio route.
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
  // spec 485 A1 — Control is a full-bleed multi-section app: cockpit.css hard-resets `html, body, #root` with
  // `!important` so the embedded sections' standalone CSS cannot re-impose a page pad (that reset is the
  // reason cockpitCssParity.test.ts pins cockpit.css LAST). Own page chrome, shared kit → `extend`.
  { viewId: "tachyonCockpit", view: "cockpit", hostFile: "src/webview/Cockpit.ts", mode: "live", converted: true, editorHome: "cockpit", posture: "extend", extensionPoints: ["page-chrome"] },
  // The Engine/Bridge Control Inspector POC was removed as dead code (t-b5dcae, 2026-07-20):
  // ControlInspector.ts and src/webview/control-inspector/* had zero real importers — Cockpit's
  // Engine tab was already built on its own JSX + EngineLogPanel.tsx, using src/control-inspector/
  // model.ts's types directly (that pure model survives). The dispose-only serializer for the
  // legacy "tachyonControlInspector" viewType stays registered in extension.ts, same defensive
  // reasoning as the other retired panels: any still-persisted pre-migration window state.
  // pin-preview is hosted in SidebarPrototype.previewPin but renders via its own preact bundle (spec 279 Lane E).
  // spec 485 A1 — 410's other standing exception, now EXPLICIT. pin-preview.css sets its own `body` baseline
  // (margin/pad/background/colour/font) rather than inheriting the design system's, and centres a fixed
  // 880px column. Own page chrome → `extend`. (The body block largely restates what design-system.css already
  // sets; collapsing it is a real cleanup, but it is a VISUAL change and this phase moves nothing.)
  { viewId: "tachyonPinPreview", view: "pin-preview", hostFile: "src/webview/SidebarPrototype.ts", mode: "static", converted: true, editorHome: "sidebar", posture: "extend", extensionPoints: ["page-chrome"] },
  // t-610355 — layer-2 first-party agent pane (runtime TUI in Tachyon webview + xterm; additive to integrated terminal)
  // spec 485 A1 — the ONLY live standalone editor panel today, and the sharpest departure in the manifest: it
  // links NO design-system.css (AgentPanePanel.ts: "Tachyon Mono @font-face breaks xterm cell metrics") and
  // therefore mints its own `--ds-1..4` spacing values in agent-pane.css. Both were code comments until now —
  // which is precisely the silence this contract exists to end. Shared shell, own base layer → `extend`.
  { viewId: "tachyonAgentPane", view: "agent-pane", hostFile: "src/webview/AgentPanePanel.ts", mode: "live", converted: true, editorHome: "standalone", posture: "extend", extensionPoints: ["base-style", "token-scale"] },
  // spec 335/339 panels — always preact, just predated this manifest; added on spec 342 dogfood round 2 (#4)
  // when they gained a webview-preview harness route (this list is what the catalog-completeness test spans).
  // The standalone Mission Control (Board) panel was retired (t-610705, SDD 410 Phase B #6, 2026-07-20) —
  // the Board is a cockpit section only (src/webview/mission-control/App.tsx stays, lazy-imported by
  // cockpit/App.tsx; the bounded agent-liveness pass moved to src/cockpit/missionVm.ts). The trusted
  // serializer for the legacy "tachyonMissionControl" viewType stays registered in extension.ts: a revived
  // pre-410 panel disposes itself and redirects into Control → Mission scoped to its persisted workspace.
  // SDD 485 C4 (2026-08-03) — Task Detail is a STANDALONE APP again, and this row is the reversal of
  // 410 Phase C.1's retirement (which had made it a Control subroute). It is the `document` kind: one
  // panel per identity, so two task details stand side by side and neither is retargeted by the project
  // selector. It mounts through the shared shell via `SectionPanelManager`, links design-system.css, and
  // task-detail.css neither styles the page frame nor mints `--ds-*` values → `conform`.
  { viewId: "tachyonTaskDetail", view: "task-detail", hostFile: "src/webview/TaskDetailPanel.ts", mode: "live", converted: true, editorHome: "standalone", posture: "conform" },
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
  // spec 485 A1 — a dev-only spec-350 fake, carried forward EXPLICITLY rather than implicitly. It mounts
  // through StudioPanelManagerBase → renderWebviewShell and layers only kit sheets (studio-frame.css is part
  // of the shared kit, not a departure from it), so dev-only status buys it no exemption: it `conform`s.
  { viewId: "tachyonPipelineStudio", view: "pipeline-studio", hostFile: "src/webview/PipelineStudioPanel.ts", mode: "live", converted: true, editorHome: "dev-only", posture: "conform" },
  // spec 350 T5 — Agent-entity fixture (Fake 2), region-composition proof. Same dev-tooling-only status as
  // Pipeline Studio above: never instantiated or registered from extension.ts.
  // spec 485 A1 — the other dev-only spec-350 fake, EXPLICIT for the same reason. Its region composition is
  // StudioFrame's four CONTENT regions (client-side, spec 350 T5), which is kit usage, not a page-frame
  // departure — so it `conform`s too.
  { viewId: "tachyonAgentFixtureStudio", view: "agent-studio-fixture", hostFile: "src/webview/AgentFixtureStudioPanel.ts", mode: "live", converted: true, editorHome: "dev-only", posture: "conform" },
  // SDD 485 C1–C3 — the section-app proof surface: the first (and so far only) app driven by the generic
  // `SectionPanelManager`, and the second entry of the code-split build without which "Preact and the kit
  // are extracted into shared chunks" would be a claim with no witness. Dev-only in the same sense as the
  // two spec-350 fakes above — `extension.ts` never instantiates its manager and no command contributes it
  // — and, following the precedent those two set, dev-only buys NO exemption: it mounts through the shared
  // shell (via SectionPanelManager), links design-system.css, and its own stylesheet neither styles the
  // page frame nor mints `--ds-*` values. It `conform`s, and the contract checks that rather than trusting
  // this sentence.
  // `editorHome: "dev-only"` and not "standalone": the mechanism is for standalone apps, but THIS surface
  // never reaches a user, and the field records where a surface actually lives, not what it demonstrates.
  { viewId: "tachyonSectionAppFixture", view: "section-app-fixture", hostFile: "src/webview/SectionAppFixturePanel.ts", mode: "live", converted: true, editorHome: "dev-only", posture: "conform" },
  // t-610705 (SDD 410 Phase D, D0/D1a/D1b) — the standalone Command/Terminal/Runbook/Schedule/Agent
  // Studio (shell) panels were retired: they're Control routes now (studio-new/studio-edit, studio:
  // "command"/"terminal"/"runbook"/"schedule"/"agent" — studios-routes-design.md; standalone bundles
  // + harness routes retired — use ?view=cockpit&fixture=studio-<name> instead). The trusted
  // serializer for each legacy viewType stays registered in extension.ts: a revived pre-410 panel
  // disposes itself and redirects into Control → the mapped studio route.
  // spec 349 T10/T11 — first-party relay for untrusted plugin UI surfaces.
  // spec 485 A1 — 410's plugin-surface exception, EXPLICIT. The untrusted part is quarantined the other side
  // of an opaque-origin sandboxed `srcdoc` frame; the first-party RELAY page around it is ordinary kit on the
  // shared shell, so the relay `conform`s. Its `frameSrc`/`scriptCspSource` options are a SECURITY posture, not
  // a design-system one — deliberately not extension points (see SHELL_EXTENSION_POINTS).
  { viewId: "tachyonPluginSurface", view: "plugin-host", hostFile: "src/plugins/ui/host.ts", mode: "live", converted: true, editorHome: "standalone", posture: "conform" },
  { viewId: "tachyonPluginSurfaces", view: "plugin-host", hostFile: "src/plugins/ui/host.ts", mode: "live", converted: true, editorHome: "standalone", posture: "conform" },
];

/**
 * spec 485 A1 — well-formedness of ONE surface's posture declaration, as a pure function so the rule is
 * testable on its own (an empty `replace` reason must fail whether or not such a surface exists today) and
 * on every real entry. It checks the SHAPE of the declaration; whether the declaration is TRUE of the code
 * the surface ships is `webviewConvention.test.ts`'s job, which needs the filesystem and cannot live here.
 */
export function postureDeclarationErrors(s: WebviewSurface): string[] {
  const errors: string[] = [];
  if (s.posture === "replace" && s.reason.trim() === "") {
    errors.push(`${s.viewId}: posture "replace" needs a non-empty reason — replacing the shell is a decision, and an unexplained one is indistinguishable from drift`);
  }
  if (s.posture === "extend") {
    if (s.extensionPoints.length === 0) {
      errors.push(`${s.viewId}: posture "extend" must name at least one extension point — "extend" with no points declared is just an undeclared departure spelled differently`);
    }
    for (const p of s.extensionPoints) {
      if (!SHELL_EXTENSION_POINTS.includes(p)) errors.push(`${s.viewId}: unknown extension point "${p}" — the set is closed: ${SHELL_EXTENSION_POINTS.join(", ")}`);
    }
    if (new Set(s.extensionPoints).size !== s.extensionPoints.length) errors.push(`${s.viewId}: duplicate extension point in ${JSON.stringify(s.extensionPoints)}`);
  }
  return errors;
}

/** surfaces still carrying inline-HTML app logic (acquireVsCodeApi / inline <script>) the guard allowlists. */
export function unconvertedInteractive(): WebviewSurface[] {
  return WEBVIEW_SURFACES.filter((s) => !s.converted && s.mode === "live");
}
