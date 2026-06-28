import { describe, it, expect } from "vitest";
import { FLEET, READY, fleetMessage, readyMessage } from "../../src/webview/sidebar/messages.js";
import { ROUTES, buildCatalog } from "../../scripts/webview-preview/routes.js";
import { SAMPLE } from "../../src/sidebar/types.js";

// spec 278 — Lane A: the shared envelope + the route table + the generated catalog. These are the pure,
// CI-coverable core of the preview harness (the DOM glue in preview.ts is integration). The drift guard
// itself (a constructor misuse → a typecheck error) is enforced by `tsc -p tsconfig.webview.json`, which
// now includes scripts/webview-preview/**; this suite covers the runtime shapes.

describe("sidebar message envelope", () => {
  it("fleetMessage builds the shared {type:'fleet'} envelope", () => {
    const m = fleetMessage([SAMPLE], { agents: "name-asc" });
    expect(m).toEqual({ type: "fleet", fleets: [SAMPLE], prefs: { agents: "name-asc" } });
    expect(FLEET).toBe("fleet");
  });

  it("readyMessage builds the shared {type:'ready'} handshake", () => {
    expect(readyMessage()).toEqual({ type: "ready" });
    expect(READY).toBe("ready");
  });
});

describe("preview route table", () => {
  it("declares the sidebar route with its real bundle + ordered CSS + frame", () => {
    const r = ROUTES.sidebar;
    expect(r.bundle).toBe("/dist/webview/sidebar.js");
    // CSS order is the contract the real panel links: codicon → design-system → panel-specific.
    expect(r.cssLinks).toEqual(["/dist/webview/codicon.css", "/dist/webview/design-system.css", "/dist/webview/sidebar.css"]);
    expect(r.frame).toEqual({ w: 340, h: 760 });
  });

  it("makeMessage wraps a FleetVM via the shared constructor (one-fleet push)", () => {
    const msg = ROUTES.sidebar.makeMessage(SAMPLE) as ReturnType<typeof fleetMessage>;
    expect(msg.type).toBe("fleet");
    expect(msg.fleets).toEqual([SAMPLE]);
  });

  it("declares the plugins route with its bundle + ordered CSS + a wider frame", () => {
    const r = ROUTES.plugins;
    expect(r.bundle).toBe("/dist/webview/plugins.js");
    expect(r.cssLinks).toEqual(["/dist/webview/codicon.css", "/dist/webview/design-system.css", "/dist/webview/plugins.css"]);
    expect(r.frame).toEqual({ w: 900, h: 760 });
    // its makeMessage uses the plugins envelope (a different contract than the sidebar's fleet push).
    const msg = r.makeMessage(r.fixtures.default.vm) as { type: string };
    expect(msg.type).toBe("plugins");
  });

  it("declares the activity route with its own envelope + ordered CSS", () => {
    const r = ROUTES.activity;
    expect(r.bundle).toBe("/dist/webview/activity.js");
    expect(r.cssLinks).toEqual(["/dist/webview/codicon.css", "/dist/webview/design-system.css", "/dist/webview/activity.css"]);
    const msg = r.makeMessage(r.fixtures.default.vm) as { type: string; prepended: boolean };
    expect(msg.type).toBe("activity");
    expect(msg.prepended).toBe(false);
  });

  it("declares the probes route (spec 279 conversion) with its envelope + data/empty/error fixtures", () => {
    const r = ROUTES.probes;
    expect(r.bundle).toBe("/dist/webview/probes.js");
    expect(r.cssLinks).toEqual(["/dist/webview/design-system.css", "/dist/webview/probes.css"]);
    expect(Object.keys(r.fixtures).sort()).toEqual(["default", "empty", "error"]);
    expect((r.makeMessage(r.fixtures.default.vm) as { type: string }).type).toBe("probes");
  });

  it("declares the inspector route (spec 279) injecting BOTH init + model messages", () => {
    const r = ROUTES.inspector;
    expect(r.bundle).toBe("/dist/webview/inspector.js");
    const msgs = r.makeMessage(r.fixtures.default.vm) as Array<{ type: string }>;
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs.map((m) => m.type)).toEqual(["init", "model"]);
  });

  it("every fixture carries a provenance label; the canonical default is sample-derived", () => {
    const fx = ROUTES.sidebar.fixtures;
    expect(Object.keys(fx)).toContain("default");
    expect(fx.default.provenance).toBe("sample-derived");
    expect(fx.default.vm).toBe(SAMPLE);
    for (const [name, f] of Object.entries(fx)) {
      expect(f.provenance, `fixture ${name} must label its provenance`).toBeTruthy();
    }
  });
});

describe("generated route catalog", () => {
  it("emits one entry per (view × fixture) with a view+fixture URL", () => {
    const cat = buildCatalog();
    const expected = Object.entries(ROUTES).reduce((n, [, r]) => n + Object.keys(r.fixtures).length, 0);
    expect(cat).toHaveLength(expected);
    const def = cat.find((e) => e.view === "sidebar" && e.fixture === "default");
    expect(def?.url).toBe("/scripts/webview-preview/index.html?view=sidebar&fixture=default");
    expect(def?.frame).toEqual({ w: 340, h: 760 });
    expect(def?.tags).toContain("sample-derived");
  });
});
