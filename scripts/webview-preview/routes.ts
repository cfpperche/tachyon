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
import { sidebarFixtures } from "./fixtures/sidebar";
import { pluginsFixtures } from "./fixtures/plugins";
import { activityFixtures } from "./fixtures/activity";
import { probesFixtures } from "./fixtures/probes";
import { inspectorFixtures, strings as inspectorStrings } from "./fixtures/inspector";
import { agentStudioFixtures } from "./fixtures/agent-studio";
import { pinPreviewFixtures } from "./fixtures/pin-preview";

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
    cssLinks: [CODICON, DESIGN_SYSTEM, "/dist/webview/plugins.css"],
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
};

/** the machine-readable route catalog (spec 278 design #5) — generated from ROUTES, consumed by passo 2. */
export interface CatalogEntry {
  view: string;
  fixture: string;
  url: string;
  frame: { w: number; h: number };
  tags: string[];
}

/** Generate the flat catalog: one entry per (view × fixture). `base` is the harness index URL. */
export function buildCatalog(base = "/scripts/webview-preview/index.html"): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const [view, route] of Object.entries(ROUTES)) {
    for (const [fixture, fx] of Object.entries(route.fixtures)) {
      out.push({ view, fixture, url: `${base}?view=${view}&fixture=${fixture}`, frame: route.frame, tags: [fx.provenance] });
    }
  }
  return out;
}
