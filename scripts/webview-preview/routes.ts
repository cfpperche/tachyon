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
import {
  initMessage as cockpitInitMessage,
  modelMessage as cockpitModelMessage,
} from "../../src/webview/cockpit/messages";
import { pinPreviewMessage } from "../../src/webview/pin-preview/messages";
import { handoffMessage } from "../../src/webview/handoff/messages";
import { approvalsMessage } from "../../src/webview/approval/messages";
import { validationsMessage } from "../../src/webview/validations/messages";
import { humanInboxItemMessage, humanInboxMessage } from "../../src/webview/human-inbox/messages";
import { taskMessage } from "../../src/webview/task-detail/messages";
import { runtimeOpsLoadingMessage, runtimeOpsSnapshotMessage } from "../../src/webview/runtime-ops/messages";
import { runtimeConfigSnapshotMessage } from "../../src/webview/runtime-config/messages";
import { sidebarFixtures } from "./fixtures/sidebar";
import { handoffFixtures } from "./fixtures/handoff";
import { approvalFixtures } from "./fixtures/approval";
import { pinStudioFixtures, pinStudioMakeMessage } from "./fixtures/pin-studio";
import { pluginsFixtures } from "./fixtures/plugins";
import { activityFixtures } from "./fixtures/activity";
import { probesFixtures } from "./fixtures/probes";
import { inspectorFixtures, strings as inspectorStrings } from "./fixtures/inspector";
import { initMessage as inspectorInitMessage, modelMessage as inspectorModelMessage } from "../../src/webview/inspector/messages";
import {
  cockpitFixtures,
  humanInboxFixtureVm,
  humanInboxItemFixtureVm,
  NAV_PENDING_TASK_ID,
  runtimeConfigFixtureSnapshot,
  strings as cockpitStrings,
  validationsFixtureVm,
} from "./fixtures/cockpit";
import { pinPreviewFixtures } from "./fixtures/pin-preview";
import { taskStudioFixtures, taskStudioMakeMessage } from "./fixtures/task-studio";
import { taskDetailFixtures } from "./fixtures/task-detail";
import { missionControlFixtures } from "./fixtures/mission-control";
import { snapshotMessage as missionControlSnapshotMessage } from "../../src/webview/mission-control/messages";
import { runtimeOpsFixtures, type RuntimeOpsPreviewState } from "./fixtures/runtime-ops";
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
  /**
   * t-32c872 — this surface IS the page (an SDD 485 standalone app that links `page-frame.css`), so the
   * harness must not interpose its own sized `#frame` box: `preview.ts` collapses it (`display: contents`)
   * and puts the frame size on `<html>` instead, which is where a real webview's page frame lives.
   *
   * Without this the harness is MORE generous than the product and cannot see a whole defect class. The
   * Board lost per-column scrolling standalone because `#root { height: 100% }` had no `body` height to
   * resolve against — and the harness rendered it correctly the whole time, because `#frame` handed `#root`
   * a definite height the real page never had. A harness that cannot reproduce the bug cannot witness the
   * fix either.
   */
  pageFrame?: boolean;
}

const CODICON = "/dist/webview/codicon.css";
const DESIGN_SYSTEM = "/dist/webview/design-system.css";

