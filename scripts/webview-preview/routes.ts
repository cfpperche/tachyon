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
import { sidebarFixtures } from "./fixtures/sidebar";

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
  /** build the host→webview message that injects a fixture VM — via the view's SHARED envelope constructor. */
  makeMessage: (vm: VM) => unknown;
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
