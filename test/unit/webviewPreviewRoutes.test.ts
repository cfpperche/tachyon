import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
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
      "/dist/webview/human-inbox.css",
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
      "empty",
      "engine",
      // SDD 480 Phase 4 — the heavy/grouped surface plus each explicit state, which is what the
      // headless Visual QA at 760/1000/1400 drives.
      "execution-graph",
      "execution-graph-empty",
      "execution-graph-error",
      "execution-graph-no-telemetry",
      "execution-graph-real",
      "fleet",
      "handoff",
      // t-d16698 — the Human Inbox list and ONE opened item: the two surfaces every "Review"
      // doorbell can land on, and the deep-link destination this task is about.
      "inbox",
      "inbox-item",
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
      // t-fb216a — same Plugins section, but the route pushes the runtime-coverage-gap plugins VM.
      "plugins-runtime-gap",
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
      // t-e722ce — the Forget plan panel, in both of its shapes. Addressable without driving a click
      // (the plan arrives as a second host message), so it can be reviewed like any other surface.
      "studio-agent-forget-plan",
      "studio-agent-forget-plan-blocked",
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
      // t-5564b4 — the content shapes the Task Detail report is about; the single `task-detail`
      // fixture had no long refs, no attention and no long body, so the catalog could not show it.
      "task-detail-heavy",
      "task-detail-sparse",
      "task-detail-tombstone",
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

// t-fdfbd4 — THE PORTABLE PREVIEW-REFERENCE GUARD (recommendation measured in t-c55f8d, 2026-08-01).
//
// `test:browser` needs a system Chrome and ~96s, so `verify:full` does not run it, and for months nothing
// else did: t-c55f8d found 17 failures on main of which SIXTEEN were one defect repeated — a test opening
// `?view=plugins` / `?view=runtime-ops` / `dist/webview/task-studio.js` / `dist/webview/mission-control.js`
// after the product folded every one of those standalone entry points into the Control bundle. Not one of
// them needed a browser to be caught; they were strings pointing at doors that no longer exist.
//
// So the cheap half of that suite moves HERE, where it costs milliseconds and needs no Chrome: a browser
// test may only name a view the harness can resolve and a bundle the build actually emits. The expensive
// half — the 17th failure, a 2px `.ds-btn` line-height mismatch (t-b8b85c) — still needs real pixels, and
// `test:browser` stays a PRE-RELEASE gate for it (README, "Development"). Deliberately NOT added to
// verify:full: a suite nobody sustains does not stop rotting by being put in a gate, it just moves the rot
// inside the gate, where it turns into pressure to skip.
describe("preview references in the browser suite (t-fdfbd4)", () => {
  // Import shape matches packageCleanGate/webviewChunkHygiene's tests: dynamic import of the ESM .mjs
  // helper, since this tsconfig emits CommonJS.
  let blankComments: (src: string) => string;
  let callerFiles: (roots?: string[]) => string[];
  let declaredWebviewBundles: (esbuildSource?: string) => Set<string>;
  let scanPreviewReferences: (options?: { routeKeys?: Set<string>; bundles?: Set<string>; files?: string[] }) => {
    dead: string[];
    stale: string[];
    knownViews: string[];
    knownBundles: string[];
  };
  let files: string[];
  let bundles: Set<string>;
  const routeKeys = new Set(Object.keys(ROUTES));

  beforeAll(async () => {
    ({ blankComments, callerFiles, declaredWebviewBundles, scanPreviewReferences } =
      await import("../../scripts/webview-preview/reference-scan.mjs"));
    files = callerFiles();
    bundles = declaredWebviewBundles();
  });

  it("scans every file that opens a preview route or loads a webview bundle", () => {
    // test/browser is not the only caller: scripts/visual-qa/*.mjs drive the same harness by URL. Both
    // roots are walked, so a dead route in either is caught by the same rule.
    expect(files).toContain("test/browser/runtimeOpsView.test.ts");
    expect(files).toContain("scripts/visual-qa/task-detail-overflow.mjs");
    expect(files.length).toBeGreaterThan(15);
  });

  it("derives the live bundle set from esbuild.mjs, including the code-split cockpit target", () => {
    // A canary on the derivation, not a second copy of the list: `outfile:` alone would miss cockpit.js
    // (emitted via outdir + entryNames, with the inherited outfile deleted) and would then reject every
    // test t-c55f8d repointed AT cockpit — a false positive that would get this guard deleted in a week.
    expect(bundles.has("dist/webview/cockpit.js")).toBe(true);
    expect(bundles.has("dist/webview/sidebar.js")).toBe(true);
    // and the retired ones are genuinely absent, which is the whole premise.
    expect(bundles.has("dist/webview/mission-control.js")).toBe(false);
    expect(bundles.has("dist/webview/task-studio.js")).toBe(false);
  });

  it("every ?view= and dist/webview/*.js reference resolves against ROUTES and esbuild.mjs", () => {
    const { dead } = scanPreviewReferences({ routeKeys, bundles, files });
    expect(dead, `\n${dead.join("\n\n")}\n`).toEqual([]);
  });

  it("no waiver outlives the reference it excuses", () => {
    const { stale } = scanPreviewReferences({ routeKeys, bundles, files });
    expect(stale, `\n${stale.join("\n\n")}\n`).toEqual([]);
  });

  it("the comment blanker agrees with esbuild's own tokenizer on every scanned file", () => {
    // The scan reads CODE only — the tests repointed in t-c55f8d explain the retired route in prose right
    // above the live URL, so a scan that read comments would report the files that were already fixed.
    // Hand-rolled lexing is the risk that buys that precision (an odd quote inside a regex literal would
    // desync it), so the standing proof is a differential: the same tokens must fall out of esbuild's
    // transform, which is the tokenizer this repo actually builds with.
    const tokens = (text: string): string[] =>
      [...text.matchAll(/[?&]view=[A-Za-z0-9_-]+|dist\/webview\/[A-Za-z0-9_.-]+\.js/g)].map((m) => m[0]).sort();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const loader = /\.tsx?$/.test(file) ? ("ts" as const) : ("js" as const);
      const viaEsbuild = tokens(transformSync(source, { loader }).code);
      expect(tokens(blankComments(source)), `${file}: comment blanker disagrees with esbuild`).toEqual(viaEsbuild);
    }
  });
});