export const ROUTES: Record<string, Route> = {
  sidebar: {
    bundle: "/dist/webview/sidebar.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/sidebar.css"],
    frame: { w: 340, h: 760 },
    fixtures: sidebarFixtures as Record<string, Fixture>,
    // the sidebar host message wraps a single FleetVM in a one-fleet push (matches the real provider).
    makeMessage: (vm) => fleetMessage(Array.isArray(vm) ? vm as never : [vm as never], {}),
  },
  // t-6e2952 — the Control launcher has no route of its own: it is the "Control" TAB of the `sidebar`
  // route above (same bundle, same fixtures) — open ?view=sidebar and select the second tab.
  // t-610705 (SDD 410 Phase C.2) — the standalone "activity" and "probes" routes previewed the
  // retired Activity/Probes panels; both are Fleet subroutes now — use ?view=cockpit&fixture=
  // agent-activity / agent-probes (same App.tsx components, same fixture VMs, via the cockpit
  // route's activeRoute injection above).
  // t-b5dcae — the standalone "control-inspector" route previewed the Engine/Bridge Control
  // Inspector POC, which was dead code (ControlInspector.ts had zero importers). The real domain
  // logic (src/control-inspector/model.ts) survives — Cockpit's own Engine tab uses it directly,
  // covered by the cockpit route's own fixtures below.
  // Control visual monolith — Mission + Approvals + Plugins + Runtime Ops + tmux Inspector embeds.
  cockpit: {
    bundle: "/dist/webview/cockpit.js",
    cssLinks: [
      CODICON,
      DESIGN_SYSTEM,
      "/dist/webview/vscode-theme.css",
      // SDD 485 C5 — no mission-control sheets: the Board is a standalone app with its own route below,
      // and Control stopped linking them in the same change (cockpitCssParity asserts the two agree).
      // SDD 485 D2 — and no plugins sheets, for the same reason and in the same change.
      "/dist/webview/approval.css",
      "/dist/webview/human-inbox.css",
      "/dist/webview/validations.css",
      "/dist/webview/runtime-ops.css",
      "/dist/webview/mermaid-block.css",
      "/dist/webview/activity.css",
      "/dist/webview/probes.css",
      "/dist/webview/handoff.css",
      "/dist/webview/agent-studio-shell.tailwind.css",
      "/dist/webview/task-studio.tailwind.css",
      "/dist/webview/rich-doc.css",
      "/dist/webview/studio-frame.css",
      "/dist/webview/command-studio-shell.css",
      "/dist/webview/terminal-studio-shell.css",
      "/dist/webview/runbook-studio-shell.css",
      "/dist/webview/schedule-studio-shell.css",
      "/dist/webview/agent-studio-shell.css",
      "/dist/webview/task-studio.css",
      "/dist/webview/pin-studio.css",
      "/dist/webview/cockpit.css",
    ],
    frame: { w: 1100, h: 720 },
    fixtures: cockpitFixtures as Record<string, Fixture>,
    // SDD 410 Phase A — cockpit.js is now ESM with esbuild code-split chunks; the harness must load it as
    // a module (classic <script> injection dies with "Cannot use import statement outside a module").
    module: true,
    makeMessage: (vm) => {
      const model = vm as { section?: string };
      const msgs: unknown[] = [cockpitInitMessage(cockpitStrings), cockpitModelMessage(vm as never)];
      // t-ac79a7 — the nav-feedback fixture: push the SAME `routePending` envelope the live host
      // posts from navigate(), and deliberately never the matching `routeReady`, so the surface
      // stays in the pending bracket for as long as the screenshot needs. The client's own timers
      // then produce "slow" and "stalled" — the states are the real client's, not the harness's.
      // Identified by reference against the fixture entry itself: this fixture's model is an
      // ordinary Board (that IS the state being depicted — the origin screen, still on screen while
      // the destination loads), so there is no marker inside it to key off, and inventing one would
      // have meant a fixture that no longer looks like what the client really holds.
      if (vm === cockpitFixtures["nav-pending"]?.vm) {
        msgs.push({ type: "routePending", routeKey: `task-detail:b349073a:${NAV_PENDING_TASK_ID}` });
      }
      // Push the same host envelopes the live Control panel uses for embedded tabs.
      // SDD 485 C5 — no `section === "mission"` arm: the Board has its own route in this table now, for
      // the same reason C4's task detail does. `nav-pending` still carries `section: "mission"` — that
      // fixture depicts CONTROL waiting on a navigation, and its section is only what the model happened
      // to hold; nothing renders a board here.
      if (model.section === "validations") {
        msgs.push(validationsMessage(validationsFixtureVm));
      } else if (model.section === "approvals") {
        const approval = approvalFixtures.pending?.vm;
        if (approval) msgs.push(approvalsMessage(approval));
      } else if (model.section === "inbox") {
        // t-d16698 — the Inbox list. The item subroute rides on top of this same section push below,
        // exactly like task-detail rides on Mission's.
        msgs.push(humanInboxMessage(humanInboxFixtureVm));
      } else if (model.section === "runtime") {
        const runtime = runtimeOpsFixtures.default?.vm as RuntimeOpsPreviewState | undefined;
        if (runtime) {
          msgs.push(
            runtime.state === "loading"
              ? runtimeOpsLoadingMessage()
              : runtimeOpsSnapshotMessage(runtime.snapshot),
          );
        }
      } else if (model.section === "runtime-config") {
        msgs.push(runtimeConfigSnapshotMessage(runtimeConfigFixtureSnapshot));
      }
      // SDD 485 D2 — no `section === "plugins"` arm: Plugins has its own route in this table now, for the
      // same reason C4's task detail and C5's Board do. The identity-matching this arm used to do (four
      // cockpit fixtures sharing one section, disambiguated by object identity) is gone with it — the
      // plugins route names its fixtures directly, which is what a route of one's own buys.
      // t-610705 (Phase C.1/C.2) — a subroute rides alongside its parent section's push (the Fleet
      // subroutes below all nav to a section with no embed push of its own for THEM, so this just adds
      // the subroute's own content on top).
      // SDD 485 C4 — the `task-detail` arm is GONE with the subroute: the task detail has its own route
      // in this table now (`?view=task-detail`), rendering the real standalone bundle rather than the
      // same component embedded in Control. `nav-pending` still names a `task-detail:` routeKey below —
      // that fixture depicts CONTROL waiting on a navigation, and the routeKey is the wire string it
      // waits on, not a screen this route renders.
      const activeRoute = (model as { activeRoute?: { kind?: string; wsHash?: string; agent?: string } }).activeRoute;
      if (activeRoute?.kind === "agent-activity" && activeRoute.wsHash && activeRoute.agent) {
        const feed = activityFixtures.default?.vm;
        if (feed) msgs.push(activityMessage(activeRoute.wsHash, activeRoute.agent, feed));
      } else if (activeRoute?.kind === "project-handoff") {
        // t-ace77f — Handoff moved from a section push to a detail route: same fixture VM, same
        // envelope, now keyed off the route instead of the tab.
        const handoff = handoffFixtures.default?.vm;
        if (handoff) msgs.push(handoffMessage(handoff));
      } else if (activeRoute?.kind === "inbox-item") {
        // t-d16698 — where every Inbox doorbell's "Review" is supposed to land: ONE item, opened.
        msgs.push(humanInboxItemMessage(humanInboxItemFixtureVm));
      } else if (activeRoute?.kind === "agent-probes" || activeRoute?.kind === "workspace-probes") {
        const probes = probesFixtures.default?.vm;
        if (probes) msgs.push(probesMessage(probes));
      } else if ((activeRoute?.kind === "studio-new" || activeRoute?.kind === "studio-edit") && (activeRoute as { studio?: string }).studio) {
        // t-610705 (Phase D, D0/D1a) — a studio route: reuses the SAME fixture VMs + envelope shape
        // each (now-retired-standalone) <studio>-studio-shell route used, pushed unconditionally
        // rather than gated on a real "ready" mount handshake (this static harness has no live host
        // to answer one — the client processes whatever arrives regardless of handshake state).
        // SDD 471 — entityId selects which agent-shell fixture the studio route renders, so the
        // Claude bypass-authorization states are reachable the same way canonical-reviewer is.
        const agentFixtureByEntity: Record<string, string> = {
          "canonical-reviewer": "canonical-disabled",
          "canonical-claude-bypass-off": "canonical-claude-bypass-off",
          "canonical-claude-bypass-on": "canonical-claude-bypass-on",
          "canonical-codex-danger-off": "canonical-codex-danger-off",
          "canonical-codex-danger-on": "canonical-codex-danger-on",
          // t-e722ce — the forget plan panel, both shapes, addressable without driving a click.
          "canonical-forget-plan": "forget-plan",
          "canonical-forget-plan-blocked": "forget-plan-blocked",
        };
        const entityId = (activeRoute as { entityId?: string }).entityId ?? "";
        const key = (activeRoute as { studio?: string }).studio === "agent" && agentFixtureByEntity[entityId]
          ? agentFixtureByEntity[entityId]
          : activeRoute.kind === "studio-edit" ? "dense-edit" : "new";
        const byStudio: Record<string, { fixtures: Record<string, Fixture>; makeMessage: (vm: unknown) => unknown }> = {
          command: { fixtures: commandStudioShellFixtures as Record<string, Fixture>, makeMessage: (vm) => commandStudioShellMakeMessage(vm as never) },
          terminal: { fixtures: terminalStudioShellFixtures as Record<string, Fixture>, makeMessage: (vm) => terminalStudioShellMakeMessage(vm as never) },
          runbook: { fixtures: runbookStudioShellFixtures as Record<string, Fixture>, makeMessage: (vm) => runbookStudioShellMakeMessage(vm as never) },
          schedule: { fixtures: scheduleStudioShellFixtures as Record<string, Fixture>, makeMessage: (vm) => scheduleStudioShellMakeMessage(vm as never) },
          agent: { fixtures: agentStudioShellFixtures as Record<string, Fixture>, makeMessage: (vm) => agentStudioShellMakeMessage(vm as never) },
          // t-610705 (Phase D, D2) — task's fixtures module predates the "-shell" naming convention
          // (it's task-studio/, not task-studio-shell/) and was written for the now-retired standalone
          // "task-studio" preview route below — reused as-is here rather than renamed, same "dense-edit"
          // key every other studio's fixtures module provides.
          task: { fixtures: taskStudioFixtures as Record<string, Fixture>, makeMessage: (vm) => taskStudioMakeMessage(vm as never) },
          // t-610705 (Phase D, D3) — same "-shell" naming exception as task above (pin-studio/, not
          // pin-studio-shell/) — reused as-is from the now-retired standalone "pin-studio" preview
          // route below.
          pin: { fixtures: pinStudioFixtures as Record<string, Fixture>, makeMessage: (vm) => pinStudioMakeMessage(vm as never) },
        };
        const entry = byStudio[(activeRoute as { studio: string }).studio];
        const studio = entry?.fixtures[key]?.vm;
        if (studio) {
          // t-610705 (Phase D, D2) — task's makeMessage (unlike the other 5 studio-shell modules'
          // single-object return) returns unknown[] (its "conflict" fixture needs a second, distinct
          // error envelope alongside "load" — see fixtures/task-studio.ts) — spread rather than push
          // the array itself as one opaque element.
          const result = entry.makeMessage(studio);
          if (Array.isArray(result)) msgs.push(...result);
          else msgs.push(result);
        }
      }
      return msgs;
    },
  },
  "pin-preview": {
    bundle: "/dist/webview/pin-preview.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/pin-preview.css"],
    frame: { w: 880, h: 700 },
    fixtures: pinPreviewFixtures as Record<string, Fixture>,
    makeMessage: (vm) => pinPreviewMessage(vm as never),
  },
  // t-610705 (SDD 410 Phase C.3) — the standalone "handoff" route previewed the retired Project
  // Handoff panel; Handoff is a cockpit-only section now — use ?view=cockpit&fixture=handoff (same
  // App.tsx, same fixture VM, via the cockpit route's section injection above).
  // t-610705 (SDD 410 Phase A/B pilot, found + closed in the Phase E audit, 2026-07-22) — the
  // standalone "approval" route previewed the retired Approvals panel; Approvals is a cockpit-only
  // section now — use ?view=cockpit&fixture=approvals (same App.tsx, same fixture VM, via the
  // cockpit route's section injection above).
  // t-610705 (SDD 410 Phase B #6) — the standalone "mission-control" route previewed the retired
  // Board panel; the Board is a cockpit-only section now — use ?view=cockpit&fixture=mission
  // (same App.tsx, same fixture VM via the cockpit route's board injection below).
  // t-ed3067 — the standalone "runtime-ops" route previewed RuntimeOpsView.ts, retired as dead code
  // (never registered in production). Runtime Ops is a cockpit-only section now; use
  // ?view=cockpit&fixture=runtime for its visual QA — same App.tsx component either way.
  // t-610705 (SDD 410 Phase D, D2) — the standalone "task-studio" route previewed the retired
  // TaskStudioPanel.ts webview; Task Studio is a cockpit-only studio route now — use
  // ?view=cockpit&fixture=studio-task-edit (same App.tsx, same fixture VMs, via the cockpit route's
  // byStudio fixture injection above).
  // t-610705 (SDD 410 Phase C.1) — the standalone "task-detail" route previewed the retired Task
  // Detail panel; Task Detail is a cockpit-only subroute now — use
  // ?view=cockpit&fixture=task-detail (same App.tsx, same fixture VM, via the cockpit route's
  // activeRoute injection above).
  // t-610705 (SDD 410 Phase D, D3) — the standalone "pin-studio" route previewed the retired
  // PinStudioPanel.ts webview; Pin Studio is a cockpit-only studio route now — use
  // ?view=cockpit&fixture=studio-pin-edit (same App.tsx, same fixture VMs, via the cockpit route's
  // byStudio fixture injection above).
  // spec 350 T4 — Pipeline Studio (Fake 1): the studio-shell's Phase 1 proof surface. Dev-flag-hidden (no
  // command contribution) — reachable only through this route and its own host-side tests.
  "pipeline-studio": {
    bundle: "/dist/webview/pipeline-studio.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/studio-frame.css", "/dist/webview/pipeline-studio.css"],
    frame: { w: 900, h: 760 },
    fixtures: pipelineStudioFixtures as Record<string, Fixture>,
    makeMessage: (vm) => pipelineStudioMakeMessage(vm as never),
  },
  // spec 350 T5 — Agent-entity fixture (Fake 2): region-composition proof (quick-add chips, role select,
  // instructions, worktree section). Dev-flag-hidden, same status as pipeline-studio above.
  "agent-studio-fixture": {
    bundle: "/dist/webview/agent-studio-fixture.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/studio-frame.css", "/dist/webview/agent-studio-fixture.css"],
    frame: { w: 720, h: 980 },
    fixtures: agentStudioFixtureFixtures as Record<string, Fixture>,
    makeMessage: (vm) => agentStudioFixtureMakeMessage(vm as never),
  },
  // SDD 485 C4 — Task Detail is a standalone app again, so it gets its own route back: this renders the
  // REAL shipped `task-detail.js` bundle with the exact stylesheet list `TaskDetailPanel.ts` links, rather
  // than the same component embedded inside Control (which is what `?view=cockpit&fixture=task-detail`
  // used to preview). 880 is this repo's wide measurement width and the reading column's own max-width.
  "task-detail": {
    bundle: "/dist/webview/task-detail.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/mermaid-block.css", "/dist/webview/task-detail.css"],
    frame: { w: 880, h: 900 },
    fixtures: taskDetailFixtures as Record<string, Fixture>,
    // an entry of the code-split invocation, so the bundle is an ES module (same reason cockpit.js is).
    module: true,
    makeMessage: (vm) => taskMessage(vm as never),
  },
  // SDD 485 C5 — the Board, standalone again, so it gets its own route back for the same reason the task
  // detail did one commit earlier: this renders the REAL shipped `mission-control.js` with the exact
  // stylesheet list `BoardPanel.ts` links, rather than the same component embedded inside Control.
  "mission-control": {
    bundle: "/dist/webview/mission-control.js",
    cssLinks: [
      CODICON,
      DESIGN_SYSTEM,
      // t-32c872 — the shared page frame, exactly where `BoardPanel.ts` links it. It is what makes
      // `.col-body { overflow-y: auto }` scroll per column instead of the whole page.
      "/dist/webview/page-frame.css",
      "/dist/webview/vscode-theme.css",
      "/dist/webview/mission-control.tailwind.css",
      "/dist/webview/mission-control.css",
    ],
    frame: { w: 1100, h: 720 },
    fixtures: missionControlFixtures as Record<string, Fixture>,
    // an entry of the code-split invocation, so the bundle is an ES module (same reason cockpit.js is).
    module: true,
    // the Board fills its editor tab and scrolls per column — the harness must render a real page frame.
    pageFrame: true,
    makeMessage: (vm) => missionControlSnapshotMessage(vm as never),
  },
  // SDD 485 D1 — the tmux Server Inspector, standalone again, so it gets its own route back for the same
  // reason the task detail and the Board did: this renders the REAL shipped `inspector.js` with the exact
  // stylesheet list `TmuxPanel.ts` links, rather than the same component embedded inside Control. Two
  // messages, which is why this route's `makeMessage` returns an array — and they are the SHARED
  // `init`/`model` envelopes now, not Control's namespaced `inspectorInit`/`inspectorModel`.
  //
  // No `pageFrame`: the inspector is a page-scrolling document (like the task detail), links no
  // `page-frame.css`, and anchors `#root` to nothing — so the harness's own sized `#frame` is the right
  // model of what a real webview gives it.
  inspector: {
    bundle: "/dist/webview/inspector.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/inspector.css"],
    frame: { w: 880, h: 900 },
    fixtures: inspectorFixtures as Record<string, Fixture>,
    // an entry of the code-split invocation, so the bundle is an ES module (same reason cockpit.js is).
    module: true,
    makeMessage: (vm) => [inspectorInitMessage(inspectorStrings), inspectorModelMessage(vm as never)],
  },
  // SDD 485 D2 — Plugins, standalone again, so it gets its own route back for the same reason the task
  // detail, the Board and the inspector did: this renders the REAL shipped `plugins.js` with the exact
  // stylesheet list `PluginsPanel.ts` links, rather than the same component embedded inside Control.
  //
  // No `pageFrame`: Plugins is a page-scrolling document (like the task detail and the inspector), links no
  // `page-frame.css`, and anchors `#root` to nothing — so the harness's own sized `#frame` is the right
  // model of what a real webview gives it. 880 is this repo's wide measurement width; the height is
  // generous because the four card states are measured on a list, and `plugins.css`'s own
  // `@media (max-width: 720px)` is what makes the 360 pass worth taking (it needs the BROWSER viewport
  // set, not only `?width=` — t-b24282).
  plugins: {
    bundle: "/dist/webview/plugins.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/plugins.tailwind.css", "/dist/webview/plugins.css"],
    frame: { w: 880, h: 900 },
    fixtures: pluginsFixtures as Record<string, Fixture>,
    // an entry of the code-split invocation, so the bundle is an ES module (same reason cockpit.js is).
    module: true,
    makeMessage: (vm) => pluginsMessage(vm as never),
  },
  // SDD 485 C1–C3 — the section-app proof surface: one manager, cardinality as a parameter. Dev-only, same
  // status as the two spec-350 fakes above.
  "section-app-fixture": {
    bundle: "/dist/webview/section-app-fixture.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/section-app-fixture.css"],
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
  cockpit: {
    title: "Control",
    aliases: ["control", "cockpit", "sysadmin", "project control", "fleet control", "control plane"],
  },
  "pin-preview": { title: "Pin Preview", aliases: ["pin preview", "pin readonly"] },
  handoff: { title: "Project Handoff", aliases: ["handoff", "project handoff"] },
  approval: { title: "Human Approvals", aliases: ["approvals", "human approvals", "approval view"] },
  "pin-studio": { title: "Pin Studio", aliases: ["pin studio", "pin editor", "sketch"] },
  "task-studio": { title: "Task Studio", aliases: ["task studio", "task editor"] },
  "pipeline-studio": { title: "Pipeline Studio (shell fake)", aliases: ["pipeline studio", "studio shell fake", "spec 350"] },
  "agent-studio-fixture": { title: "Agent fixture (shell fake)", aliases: ["agent fixture", "agent shell fixture", "spec 350"] },
  "section-app-fixture": { title: "Section app (mechanism proof)", aliases: ["section app", "section panel", "standalone app", "spec 485"] },
  "mission-control": { title: "Board", aliases: ["board", "mission control", "task board", "kanban"] },
  "task-detail": { title: "Task Detail", aliases: ["task detail", "task", "task document", "detail tab"] },
  inspector: { title: "tmux", aliases: ["tmux", "server inspector", "tmux server inspector", "sessions"] },
  plugins: { title: "Plugins", aliases: ["plugins", "plugin manager", "install plugin", "marketplace"] },
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

/** Generate the flat catalog: one entry per (view × fixture). `base` is the harness index URL. */
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
