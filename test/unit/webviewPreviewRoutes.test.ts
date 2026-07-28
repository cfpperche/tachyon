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

  it("declares the cockpit route (Control monolith embeds + CSS) with init + model", () => {
    const r = ROUTES.cockpit;
    expect(r.bundle).toBe("/dist/webview/cockpit.js");
    expect(r.cssLinks).toEqual([
      "/dist/webview/codicon.css",
      "/dist/webview/design-system.css",
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
    ]);
    expect(Object.keys(r.fixtures).sort()).toEqual([
      "agent-activity",
      "agent-probes",
      "approvals",
      "default",
      "deliveries",
      "empty",
      "engine",
      "fleet",
      "handoff",
      "mission",
      "multi-workspace",
      // t-46eb4f — Overview with two roots attached: the one global scope selector, with its
      // "All workspaces" option (the single-root case is `default`, where it still renders).
      "multi-workspace-overview",
      "multi-workspace-scoped",
      // t-ac79a7 — the navigation-pending state: the Board still on screen while the task-detail
      // route it just committed is loading (the fixture pushes routePending, never routeReady).
      "nav-pending",
      "plugins",
      "runtime",
      "runtime-config",
      "settings",
      "studio-agent",
      "studio-agent-canonical",
      "studio-agent-claude-bypass-off",
      "studio-agent-claude-bypass-on",
      "studio-agent-codex-danger-off",
      "studio-agent-codex-danger-on",
      "studio-agent-edit",
      "studio-command",
      "studio-command-edit",
      "studio-pin-edit",
      "studio-pin-new",
      "studio-runbook",
      "studio-runbook-edit",
      "studio-schedule",
      "studio-schedule-edit",
      "studio-task-edit",
      "studio-terminal",
      "studio-terminal-edit",
      "task-detail",
      "tmux",
      "validations",
      "worktrees",
    ]);
    const msgs = r.makeMessage(r.fixtures.default.vm) as Array<{ type: string; model?: { section?: string } }>;
    expect(msgs.map((m) => m.type)).toEqual(["init", "model"]);
    expect(msgs[1]?.model?.section).toBe("overview");
    const missionMsgs = r.makeMessage(r.fixtures.mission.vm) as Array<{ type: string }>;
    expect(missionMsgs.map((m) => m.type)).toEqual(["init", "model", "snapshot"]);
    // t-610705 (Phase C.1) — the task-detail subroute fixture rides alongside its parent
    // section's push (activeRoute carries the entity locator; section stays "mission").
    const taskDetailMsgs = r.makeMessage(r.fixtures["task-detail"]!.vm) as Array<{ type: string }>;
    expect(taskDetailMsgs.map((m) => m.type)).toEqual(["init", "model", "snapshot", "task"]);
    // t-610705 (Phase C.2) — the Fleet subroute fixtures: nav section is "fleet" (no embed push of
    // its own), so only the subroute's own content message rides alongside init+model.
    const activityMsgs = r.makeMessage(r.fixtures["agent-activity"]!.vm) as Array<{ type: string }>;
    expect(activityMsgs.map((m) => m.type)).toEqual(["init", "model", "activity"]);
    const probesMsgs = r.makeMessage(r.fixtures["agent-probes"]!.vm) as Array<{ type: string }>;
    expect(probesMsgs.map((m) => m.type)).toEqual(["init", "model", "probes"]);
    const validationsMsgs = r.makeMessage(r.fixtures.validations.vm) as Array<{ type: string }>;
    expect(validationsMsgs.map((m) => m.type)).toEqual(["init", "model", "validations"]);
    const approvalMsgs = r.makeMessage(r.fixtures.approvals.vm) as Array<{ type: string }>;
    expect(approvalMsgs.map((m) => m.type)).toEqual(["init", "model", "approvals"]);
    const runtimeMsgs = r.makeMessage(r.fixtures.runtime.vm) as Array<{ type: string }>;
    expect(runtimeMsgs.map((m) => m.type)).toEqual(["init", "model", "runtimeOpsSnapshot"]);
    const tmuxMsgs = r.makeMessage(r.fixtures.tmux.vm) as Array<{ type: string }>;
    expect(tmuxMsgs.map((m) => m.type)).toEqual(["init", "model", "inspectorInit", "inspectorModel"]);
    const pluginsMsgs = r.makeMessage(r.fixtures.plugins.vm) as Array<{ type: string }>;
    expect(pluginsMsgs.map((m) => m.type)).toEqual(["init", "model", "plugins"]);
    // t-610705 (Phase C.3) — Handoff folds into a section (unlike Fleet's subroutes): nav section is
    // "handoff" itself, so its own content message rides alongside init+model directly.
    const handoffMsgs = r.makeMessage(r.fixtures.handoff.vm) as Array<{ type: string }>;
    expect(handoffMsgs.map((m) => m.type)).toEqual(["init", "model", "handoff"]);
    // t-610705 (Phase D, D0) — the pilot studio route: same "rides alongside its parent section's
    // push" pattern as the Fleet subroutes above (nav section is "fleet"), envelope-carrying so no
    // bare `type` field — asserted via studioProtocolVersion presence instead.
    const studioMsgs = r.makeMessage(r.fixtures["studio-command"]!.vm) as Array<{ type: string; studioProtocolVersion?: number }>;
    expect(studioMsgs.map((m) => m.type)).toEqual(["init", "model", "load"]);
    expect(studioMsgs[2]?.studioProtocolVersion).toBe(1);
    // t-610705 (Phase D, D1a) — the same studio branch, generalized by StudioId (routes.ts's
    // `byStudio` lookup) rather than hardcoded to "command" — one more StudioId is enough to prove
    // the lookup, not the loop.
    const terminalMsgs = r.makeMessage(r.fixtures["studio-terminal-edit"]!.vm) as Array<{ type: string; studioProtocolVersion?: number }>;
    expect(terminalMsgs.map((m) => m.type)).toEqual(["init", "model", "load"]);
    expect(terminalMsgs[2]?.studioProtocolVersion).toBe(1);
    // t-610705 (Phase D, D2) — task's fixtures module reuses "dense-edit" via the SAME byStudio
    // lookup (routes.ts) — no separate "studio-task" new-session fixture (task is edit-only). Nav
    // section is "mission" (not "fleet" like the other 5 studios), so the mission board's own
    // "snapshot" push rides alongside "load" too — same dual-push shape as the task-detail fixture
    // above (both are subroutes of the "mission" section).
    const taskMsgs = r.makeMessage(r.fixtures["studio-task-edit"]!.vm) as Array<{ type: string; studioProtocolVersion?: number }>;
    expect(taskMsgs.map((m) => m.type)).toEqual(["init", "model", "snapshot", "load"]);
    expect(taskMsgs[3]?.studioProtocolVersion).toBe(1);
    // t-610705 (Phase D, D3) — pin's fixtures module reuses "dense-edit"/"new" via the SAME byStudio
    // lookup. Nav section is null (nav-less — route.ts), so the fixture's own `section` is "overview"
    // (the same fallback Cockpit.ts's real host uses) — "overview" rides no embed push of its own, so
    // only "load" rides alongside init+model, same shape as the Fleet-parented studios (command et
    // al.), not the dual-push "mission" shape task-detail/studio-task-edit have above.
    const pinMsgs = r.makeMessage(r.fixtures["studio-pin-edit"]!.vm) as Array<{ type: string; studioProtocolVersion?: number }>;
    expect(pinMsgs.map((m) => m.type)).toEqual(["init", "model", "load"]);
    expect(pinMsgs[2]?.studioProtocolVersion).toBe(1);
    const pinNewMsgs = r.makeMessage(r.fixtures["studio-pin-new"]!.vm) as Array<{ type: string; studioProtocolVersion?: number }>;
    expect(pinNewMsgs.map((m) => m.type)).toEqual(["init", "model", "load"]);
    expect(pinNewMsgs[2]?.studioProtocolVersion).toBe(1);
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
