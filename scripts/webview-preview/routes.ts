/**
 * spec 278 — the per-view ROUTE TABLE for the dev preview harness (the single source the harness reads
 * and the route catalog is generated from). Pure data + the shared message constructors — NO DOM here, so
 * it stays unit-testable; the DOM glue lives in `preview.ts`.
 *
 * Each view declares: its built bundle, the stylesheet set the REAL panel links (same order), the frame to
 * render it in, and `makeMessage(vm)` — built from the view's SHARED envelope constructor (spec 278 drift
 * guard), so an envelope/VM-shape change breaks THIS build, never a silent wrong screenshot.
 *
 * First slice (spec 278): `sidebar`. `plugins` + `activity` land in lanes B/C; `handoff`/`pin-studio` later.
 */

import { fleetMessage } from "../../src/webview/sidebar/messages";
import { pluginsMessage } from "../../src/webview/plugins/messages";
import { activityMessage } from "../../src/webview/activity/messages";
import { probesMessage } from "../../src/webview/probes/messages";
import { pinDocumentModeMessage, pinPreviewMessage } from "../../src/webview/pin-preview/messages";
import { handoffMessage } from "../../src/webview/handoff/messages";
import { humanInboxItemMessage, humanInboxMessage } from "../../src/webview/human-inbox/messages";
import { taskMessage } from "../../src/webview/task-detail/messages";
import { runtimeOpsLoadingMessage, runtimeOpsSnapshotMessage } from "../../src/webview/runtime-ops/messages";
import { worktreePrDraftMessage, worktreesModelMessage } from "../../src/webview/worktrees/messages";
import { runtimeConfigSnapshotMessage } from "../../src/webview/runtime-config/messages";
import { settingsModelMessage } from "../../src/webview/settings/messages";
import { systemModelMessage } from "../../src/webview/system/messages";
import { sidebarFixtures } from "./fixtures/sidebar";
import { handoffFixtures } from "./fixtures/handoff";
import { pinStudioFixtures, pinStudioMakeMessage } from "./fixtures/pin-studio";
import { pluginsFixtures } from "./fixtures/plugins";
import { activityFixtures } from "./fixtures/activity";
import { probesFixtures } from "./fixtures/probes";
import { inspectorFixtures, scopeFor as inspectorScopeFor, strings as inspectorStrings } from "./fixtures/inspector";
import { initMessage as inspectorInitMessage, modelMessage as inspectorModelMessage } from "../../src/webview/inspector/messages";
import {
  cockpitFixtures,
  runtimeConfigFixtureSnapshot,
  runtimeConfigPreviewStrings,
  strings as cockpitStrings,
  worktreesPrDraftFixture,
} from "./fixtures/cockpit";
import { pinPreviewFixtures } from "./fixtures/pin-preview";
import { taskDetailFixtures } from "./fixtures/task-detail";
import { boardFixtures } from "./fixtures/board";
import { snapshotMessage as boardSnapshotMessage } from "../../src/webview/board/messages";
import { runtimeOpsFixtures, type RuntimeOpsPreviewState } from "./fixtures/runtime-ops";
import { humanInboxFixtures, type HumanInboxPreviewState } from "./fixtures/human-inbox";
import { pipelineStudioFixtures, pipelineStudioMakeMessage } from "./fixtures/pipeline-studio";
import { agentStudioFixtureFixtures, agentStudioFixtureMakeMessage } from "./fixtures/agent-studio-fixture";
import { agentStudioShellFixtures, agentStudioShellMakeMessage } from "./fixtures/agent-studio-shell";
import { terminalStudioShellFixtures, terminalStudioShellMakeMessage } from "./fixtures/terminal-studio-shell";
import { commandStudioShellFixtures, commandStudioShellMakeMessage } from "./fixtures/command-studio-shell";
import { runbookStudioShellFixtures, runbookStudioShellMakeMessage } from "./fixtures/runbook-studio-shell";
import { scheduleStudioShellFixtures, scheduleStudioShellMakeMessage } from "./fixtures/schedule-studio-shell";
import { sectionAppFixtureFixtures, sectionAppFixtureMakeMessage } from "./fixtures/section-app-fixture";

