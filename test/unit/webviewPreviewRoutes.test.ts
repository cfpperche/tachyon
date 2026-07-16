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
    expect(m).toEqual({ type: "fleet", fleets: [SAMPLE], prefs: { agents: "name-asc" }, collapsedKeys: [] });
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
    expect(r.cssLinks).toEqual(["/dist/webview/codicon.css", "/dist/webview/design-system.css", "/dist/webview/vscode-theme.css", "/dist/webview/plugins.tailwind.css", "/dist/webview/plugins.css"]);
    expect(r.frame).toEqual({ w: 900, h: 760 });
    // its makeMessage uses the plugins envelope (a different contract than the sidebar's fleet push).
    const msg = r.makeMessage(r.fixtures.default.vm) as { type: string };
    expect(msg.type).toBe("plugins");
  });

  it("declares the activity route with its own envelope + ordered CSS", () => {
    const r = ROUTES.activity;
    expect(r.bundle).toBe("/dist/webview/activity.js");
    expect(r.cssLinks).toEqual(["/dist/webview/codicon.css", "/dist/webview/design-system.css", "/dist/webview/mermaid-block.css", "/dist/webview/activity.css"]);
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

  it("declares the control-inspector route (Engine/Bridge POC) with init + model", () => {
    const r = ROUTES["control-inspector"];
    expect(r.bundle).toBe("/dist/webview/control-inspector.js");
    expect(r.cssLinks).toEqual([
      "/dist/webview/codicon.css",
      "/dist/webview/design-system.css",
      "/dist/webview/control-inspector.css",
    ]);
    expect(Object.keys(r.fixtures).sort()).toEqual(["default", "empty", "healthy"]);
    const msgs = r.makeMessage(r.fixtures.default.vm) as Array<{ type: string }>;
    expect(msgs.map((m) => m.type)).toEqual(["init", "model"]);
  });

  it("declares the cockpit route (desktop sysadmin POC) with init + model", () => {
    const r = ROUTES.cockpit;
    expect(r.bundle).toBe("/dist/webview/cockpit.js");
    expect(r.cssLinks).toEqual([
      "/dist/webview/codicon.css",
      "/dist/webview/design-system.css",
      "/dist/webview/cockpit.css",
    ]);
    expect(Object.keys(r.fixtures).sort()).toEqual(["default", "empty", "engine"]);
    const msgs = r.makeMessage(r.fixtures.default.vm) as Array<{ type: string; model?: { framing?: string } }>;
    expect(msgs.map((m) => m.type)).toEqual(["init", "model"]);
    expect(msgs[1]?.model?.framing).toBe("editor-sysadmin");
  });

  it("declares the handoff route (spec 280) with its envelope + default/cold/stale fixtures", () => {
    const r = ROUTES.handoff;
    expect(r.bundle).toBe("/dist/webview/handoff.js");
    expect(r.cssLinks).toEqual(["/dist/webview/codicon.css", "/dist/webview/design-system.css", "/dist/webview/mermaid-block.css", "/dist/webview/handoff.css"]);
    expect(Object.keys(r.fixtures).sort()).toEqual(["cold", "default", "distill-list", "stale"]);
    expect((r.makeMessage(r.fixtures.default.vm) as { type: string }).type).toBe("handoff");
  });

  it("declares the pin-studio route (spec 278 — the last view onboarded) with its envelope", () => {
    const r = ROUTES["pin-studio"];
    expect(r.bundle).toBe("/dist/webview/pin-studio.js");
    expect(r.cssLinks).toEqual(["/dist/webview/codicon.css", "/dist/webview/design-system.css", "/dist/webview/rich-doc.css", "/dist/webview/studio-frame.css", "/dist/webview/pin-studio.css"]);
    expect(Object.keys(r.fixtures).sort()).toEqual(["default", "new"]);
    expect((r.makeMessage(r.fixtures.default.vm) as { type: string }).type).toBe("load");
  });

  it("declares the task-studio route (spec 342 dogfood round 2 #4, migrated onto the studio shell by spec 350 T3) with its envelope + ordered CSS", () => {
    const r = ROUTES["task-studio"];
    expect(r.bundle).toBe("/dist/webview/task-studio.js");
    expect(r.cssLinks).toEqual([
      "/dist/webview/codicon.css",
      "/dist/webview/design-system.css",
      "/dist/webview/vscode-theme.css",
      "/dist/webview/task-studio.tailwind.css",
      "/dist/webview/rich-doc.css",
      "/dist/webview/studio-frame.css",
      "/dist/webview/task-studio.css",
    ]);
    expect(Object.keys(r.fixtures).sort()).toEqual(["conflict", "default", "new"]);
    const messages = r.makeMessage(r.fixtures.default.vm) as { type: string }[];
    expect(messages[0]!.type).toBe("load");
  });

  it("declares Agent Studio with the UI Kit token bridge and Tailwind utilities before surface CSS", () => {
    const r = ROUTES["agent-studio-shell"];
    expect(r.cssLinks).toEqual([
      "/dist/webview/codicon.css",
      "/dist/webview/design-system.css",
      "/dist/webview/vscode-theme.css",
      "/dist/webview/agent-studio-shell.tailwind.css",
      "/dist/webview/studio-frame.css",
      "/dist/webview/agent-studio-shell.css",
    ]);
  });

  it("declares the mission-control route with its snapshot envelope + ordered CSS", () => {
    const r = ROUTES["mission-control"];
    expect(r.bundle).toBe("/dist/webview/mission-control.js");
    expect(r.cssLinks).toEqual(["/dist/webview/codicon.css", "/dist/webview/design-system.css", "/dist/webview/vscode-theme.css", "/dist/webview/mission-control.tailwind.css", "/dist/webview/mission-control.css"]);
    expect(r.frame).toEqual({ w: 1280, h: 760 });
    expect(Object.keys(r.fixtures).sort()).toEqual(["default"]);
    const msg = r.makeMessage(r.fixtures.default.vm) as { type: string; vm?: unknown };
    expect(msg.type).toBe("snapshot");
    expect(msg.vm).toBe(r.fixtures.default.vm);
  });

  it("declares the Runtime Ops panel with typed state fixtures", () => {
    const route = ROUTES["runtime-ops"];
    expect(route.bundle).toBe("/dist/webview/runtime-ops.js");
    expect(route.cssLinks).toEqual(["/dist/webview/design-system.css", "/dist/webview/runtime-ops.css"]);
    expect(Object.keys(route.fixtures).sort()).toEqual([
      "default",
      "duplicate-workspace",
      "empty",
      "error",
      "loading",
      "long-label",
      "mixed",
      "provider-disabled",
      "provider-exhausted",
      "provider-healthy",
      "provider-invalid",
      "provider-partial",
      "provider-stale",
      "provider-timeout",
      "provider-unauthenticated",
      "stale-bridge",
      "throttled",
    ]);
    expect((route.makeMessage(route.fixtures.default.vm) as { type: string }).type).toBe("runtimeOpsSnapshot");
    expect((route.makeMessage(route.fixtures.loading.vm) as { type: string }).type).toBe("runtimeOpsLoading");
  });

  it("declares the task-detail route (spec 342 dogfood round 2 #4) with its envelope + ordered CSS", () => {
    const r = ROUTES["task-detail"];
    expect(r.bundle).toBe("/dist/webview/task-detail.js");
    expect(r.cssLinks).toEqual(["/dist/webview/codicon.css", "/dist/webview/design-system.css", "/dist/webview/mermaid-block.css", "/dist/webview/task-detail.css"]);
    expect((r.makeMessage(r.fixtures.default.vm) as { type: string }).type).toBe("task");
  });

  it("declares the pin-preview route (spec 279) with a hostile fixture carrying injection payloads", () => {
    const r = ROUTES["pin-preview"];
    expect(r.bundle).toBe("/dist/webview/pin-preview.js");
    expect((r.makeMessage(r.fixtures.default.vm) as { type: string }).type).toBe("pinPreview");
    // the hostile fixture MUST carry script/onerror payloads so the harness exercises preact's escaping
    // (proven inert by the live render — preact renders them as text, never DOM).
    const hostile = r.fixtures.hostile.vm as { title: string; body: string };
    expect(hostile.title).toMatch(/onerror=/);
    expect(hostile.body).toMatch(/<script>/);
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
