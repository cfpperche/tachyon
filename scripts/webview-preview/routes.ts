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
import { pinStudioMessage } from "../../src/webview/pin-studio/messages";
import { taskMessage } from "../../src/webview/task-detail/messages";
import { runtimeOpsLoadingMessage, runtimeOpsSnapshotMessage } from "../../src/webview/runtime-ops/messages";
import { sidebarFixtures } from "./fixtures/sidebar";
import { handoffFixtures } from "./fixtures/handoff";
import { approvalFixtures } from "./fixtures/approval";
import { pinStudioFixtures } from "./fixtures/pin-studio";
import { pluginsFixtures } from "./fixtures/plugins";
import { activityFixtures } from "./fixtures/activity";
import { probesFixtures } from "./fixtures/probes";
import { inspectorFixtures, strings as inspectorStrings } from "./fixtures/inspector";
import { cockpitFixtures, strings as cockpitStrings, validationsFixtureVm } from "./fixtures/cockpit";
import { pinPreviewFixtures } from "./fixtures/pin-preview";
import { taskStudioFixtures, taskStudioMakeMessage } from "./fixtures/task-studio";
import { taskDetailFixtures } from "./fixtures/task-detail";
import { missionControlFixtures } from "./fixtures/mission-control";
import { runtimeOpsFixtures, type RuntimeOpsPreviewState } from "./fixtures/runtime-ops";
import { pipelineStudioFixtures, pipelineStudioMakeMessage } from "./fixtures/pipeline-studio";
import { agentStudioFixtureFixtures, agentStudioFixtureMakeMessage } from "./fixtures/agent-studio-fixture";
import { agentStudioShellFixtures, agentStudioShellMakeMessage } from "./fixtures/agent-studio-shell";
import { terminalStudioShellFixtures, terminalStudioShellMakeMessage } from "./fixtures/terminal-studio-shell";
import { commandStudioShellFixtures, commandStudioShellMakeMessage } from "./fixtures/command-studio-shell";
import { runbookStudioShellFixtures, runbookStudioShellMakeMessage } from "./fixtures/runbook-studio-shell";
import { scheduleStudioShellFixtures, scheduleStudioShellMakeMessage } from "./fixtures/schedule-studio-shell";

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
    makeMessage: (vm) => fleetMessage([vm as never], {}),
  },
  // t-d23f93 — the standalone "plugins" route previewed the retired standalone panel; Plugins is a
  // cockpit-only section now — use ?view=cockpit&fixture=plugins (same App.tsx, same fixture VM).
  // t-610705 (SDD 410 Phase C.2) — the standalone "activity" and "probes" routes previewed the
  // retired Activity/Probes panels; both are Fleet subroutes now — use ?view=cockpit&fixture=
  // agent-activity / agent-probes (same App.tsx components, same fixture VMs, via the cockpit
  // route's activeRoute injection above).
  // t-610705 (SDD 410 Phase B #5) — the standalone "inspector" route previewed the retired tmux
  // Server Inspector panel; tmux is a cockpit-only section now — use ?view=cockpit&fixture=tmux
  // (same App.tsx, same fixture VM).
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
      "/dist/webview/mission-control.tailwind.css",
      "/dist/webview/mission-control.css",
      "/dist/webview/plugins.tailwind.css",
      "/dist/webview/plugins.css",
      "/dist/webview/approval.css",
      "/dist/webview/validations.css",
      "/dist/webview/runtime-ops.css",
      "/dist/webview/inspector.css",
      "/dist/webview/mermaid-block.css",
      "/dist/webview/task-detail.css",
      "/dist/webview/activity.css",
      "/dist/webview/probes.css",
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
      // Push the same host envelopes the live Control panel uses for embedded tabs.
      if (model.section === "mission") {
        const board = missionControlFixtures.default?.vm;
        if (board) msgs.push({ type: "snapshot", vm: board });
      } else if (model.section === "validations") {
        msgs.push(validationsMessage(validationsFixtureVm));
      } else if (model.section === "approvals") {
        const approval = approvalFixtures.pending?.vm;
        if (approval) msgs.push(approvalsMessage(approval));
      } else if (model.section === "runtime") {
        const runtime = runtimeOpsFixtures.default?.vm as RuntimeOpsPreviewState | undefined;
        if (runtime) {
          msgs.push(
            runtime.state === "loading"
              ? runtimeOpsLoadingMessage()
              : runtimeOpsSnapshotMessage(runtime.snapshot),
          );
        }
      } else if (model.section === "tmux") {
        const insp = inspectorFixtures.default?.vm;
        if (insp) {
          msgs.push({ type: "inspectorInit", strings: inspectorStrings });
          msgs.push({ type: "inspectorModel", model: insp });
        }
      } else if (model.section === "plugins") {
        const plugins = pluginsFixtures.default?.vm;
        if (plugins) msgs.push(pluginsMessage(plugins));
      }
      // t-610705 (Phase C.1/C.2) — a subroute rides alongside its parent section's push (task-detail
      // and the Fleet subroutes below all nav to a section with no embed push of its own for THEM,
      // so this just adds the subroute's own content on top).
      const activeRoute = (model as { activeRoute?: { kind?: string; wsHash?: string; agent?: string } }).activeRoute;
      if (activeRoute?.kind === "task-detail") {
        const detail = taskDetailFixtures.default?.vm;
        if (detail) msgs.push(taskMessage(detail));
      } else if (activeRoute?.kind === "agent-activity" && activeRoute.wsHash && activeRoute.agent) {
        const feed = activityFixtures.default?.vm;
        if (feed) msgs.push(activityMessage(activeRoute.wsHash, activeRoute.agent, feed));
      } else if (activeRoute?.kind === "agent-probes" || activeRoute?.kind === "workspace-probes") {
        const probes = probesFixtures.default?.vm;
        if (probes) msgs.push(probesMessage(probes));
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
  handoff: {
    bundle: "/dist/webview/handoff.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/mermaid-block.css", "/dist/webview/handoff.css"],
    frame: { w: 900, h: 760 },
    fixtures: handoffFixtures as Record<string, Fixture>,
    makeMessage: (vm) => handoffMessage(vm as never),
  },
  approval: {
    bundle: "/dist/webview/approval.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/approval.css"],
    frame: { w: 900, h: 760 },
    fixtures: approvalFixtures as Record<string, Fixture>,
    makeMessage: (vm) => approvalsMessage(vm as never),
  },
  "pin-studio": {
    bundle: "/dist/webview/pin-studio.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/rich-doc.css", "/dist/webview/studio-frame.css", "/dist/webview/pin-studio.css"],
    frame: { w: 900, h: 800 },
    fixtures: pinStudioFixtures as Record<string, Fixture>,
    makeMessage: (vm) => pinStudioMessage(vm as never),
  },
  // t-610705 (SDD 410 Phase B #6) — the standalone "mission-control" route previewed the retired
  // Board panel; the Board is a cockpit-only section now — use ?view=cockpit&fixture=mission
  // (same App.tsx, same fixture VM via the cockpit route's board injection below).
  // t-ed3067 — the standalone "runtime-ops" route previewed RuntimeOpsView.ts, retired as dead code
  // (never registered in production). Runtime Ops is a cockpit-only section now; use
  // ?view=cockpit&fixture=runtime for its visual QA — same App.tsx component either way.
  // spec 342 dogfood round 2 (#4) — onboards Task Studio (the surface that motivated this spec's Pilot B)
  // into the harness; spec 350 T3 migrated it onto the studio shell (StudioFrame chrome, studio-frame.css
  // added to the CSS order — matches TaskStudioPanel.ts's real renderWebviewShell call exactly).
  "task-studio": {
    bundle: "/dist/webview/task-studio.js",
    cssLinks: [
      CODICON,
      DESIGN_SYSTEM,
      "/dist/webview/vscode-theme.css",
      "/dist/webview/task-studio.tailwind.css",
      "/dist/webview/rich-doc.css",
      "/dist/webview/studio-frame.css",
      "/dist/webview/task-studio.css",
    ],
    frame: { w: 900, h: 800 },
    fixtures: taskStudioFixtures as Record<string, Fixture>,
    makeMessage: (vm) => taskStudioMakeMessage(vm as never),
  },
  // t-610705 (SDD 410 Phase C.1) — the standalone "task-detail" route previewed the retired Task
  // Detail panel; Task Detail is a cockpit-only subroute now — use
  // ?view=cockpit&fixture=task-detail (same App.tsx, same fixture VM, via the cockpit route's
  // activeRoute injection above).
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
  // spec 350 Phase 3 T3 — Agent Studio (shell): the pilot's real per-entity agent-kind studio (create + edit)
  // on the shell — same CSS order as pipeline-studio/task-studio's real renderWebviewShell call.
  "agent-studio-shell": {
    bundle: "/dist/webview/agent-studio-shell.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/vscode-theme.css", "/dist/webview/agent-studio-shell.tailwind.css", "/dist/webview/studio-frame.css", "/dist/webview/agent-studio-shell.css"],
    frame: { w: 900, h: 900 },
    fixtures: agentStudioShellFixtures as Record<string, Fixture>,
    makeMessage: (vm) => agentStudioShellMakeMessage(vm as never),
  },
  "terminal-studio-shell": {
    bundle: "/dist/webview/terminal-studio-shell.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/studio-frame.css", "/dist/webview/terminal-studio-shell.css"],
    frame: { w: 900, h: 760 },
    fixtures: terminalStudioShellFixtures as Record<string, Fixture>,
    makeMessage: (vm) => terminalStudioShellMakeMessage(vm as never),
  },
  "command-studio-shell": {
    bundle: "/dist/webview/command-studio-shell.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/studio-frame.css", "/dist/webview/command-studio-shell.css"],
    frame: { w: 760, h: 640 },
    fixtures: commandStudioShellFixtures as Record<string, Fixture>,
    makeMessage: (vm) => commandStudioShellMakeMessage(vm as never),
  },
  "runbook-studio-shell": {
    bundle: "/dist/webview/runbook-studio-shell.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/studio-frame.css", "/dist/webview/runbook-studio-shell.css"],
    frame: { w: 760, h: 760 },
    fixtures: runbookStudioShellFixtures as Record<string, Fixture>,
    makeMessage: (vm) => runbookStudioShellMakeMessage(vm as never),
  },
  "schedule-studio-shell": {
    bundle: "/dist/webview/schedule-studio-shell.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/studio-frame.css", "/dist/webview/schedule-studio-shell.css"],
    frame: { w: 760, h: 760 },
    fixtures: scheduleStudioShellFixtures as Record<string, Fixture>,
    makeMessage: (vm) => scheduleStudioShellMakeMessage(vm as never),
  },
};

/** Converted webviews may opt out only with a written reason. */
export const PREVIEW_ROUTE_OPTOUTS: Record<string, string> = {
  "plugin-host": "Spec 349 T10 relay needs a runtime-installed plugin payload and nonce-stamped srcdoc; covered by focused relay tests until T13 fixtures land.",
};

/** spec 281 — human label + alias match keys per view, for catalog-assisted RESOLUTION (the visual-qa skill
 *  matches a named surface deterministically against `view`/`title`/`aliases` before any semantic guess). */
export const VIEW_META: Record<string, { title: string; aliases: string[] }> = {
  sidebar: { title: "Tachyon Sidebar", aliases: ["sidebar", "fleet"] },
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