/** provenance of a fixture VM — keeps a hand-authored fiction from masquerading as real intent. */
export type Provenance = "sample-derived" | "unit-fixture-derived" | "captured-host-vm" | "synthetic-edge";

export interface Fixture<VM = unknown> {
  provenance: Provenance;
  vm: VM;
}

export interface Route<VM = unknown> {
  /** the REAL shipped webview bundle, served at the repo-root absolute path. */
  bundle: string;
  /** stylesheets the real panel links, IN ORDER (codicon → design-system → panel-specific). */
  cssLinks: string[];
  /** the frame the surface renders in (px). */
  frame: { w: number; h: number };
  /** the named fixtures this view can render. */
  fixtures: Record<string, Fixture<VM>>;
  /** build the host→webview message(s) that inject a fixture VM — via the view's SHARED envelope constructor(s).
   *  Returns an ARRAY when a view needs more than one message to render (e.g. inspector: init strings + model). */
  makeMessage: (vm: VM) => unknown | unknown[];
  /** set when the built bundle is an ESM module (esbuild code-splitting) rather than a classic script — the
   *  harness must inject it via `<script type="module">` or the browser rejects its `import` statements. */
  module?: boolean;
  /** globals the production panel bootstraps before loading the app bundle. */
  globals?: Record<string, unknown>;
  /**
   * t-32c872 — this surface IS the page (an SDD 485 standalone app that links `page-frame.css`), so the
   * harness must not hand it a height it did not ask for. The frame is a sized iframe (t-b24282), i.e. a
   * real page frame either way; what `pageFrame` controls is whether `preview.ts` anchors the height chain
   * (`html, body { height: 100% }`) on top of it. A page-frame route gets NO anchor: its own
   * `page-frame.css` is the only thing that may give `#root` something to resolve `height: 100%` against.
   *
   * Without this the harness is MORE generous than the product and cannot see a whole defect class. The
   * Board lost per-column scrolling standalone because `#root { height: 100% }` had no `body` height to
   * resolve against — and the harness rendered it correctly the whole time, because the frame handed
   * `#root` a definite height the real page never had. A harness that cannot reproduce the bug cannot
   * witness the fix either.
   */
  pageFrame?: boolean;
}

const CODICON = "/dist/webview/codicon.css";
const DESIGN_SYSTEM = "/dist/webview/design-system.css";
const QUICK_PICKER = "/dist/webview/quick-picker.css";

