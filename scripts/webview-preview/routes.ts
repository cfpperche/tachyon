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
import { initMessage, modelMessage } from "../../src/webview/inspector/messages";
import { initMessage as studioInitMessage } from "../../src/webview/agent-studio/messages";
import { pinPreviewMessage } from "../../src/webview/pin-preview/messages";
import { handoffMessage } from "../../src/webview/handoff/messages";
import { pinStudioMessage } from "../../src/webview/pin-studio/messages";
import { taskStudioMessage } from "../../src/webview/task-studio/messages";
import { taskMessage } from "../../src/webview/task-detail/messages";
import { snapshotMessage } from "../../src/webview/mission-control/messages";
import { sidebarFixtures } from "./fixtures/sidebar";
import { handoffFixtures } from "./fixtures/handoff";
import { pinStudioFixtures } from "./fixtures/pin-studio";
import { pluginsFixtures } from "./fixtures/plugins";
import { activityFixtures } from "./fixtures/activity";
import { probesFixtures } from "./fixtures/probes";
import { inspectorFixtures, strings as inspectorStrings } from "./fixtures/inspector";
import { agentStudioFixtures } from "./fixtures/agent-studio";
import { pinPreviewFixtures } from "./fixtures/pin-preview";
import { taskStudioFixtures } from "./fixtures/task-studio";
import { taskDetailFixtures } from "./fixtures/task-detail";
import { missionControlFixtures } from "./fixtures/mission-control";

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
  plugins: {
    bundle: "/dist/webview/plugins.js",
    // spec 342 Pilot A — vscode-theme.css + plugins.tailwind.css for this panel's Kit components (order:
    // design-system → vscode-theme → Tailwind → surface CSS, matching PluginsPanel.ts's real shell call).
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/vscode-theme.css", "/dist/webview/plugins.tailwind.css", "/dist/webview/plugins.css"],
    frame: { w: 900, h: 760 },
    fixtures: pluginsFixtures as Record<string, Fixture>,
    makeMessage: (vm) => pluginsMessage(vm as never),
  },
  activity: {
    bundle: "/dist/webview/activity.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/activity.css"],
    frame: { w: 820, h: 900 },
    fixtures: activityFixtures as Record<string, Fixture>,
    makeMessage: (vm) => activityMessage(vm as never),
  },
  probes: {
    bundle: "/dist/webview/probes.js",
    cssLinks: [DESIGN_SYSTEM, "/dist/webview/probes.css"],
    frame: { w: 900, h: 600 },
    fixtures: probesFixtures as Record<string, Fixture>,
    makeMessage: (vm) => probesMessage(vm as never),
  },
  inspector: {
    bundle: "/dist/webview/inspector.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/inspector.css"],
    frame: { w: 800, h: 760 },
    fixtures: inspectorFixtures as Record<string, Fixture>,
    // the inspector needs init (strings) THEN model — two messages.
    makeMessage: (vm) => [initMessage(inspectorStrings), modelMessage(vm as never)],
  },
  "agent-studio": {
    bundle: "/dist/webview/agent-studio.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/agent-studio.css"],
    frame: { w: 660, h: 900 },
    fixtures: agentStudioFixtures as Record<string, Fixture>,
    // the Studio renders from a single init message (the fixture VM IS the InitPayload).
    makeMessage: (vm) => studioInitMessage(vm as never),
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
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/handoff.css"],
    frame: { w: 900, h: 760 },
    fixtures: handoffFixtures as Record<string, Fixture>,
    makeMessage: (vm) => handoffMessage(vm as never),
  },
  "pin-studio": {
    bundle: "/dist/webview/pin-studio.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/rich-doc.css", "/dist/webview/pin-studio.css"],
    frame: { w: 900, h: 800 },
    fixtures: pinStudioFixtures as Record<string, Fixture>,
    makeMessage: (vm) => pinStudioMessage(vm as never),
  },
  "mission-control": {
    bundle: "/dist/webview/mission-control.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/mission-control.css"],
    frame: { w: 1280, h: 760 },
    fixtures: missionControlFixtures as Record<string, Fixture>,
    makeMessage: (vm) => snapshotMessage(vm as never),
  },
  // spec 342 dogfood round 2 (#4) — onboards Task Studio (the surface that motivated this spec's Pilot B)
  // into the harness; CSS order matches TaskStudioPanel.ts's real renderWebviewShell call exactly (also
  // mirrored by test/browser/pilotBTaskStudio.test.ts's hand-built host page, pre-dating this route).
  "task-studio": {
    bundle: "/dist/webview/task-studio.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/vscode-theme.css", "/dist/webview/task-studio.tailwind.css", "/dist/webview/rich-doc.css", "/dist/webview/task-studio.css"],
    frame: { w: 900, h: 800 },
    fixtures: taskStudioFixtures as Record<string, Fixture>,
    makeMessage: (vm) => taskStudioMessage(vm as never),
  },
  // spec 342 dogfood round 2 (#4) — cheap to add alongside task-studio: no Kit/Tailwind components on this
  // surface yet, so its CSS list is the plain codicon/design-system/panel-specific triad.
  "task-detail": {
    bundle: "/dist/webview/task-detail.js",
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/task-detail.css"],
    frame: { w: 820, h: 760 },
    fixtures: taskDetailFixtures as Record<string, Fixture>,
    makeMessage: (vm) => taskMessage(vm as never),
  },
};

/** Converted webviews may opt out only with a written reason. Empty today: all converted surfaces are previewed. */
export const PREVIEW_ROUTE_OPTOUTS: Record<string, string> = {};

/** spec 281 — human label + alias match keys per view, for catalog-assisted RESOLUTION (the visual-qa skill
 *  matches a named surface deterministically against `view`/`title`/`aliases` before any semantic guess). */
export const VIEW_META: Record<string, { title: string; aliases: string[] }> = {
  sidebar: { title: "Tachyon Sidebar", aliases: ["sidebar", "fleet"] },
  plugins: { title: "Plugins", aliases: ["plugins", "plugin drawer", "marketplace"] },
  activity: { title: "Activity", aliases: ["activity", "agent activity", "chat", "transcript", "studio chat"] },
  probes: { title: "Probes", aliases: ["probes", "probe inspector"] },
  inspector: { title: "tmux Inspector", aliases: ["inspector", "server inspector", "tmux"] },
  "agent-studio": { title: "Agent Studio", aliases: ["agent studio", "new agent", "edit agent", "agent form"] },
  "pin-preview": { title: "Pin Preview", aliases: ["pin preview", "pin readonly"] },
  handoff: { title: "Project Handoff", aliases: ["handoff", "project handoff"] },
  "pin-studio": { title: "Pin Studio", aliases: ["pin studio", "pin editor", "sketch"] },
  "mission-control": { title: "Mission Control", aliases: ["mission control", "board", "task board"] },
  "task-studio": { title: "Task Studio", aliases: ["task studio", "task editor"] },
  "task-detail": { title: "Task Detail", aliases: ["task detail", "task tab"] },
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