export const ROUTES: Record<string, Route> = {
  sidebar: {
    bundle: "/dist/webview/sidebar.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/sidebar.css"],
    frame: { w: 340, h: 760 },
    fixtures: sidebarFixtures as Record<string, Fixture>,
    // the sidebar host message wraps a single FleetVM in a one-fleet push (matches the real provider).
    makeMessage: (vm) => fleetMessage(Array.isArray(vm) ? vm as never : [vm as never], {}),
  },
  // t-6e2952 — the Control launcher has no route of its own: it is the "Control" TAB of the `sidebar`
  // route above (same bundle, same fixtures) — open ?view=sidebar and select the second tab.
  // SDD 485 D17 — Activity is standalone again. The same captured VMs now drive the shipped
  // activity.js entry directly, with the exact stylesheet list ActivityPanel links.
  activity: {
    bundle: "/dist/webview/activity.js",
    cssLinks: [
      CODICON,
      DESIGN_SYSTEM, QUICK_PICKER,
      "/dist/webview/highlight.css",
      "/dist/webview/katex.min.css",
      "/dist/webview/mermaid-block.css",
      "/dist/webview/activity.css",
    ],
    frame: { w: 880, h: 900 },
    fixtures: activityFixtures as Record<string, Fixture>,
    module: true,
    globals: {
      __mermaidSrc: "/dist/webview/mermaid.js",
      __katexSrc: "/dist/webview/katex.js",
      __katexCssUri: "/dist/webview/katex.min.css",
      __codeThemeForced: "auto",
    },
    makeMessage: (vm) => activityMessage("preview", "agent", vm as never),
  },
  // SDD 485 D18 — both Probes identities use the same standalone bundle and model envelope.
  probes: {
    bundle: "/dist/webview/probes.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/probes.css"],
    frame: { w: 880, h: 900 },
    fixtures: probesFixtures as Record<string, Fixture>,
    module: true,
    makeMessage: (vm) => probesMessage(vm as never),
  },
  "pin-preview": {
    bundle: "/dist/webview/pin-preview.js",
    cssLinks: [
      CODICON,
      DESIGN_SYSTEM, QUICK_PICKER,
      "/dist/webview/vscode-theme.css",
      "/dist/webview/rich-doc.css",
      "/dist/webview/studio-frame.css",
      "/dist/webview/pin-studio.css",
      "/dist/webview/pin-preview.css",
    ],
    frame: { w: 880, h: 700 },
    fixtures: { ...pinPreviewFixtures, edit: pinStudioFixtures.default } as Record<string, Fixture>,
    module: true,
    // Mirrors PinDetailPanel's bootstrap for the edit fixture so the real shared SketchModal is
    // exercisable in browser evidence instead of being suppressed by missing asset URLs.
    globals: {
      EXCALIDRAW_SCRIPT_URI: "/dist/webview/excalidraw.js",
      EXCALIDRAW_CSS_URI: "/dist/webview/excalidraw.css",
      EXCALIDRAW_ASSET_PATH: "/dist/webview/",
    },
    makeMessage: (vm) => "entity" in (vm as object)
      ? [pinDocumentModeMessage("edit"), ...pinStudioMakeMessage(vm as never)]
      : pinPreviewMessage(vm as never),
  },
  // t-610705 (SDD 410 Phase A/B pilot, found + closed in the Phase E audit, 2026-07-22) — the
  // standalone "approval" route previewed the retired Approvals panel; Approvals is a cockpit-only
  // section now — use ?view=cockpit&fixture=approvals (same App.tsx, same fixture VM, via the
  // cockpit route's section injection above).
  // t-610705 (SDD 410 Phase B #6) — the standalone "board" route previewed the retired
  // Board panel; the Board is a cockpit-only section now — use ?view=cockpit&fixture=mission
  // (same App.tsx, same fixture VM via the cockpit route's board injection below).
  // t-610705 (SDD 410 Phase D, D2) — the standalone "task-studio" route previewed the retired
  // TaskStudioPanel.ts webview; Task Studio is a cockpit-only studio route now — use
  // ?view=cockpit&fixture=studio-task-edit (same App.tsx, same fixture VMs, via the cockpit route's
  // byStudio fixture injection above).
  // t-610705 (SDD 410 Phase C.1) — the standalone "task-detail" route previewed the retired Task
  // Detail panel; Task Detail is a cockpit-only subroute now — use
  // ?view=cockpit&fixture=task-detail (same App.tsx, same fixture VM, via the cockpit route's
  // activeRoute injection above).
  // spec 350 T4 — Pipeline Studio (Fake 1): the studio-shell's Phase 1 proof surface. Dev-flag-hidden (no
  // command contribution) — reachable only through this route and its own host-side tests.
  "pipeline-studio": {
    bundle: "/dist/webview/pipeline-studio.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/studio-frame.css", "/dist/webview/pipeline-studio.css"],
    frame: { w: 900, h: 760 },
    fixtures: pipelineStudioFixtures as Record<string, Fixture>,
    makeMessage: (vm) => pipelineStudioMakeMessage(vm as never),
  },
  // spec 350 T5 — Agent-entity fixture (Fake 2): region-composition proof (quick-add chips, role select,
  // instructions, worktree section). Dev-flag-hidden, same status as pipeline-studio above.
  "agent-studio-fixture": {
    bundle: "/dist/webview/agent-studio-fixture.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/studio-frame.css", "/dist/webview/agent-studio-fixture.css"],
    frame: { w: 720, h: 980 },
    fixtures: agentStudioFixtureFixtures as Record<string, Fixture>,
    makeMessage: (vm) => agentStudioFixtureMakeMessage(vm as never),
  },
  // SDD 485 D13 — the five real studio documents are standalone routes again. The component and
  // fixture payload are unchanged; only the host moved out of Control.
  "agent-studio-shell": {
    bundle: "/dist/webview/agent-studio-shell.js",
    module: true,
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/vscode-theme.css", "/dist/webview/agent-studio-shell.tailwind.css", "/dist/webview/studio-frame.css", "/dist/webview/agent-studio-shell.css"],
    frame: { w: 900, h: 900 },
    fixtures: agentStudioShellFixtures as Record<string, Fixture>,
    makeMessage: (vm) => agentStudioShellMakeMessage(vm as never),
  },
  "terminal-studio-shell": {
    bundle: "/dist/webview/terminal-studio-shell.js",
    module: true,
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/vscode-theme.css", "/dist/webview/studio-frame.css", "/dist/webview/terminal-studio-shell.css"],
    frame: { w: 900, h: 760 },
    fixtures: terminalStudioShellFixtures as Record<string, Fixture>,
    makeMessage: (vm) => terminalStudioShellMakeMessage(vm as never),
  },
  "command-studio-shell": {
    bundle: "/dist/webview/command-studio-shell.js",
    module: true,
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/vscode-theme.css", "/dist/webview/studio-frame.css", "/dist/webview/command-studio-shell.css"],
    frame: { w: 760, h: 640 },
    fixtures: commandStudioShellFixtures as Record<string, Fixture>,
    makeMessage: (vm) => commandStudioShellMakeMessage(vm as never),
  },
  "runbook-studio-shell": {
    bundle: "/dist/webview/runbook-studio-shell.js",
    module: true,
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/vscode-theme.css", "/dist/webview/studio-frame.css", "/dist/webview/runbook-studio-shell.css"],
    frame: { w: 760, h: 760 },
    fixtures: runbookStudioShellFixtures as Record<string, Fixture>,
    makeMessage: (vm) => runbookStudioShellMakeMessage(vm as never),
  },
  "schedule-studio-shell": {
    bundle: "/dist/webview/schedule-studio-shell.js",
    module: true,
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/vscode-theme.css", "/dist/webview/studio-frame.css", "/dist/webview/schedule-studio-shell.css"],
    frame: { w: 760, h: 760 },
    fixtures: scheduleStudioShellFixtures as Record<string, Fixture>,
    makeMessage: (vm) => scheduleStudioShellMakeMessage(vm as never),
  },
  // SDD 485 C4 — Task Detail is a standalone app again, so it gets its own route back: this renders the
  // REAL shipped `task-detail.js` bundle with the exact stylesheet list `TaskDetailPanel.ts` links, rather
  // than the same component embedded inside Control (which is what `?view=cockpit&fixture=task-detail`
  // used to preview). 880 is this repo's wide measurement width and the reading column's own max-width.
  "task-detail": {
    bundle: "/dist/webview/task-detail.js",
    cssLinks: [
      CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/vscode-theme.css", "/dist/webview/task-studio.tailwind.css",
      "/dist/webview/rich-doc.css", "/dist/webview/studio-frame.css", "/dist/webview/task-studio.css",
      "/dist/webview/mermaid-block.css", "/dist/webview/task-detail.css",
    ],
    frame: { w: 880, h: 900 },
    fixtures: taskDetailFixtures as Record<string, Fixture>,
    // an entry of the code-split invocation, so the bundle is an ES module (same reason cockpit.js is).
    module: true,
    globals: {
      EXCALIDRAW_SCRIPT_URI: "/dist/webview/excalidraw.js",
      EXCALIDRAW_CSS_URI: "/dist/webview/excalidraw.css",
      EXCALIDRAW_ASSET_PATH: "/dist/webview/",
    },
    makeMessage: (vm) => {
      const detail = vm as { previewMode?: string; task?: { id: string; title: string; body?: string; kind?: string; priority?: number; assignee?: string; artifact_refs?: unknown[]; updatedAt: string }; wsHash: string; deps?: Array<{ id: string; title?: string; missing: boolean }> };
      if (detail.previewMode !== "edit" || !detail.task) return taskMessage(vm as never);
      return [
        taskMessage(vm as never),
        { type: "taskDocumentMode", mode: "edit" },
        {
          type: "load", studioProtocolVersion: 1,
          entity: {
            taskId: detail.task.id, workspaceHash: detail.wsHash, folder: "Taskedit", title: detail.task.title,
            kind: detail.task.kind, priority: detail.task.priority, assignee: detail.task.assignee,
            deps: detail.deps ?? [], artifact_refs: detail.task.artifact_refs ?? [],
            doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: detail.task.body ?? "" }] }] },
            attachments: [], bodyBaseline: detail.task.body ?? "", anchor: "load",
            expectUpdatedAt: detail.task.updatedAt, knownAgents: ["claude", "codex"],
          },
          concurrency: { kind: "cas", expected: detail.task.updatedAt },
        },
      ];
    },
  },
  // SDD 485 C5 — the Board, standalone again, so it gets its own route back for the same reason the task
  // detail did one commit earlier: this renders the REAL shipped `board.js` with the exact
  // stylesheet list `BoardPanel.ts` links, rather than the same component embedded inside Control.
  "board": {
    bundle: "/dist/webview/board.js",
    cssLinks: [
      CODICON,
      DESIGN_SYSTEM, QUICK_PICKER,
      // t-32c872 — the shared page frame, exactly where `BoardPanel.ts` links it. It is what makes
      // `.col-body { overflow-y: auto }` scroll per column instead of the whole page.
      "/dist/webview/page-frame.css",
      "/dist/webview/vscode-theme.css",
      "/dist/webview/board.tailwind.css",
      "/dist/webview/board.css",
    ],
    frame: { w: 1100, h: 720 },
    fixtures: boardFixtures as Record<string, Fixture>,
    // an entry of the code-split invocation, so the bundle is an ES module (same reason cockpit.js is).
    module: true,
    // the Board fills its editor tab and scrolls per column — the harness must render a real page frame.
    pageFrame: true,
    makeMessage: (vm) => boardSnapshotMessage(vm as never),
  },
  // SDD 485 D1 — the tmux Server Inspector, standalone again, so it gets its own route back for the same
  // reason the task detail and the Board did: this renders the REAL shipped `inspector.js` with the exact
  // stylesheet list `TmuxPanel.ts` links, rather than the same component embedded inside Control. Two
  // messages, which is why this route's `makeMessage` returns an array — and they are the SHARED
  // `init`/`model` envelopes now, not Control's namespaced `inspectorInit`/`inspectorModel`.
  //
  // No `pageFrame`: the inspector is a page-scrolling document (like the task detail), links no
  // `page-frame.css`, and anchors `#root` to nothing — so the harness's own anchored frame is the right
  // model of what a real webview gives it.
  inspector: {
    bundle: "/dist/webview/inspector.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/inspector.css"],
    frame: { w: 880, h: 900 },
    fixtures: inspectorFixtures as Record<string, Fixture>,
    // an entry of the code-split invocation, so the bundle is an ES module (same reason cockpit.js is).
    module: true,
    // t-6b5dea — `init` also carries the window scope, which is why the fixture decides it: `scoped`
    // renders the screen a sidebar selection produces, the others the screen with no selection at all.
    makeMessage: (vm) => [inspectorInitMessage(inspectorStrings, inspectorScopeFor(vm as never)), inspectorModelMessage(vm as never)],
  },
  // SDD 485 D2 — Plugins, standalone again, so it gets its own route back for the same reason the task
  // detail, the Board and the inspector did: this renders the REAL shipped `plugins.js` with the exact
  // stylesheet list `PluginsPanel.ts` links, rather than the same component embedded inside Control.
  //
  // No `pageFrame`: Plugins is a page-scrolling document (like the task detail and the inspector), links no
  // `page-frame.css`, and anchors `#root` to nothing — so the harness's own anchored frame is the right
  // model of what a real webview gives it. 880 is this repo's wide measurement width; the height is
  // generous because the four card states are measured on a list, and `plugins.css`'s own
  // `@media (max-width: 720px)` is what makes the 360 pass worth taking — `?width=360` reaches it now
  // that the frame is a viewport rather than a div (t-b24282).
  plugins: {
    bundle: "/dist/webview/plugins.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/plugins.tailwind.css", "/dist/webview/plugins.css"],
    frame: { w: 880, h: 900 },
    fixtures: pluginsFixtures as Record<string, Fixture>,
    // an entry of the code-split invocation, so the bundle is an ES module (same reason cockpit.js is).
    module: true,
    makeMessage: (vm) => pluginsMessage(vm as never),
  },
  // SDD 485 D3 — Runtime Ops, standalone again, so it gets its own route back for the same reason the
  // task detail, the Board, the inspector and Plugins did: this renders the REAL shipped `runtime-ops.js`
  // with the exact stylesheet list `RuntimeOpsPanel.ts` links, rather than the same component embedded
  // inside Control.
  //
  // **Restoring this key does more than serve a screenshot.** `?view=runtime-ops` was retired by t-ed3067
  // and `test/browser/runtimeOpsView.test.ts` has been knowingly RED ever since, held open by an in-file
  // `preview-route-check: allow` waiver (t-2a49b2) whose own text says it dies the day the route returns.
  // It returns here, with all seventeen fixtures addressable again — including the fifteen
  // `?view=cockpit&fixture=runtime` never could reach, which is the reason that suite was parked rather
  // than repointed.
  //
  // No `pageFrame`: Runtime Ops is a page-scrolling document (like the task detail, the inspector and
  // Plugins), links no `page-frame.css`, and anchors `#root` to nothing — so the harness's own anchored
  // frame is the right model of what a real webview gives it. The height is generous because the
  // provider-capacity block sits above a runtime table, and `runtime-ops.css`'s own
  // `@container (max-width: 720px)` / `@media (max-width: 760px)` blocks are what make the 360 pass worth
  // taking — `?width=360` reaches BOTH now that the frame is a viewport rather than a div (t-b24282).
  /**
   * SDD 485 D4 — the Human Inbox app. `list` and `item` are the app's TWO surfaces, and the route renders
   * whichever the fixture names, exactly as the real host does: this client picks its screen from the
   * message type the host posted, never from a local mode it flips itself.
   */
  "human-inbox": {
    bundle: "/dist/webview/human-inbox.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/human-inbox.css"],
    frame: { w: 880, h: 900 },
    fixtures: humanInboxFixtures as Record<string, Fixture>,
    // an entry of the code-split invocation, so the bundle is an ES module (same reason cockpit.js is).
    module: true,
    makeMessage: (vm) => {
      const state = vm as HumanInboxPreviewState;
      return state.state === "item" ? humanInboxItemMessage(state.vm) : humanInboxMessage(state.vm);
    },
  },
  "runtime-ops": {
    bundle: "/dist/webview/runtime-ops.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/runtime-ops.css"],
    frame: { w: 880, h: 900 },
    fixtures: runtimeOpsFixtures as Record<string, Fixture>,
    // an entry of the code-split invocation, so the bundle is an ES module (same reason cockpit.js is).
    module: true,
    makeMessage: (vm) => {
      const state = vm as RuntimeOpsPreviewState;
      return state.state === "loading" ? runtimeOpsLoadingMessage() : runtimeOpsSnapshotMessage(state.snapshot);
    },
  },
  "runtime-config": {
    bundle: "/dist/webview/runtime-config.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/runtime-config.css"],
    frame: { w: 880, h: 900 },
    fixtures: { default: { provenance: "unit-fixture-derived", vm: runtimeConfigFixtureSnapshot } },
    module: true,
    globals: { __TACHYON_STRINGS__: runtimeConfigPreviewStrings },
    makeMessage: (vm) => runtimeConfigSnapshotMessage(vm as never),
  },
  // SDD 485 D6 — the fixture moved with the renderer: the same classified model now reaches the real
  // standalone Worktrees bundle, with both shared sheets its production panel declares.
  worktrees: {
    bundle: "/dist/webview/worktrees.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/control-typography.css", "/dist/webview/engine-workspace.css", "/dist/webview/worktrees.css"],
    frame: { w: 880, h: 900 },
    // t-f3ded3 — `pr-draft` wraps the model with a host draft so ConfirmForm opens over the land block.
    fixtures: {
      default: cockpitFixtures.worktrees,
      "pr-draft": worktreesPrDraftFixture as never,
    },
    module: true,
    globals: { __TACHYON_STRINGS__: cockpitStrings },
    makeMessage: (vm) => {
      // t-f3ded3 — a draft fixture is `{ model, prDraft }`; the default is the bare sections model.
      if (vm && typeof vm === "object" && "prDraft" in (vm as object) && "model" in (vm as object)) {
        const wrapped = vm as { model: unknown; prDraft: Parameters<typeof worktreePrDraftMessage>[0] };
        return [worktreesModelMessage(wrapped.model as never), worktreePrDraftMessage(wrapped.prDraft)];
      }
      return worktreesModelMessage(vm as never);
    },
  },
  // t-5f2b5b — no `fleet` route: SDD 485 D7's Fleet app is deleted. The roster it previewed is the
  // sidebar's own AgentsRoster, and `?view=sidebar&fixture=agent-states` renders it in the surface that
  // still ships. `VIEW_META.sidebar` already carries the "fleet"/"agents" aliases, so a named lookup for
  // "fleet" resolves there rather than to nothing.
  settings: {
    bundle: "/dist/webview/settings.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/control-typography.css", "/dist/webview/engine-workspace.css", "/dist/webview/settings.css"],
    frame: { w: 880, h: 900 },
    fixtures: { default: cockpitFixtures.settings },
    module: true,
    globals: { __TACHYON_STRINGS__: cockpitStrings },
    makeMessage: (vm) => settingsModelMessage(vm as never),
  },
  // SDD 500 — one route where `overview` and `engine` were two, and three fixtures because the screen
  // has three shapes worth looking at: healthy, failed, and a window with a second root attached that
  // still draws ONE card (the only multi-root shape this product produces — see the fixture's comment).
  system: {
    bundle: "/dist/webview/system.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/engine-workspace.css", "/dist/webview/system.css"],
    frame: { w: 880, h: 900 },
    fixtures: {
      default: cockpitFixtures.default,
      "engine-error": cockpitFixtures["engine-error"],
      "multi-workspace-window": cockpitFixtures["multi-workspace-window"],
    },
    module: true,
    globals: { __TACHYON_STRINGS__: cockpitStrings },
    makeMessage: (vm) => systemModelMessage(vm as never),
  },
  handoff: {
    bundle: "/dist/webview/handoff.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/mermaid-block.css", "/dist/webview/activity.css", "/dist/webview/handoff.css"],
    frame: { w: 880, h: 900 },
    fixtures: handoffFixtures,
    module: true,
    makeMessage: (vm) => handoffMessage(vm as never),
  },
  // SDD 485 C1–C3 — the section-app proof surface: one manager, cardinality as a parameter. Dev-only, same
  // status as the two spec-350 fakes above.
  "section-app-fixture": {
    bundle: "/dist/webview/section-app-fixture.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, QUICK_PICKER, "/dist/webview/section-app-fixture.css"],
    frame: { w: 880, h: 520 },
    fixtures: sectionAppFixtureFixtures as Record<string, Fixture>,
    // SDD 485 C2 — an entry of the code-split invocation, so the bundle is an ES module (same reason
    // cockpit.js is, above): a classic <script> injection dies on its first `import`.
    module: true,
    makeMessage: (vm) => sectionAppFixtureMakeMessage(vm as never),
  },
  // t-610705 (SDD 410 Phase D, D0/D1a/D1b) — the standalone "command"/"terminal"/"runbook"/"schedule"
  // /"agent"-studio-shell routes previewed the retired standalone panels; they're Control routes now
  // (studio-new/studio-edit, studio:"command"/"terminal"/"runbook"/"schedule"/"agent") — use
  // ?view=cockpit&fixture=studio-<name> / studio-<name>-edit (same App.tsx components, same fixture
  // VMs via the cockpit route's activeRoute injection above).
};

/** Converted webviews may opt out only with a written reason. */
export const PREVIEW_ROUTE_OPTOUTS: Record<string, string> = {
  "plugin-host": "Spec 349 T10 relay needs a runtime-installed plugin payload and nonce-stamped srcdoc; covered by focused relay tests until T13 fixtures land.",
  // t-953471 / t-610355 — live xterm + node-pty tmux attach; no static fixture VM without a PTY host.
  "agent-pane": "Layer-2 agent pane needs a live node-pty attach to a tmux session; not renderable as a static preview fixture. Covered by unit (agentPane*) + Dev Host dogfood (t-610355).",
};

/** spec 281 — human label + alias match keys per view, for catalog-assisted RESOLUTION (the visual-qa skill
 *  matches a named surface deterministically against `view`/`title`/`aliases` before any semantic guess). */
export const VIEW_META: Record<string, { title: string; aliases: string[] }> = {
  // t-6e2952 — "control tab"/"control launcher" resolve HERE: the launcher is this view's second tab.
  sidebar: { title: "Tachyon Sidebar", aliases: ["sidebar", "fleet", "control tab", "control launcher"] },
  activity: { title: "Activity", aliases: ["activity", "agent activity", "chat", "transcript", "studio chat"] },
  probes: { title: "Probes", aliases: ["probes", "probe inspector"] },
  "pin-preview": { title: "Pin Preview", aliases: ["pin preview", "pin readonly"] },
  handoff: { title: "Project Handoff", aliases: ["handoff", "project handoff"] },
  approval: { title: "Human Approvals", aliases: ["approvals", "human approvals", "approval view"] },
  "pin-studio": { title: "Pin Studio", aliases: ["pin studio", "pin editor", "sketch"] },
  "task-studio": { title: "Task Studio", aliases: ["task studio", "task editor"] },
  "pipeline-studio": { title: "Pipeline Studio (shell fake)", aliases: ["pipeline studio", "studio shell fake", "spec 350"] },
  "agent-studio-fixture": { title: "Agent fixture (shell fake)", aliases: ["agent fixture", "agent shell fixture", "spec 350"] },
  "section-app-fixture": { title: "Section app (mechanism proof)", aliases: ["section app", "section panel", "standalone app", "spec 485"] },
  "board": { title: "Board", aliases: ["board", "board view", "task board", "kanban"] },
  "task-detail": { title: "Task Detail", aliases: ["task detail", "task", "task document", "detail tab"] },
  inspector: { title: "tmux", aliases: ["tmux", "server inspector", "tmux server inspector", "sessions"] },
  plugins: { title: "Plugins", aliases: ["plugins", "plugin manager", "install plugin", "marketplace"] },
  "runtime-ops": { title: "Runtime Ops", aliases: ["runtime ops", "runtime", "quota", "provider capacity", "rate limit"] },
  "human-inbox": { title: "Human Inbox", aliases: ["inbox", "human inbox", "waiting on you", "approvals queue"] },
  // SDD 500 — the merged surface answers to both retired names, so a named lookup for "overview" or
  // "engine" resolves HERE instead of to nothing (the same courtesy `sidebar` does for "fleet").
  system: { title: "System", aliases: ["system", "overview", "engine", "bridge", "control plane", "health"] },
  worktrees: { title: "Worktrees", aliases: ["worktrees", "managed worktrees", "checkout hygiene"] },
  "agent-studio-shell": { title: "Agent Studio", aliases: ["agent studio", "new agent", "edit agent"] },
  "terminal-studio-shell": { title: "Terminal Studio", aliases: ["terminal studio", "new terminal", "edit terminal"] },
  "command-studio-shell": { title: "Command Studio", aliases: ["command studio", "new command", "edit command"] },
  "runbook-studio-shell": { title: "Runbook Studio", aliases: ["runbook studio", "new runbook", "edit runbook"] },
  "schedule-studio-shell": { title: "Schedule Studio", aliases: ["schedule studio", "new schedule", "edit schedule"] },
};

/** the machine-readable route catalog (spec 278 design #5) — generated from ROUTES, consumed by passo 2 (spec 281). */
export interface CatalogEntry {
  view: string;
  fixture: string;
  url: string;
  frame: { w: number; h: number };
  tags: string[];
  /** spec 281 — friendly label + alias keys for deterministic name→view matching. */
  title?: string;
  aliases?: string[];
}

/** Generate the flat catalog: one entry per (view × fixture). `base` is the harness index URL.
 *  URLs stay view+fixture only — no `?width=`. Width is per capture (880 and 360 share one
 *  entry); the shell passes the outer window when the query is omitted (t-4a477f). Baking
 *  `route.frame.w` into the URL would lock every 360 shot to the wide frame. */
export function buildCatalog(base = "/scripts/webview-preview/index.html"): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const [view, route] of Object.entries(ROUTES)) {
    const meta = VIEW_META[view];
    for (const [fixture, fx] of Object.entries(route.fixtures)) {
      out.push({
        view, fixture, url: `${base}?view=${view}&fixture=${fixture}`, frame: route.frame, tags: [fx.provenance],
        ...(meta ? { title: meta.title, aliases: meta.aliases } : {}),
      });
    }
  }
  return out;
}
