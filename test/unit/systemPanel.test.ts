import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { buildSectionsModel, type SectionsModel, type WorkspaceBundle } from "@tachyon/webview-ui/sections/model";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { SYSTEM_VIEW_TYPE, SystemPanelManager } from "../../apps/vscode-extension/src/webview/SystemPanel.js";
import { readyMessage } from "../../packages/webview-ui/src/webview/system/messages.js";
import { summariseWorkspaceRows } from "../../packages/webview-ui/src/webview/system/summary.js";
import { buildControlInspectorModel, type ControlInspectorWorkspaceInput } from "@tachyon/webview-ui/control-inspector/model";

const wsInput = (over: Partial<ControlInspectorWorkspaceInput> & { wsHash: string }): ControlInspectorWorkspaceInput => ({
  folderName: over.wsHash,
  workspaceRoot: `/tmp/${over.wsHash}`,
  bridgeUrl: "http://127.0.0.1:7421/mcp",
  identity: {
    pid: 1,
    instanceId: "eng-1",
    processStartIdentity: "start-1",
    startedAt: "2026-08-09T00:00:00.000Z",
    bundleId: "bundle-1",
    engineVersion: "0.73.0",
    protocol: { min: 3, max: 3 },
    bridge: { instanceId: "br-1", port: 7421 },
  },
  ...over,
});

describe("SDD 500 — the System dashboard", () => {
  it("opens one immutable panel per project and reads each project", async () => {
    __resetVscodeMock();
    const needs: unknown[] = [];
    const manager = new SystemPanelManager(Uri.file("/ext"), {
      collect: async (n) => { needs.push(n); return []; },
      openDoctor: () => undefined,
      openSection: () => undefined,
      clearEngineLog: async () => undefined,
      openEngineJournal: () => undefined,
    });
    manager.open("project-a");
    manager.open("project-b");
    for (const panel of __createdPanels) panel.webview.__receive(readyMessage());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.openKeys).toEqual([`${SYSTEM_VIEW_TYPE}|project-a`, `${SYSTEM_VIEW_TYPE}|project-b`]);
    expect(needs).toHaveLength(2);
  });

  it("ships the stylesheet the standalone panel links", () => {
    const build = readFileSync("esbuild.mjs", "utf8");
    expect(build).toContain('copyFileSync("packages/webview-ui/src/webview/system/system.css", "dist/webview/system.css")');
  });

  it("leaves no Overview or Engine app behind — no host, no bundle dir, no sheet", () => {
    for (const file of [
      "packages/webview-ui/src/webview/OverviewPanel.ts",
      "packages/webview-ui/src/webview/EnginePanel.ts",
      "packages/webview-ui/src/webview/overview/App.tsx",
      "packages/webview-ui/src/webview/engine/App.tsx",
      "packages/webview-ui/src/webview/overview/overview.css",
    ]) {
      expect(() => readFileSync(file, "utf8"), `${file} still exists`).toThrow();
    }
  });
});

/**
 * SDD 500 § "a summary that cannot disagree with its rows" — the acceptance criterion the measurement
 * bought, and the only structural change of substance in this spec.
 *
 * The fail-before that matters is NOT "does the counter equal the sum". It is: hand the app a model
 * whose `control.summary` says one thing and whose `control.workspaces` says another, and see which one
 * reaches the screen. The old code read `control.summary.attachedEngines` and would print the stale
 * aggregate above cards that disagreed with it; there was no state on TWO screens where a human could
 * see that, and on one screen there is.
 */
describe("SDD 500 D3 — the summary is derived from the rows on screen", () => {
  it("ignores a control.summary that contradicts the rows", () => {
    const model = buildControlInspectorModel([
      wsInput({ wsHash: "a", agents: { total: 4, running: 3 } }),
      wsInput({ wsHash: "b", identity: null, identityError: "handshake failed", agents: { total: 2, running: 0 } }),
    ]);
    // A summary that has drifted from its own rows — the exact state the old read could not survive.
    const drifted = { ...model, summary: { workspaceCount: 99, attachedEngines: 99, engineErrors: 0, totalAgents: 99, runningAgents: 99 } };

    const derived = summariseWorkspaceRows(drifted.workspaces);
    expect(derived).toEqual({ workspaces: 2, enginesAttached: 1, enginesError: 1, agentsRunning: 3, agentsTotal: 6 });
    // and it is genuinely reading the rows, not the summary that sits beside them.
    expect(derived.enginesAttached).not.toBe(drifted.summary.attachedEngines);
  });

  it("a row with no agent counts contributes nothing rather than a zero it cannot vouch for", () => {
    const model = buildControlInspectorModel([wsInput({ wsHash: "a" }), wsInput({ wsHash: "b", agents: { total: 2, running: 1 } })]);
    expect(summariseWorkspaceRows(model.workspaces)).toMatchObject({ agentsRunning: 1, agentsTotal: 2 });
  });

  it("no rows is an honest zero across the board", () => {
    expect(summariseWorkspaceRows([])).toEqual({ workspaces: 0, enginesAttached: 0, enginesError: 0, agentsRunning: 0, agentsTotal: 0 });
  });

  /**
   * The guard the derivation alone cannot give, and it has to be a RENDER rather than a source scan.
   *
   * The first version of this checked that `App.tsx` contains no literal `control.summary`, and it was
   * blind by construction: injecting the real regression — reading `model.overview.enginesAttached`,
   * which `model.ts:529` sets FROM `control.summary.attachedEngines` — left it green. A guard whose
   * miss looks identical to a pass is worse than none, so this one drives the component and reads what
   * lands on screen, which is the only thing the acceptance criterion is actually about.
   */
  describe("the rendered screen answers from its rows even when the aggregate disagrees", () => {
    let App: (props: Record<string, unknown>) => unknown;
    beforeAll(async () => {
      App = (await loadWebviewModule("packages/webview-ui/src/webview/system/App.tsx")).App as typeof App;
    });

    /** a model with ONE attached workspace, whose `overview` block has been made to lie. */
    const lyingModel = (): SectionsModel => {
      const bundle: WorkspaceBundle = {
        control: wsInput({ wsHash: "a", agents: { total: 4, running: 3 } }),
        agents: [],
        approvals: [],
      };
      const real = buildSectionsModel([bundle], { nowIso: "2026-08-09T00:00:00.000Z" });
      return {
        ...real,
        // the aggregate half, drifted away from the rows it was computed from
        overview: { ...real.overview, enginesAttached: 99, enginesError: 42, agentsRunning: 77, agentsTotal: 88 },
      };
    };

    const strings = Object.fromEntries(
      ["systemTitle", "systemHint", "auto", "refresh", "copyDiagnostics", "openDoctor", "workspaces",
        "engines", "errors", "agents", "inbox", "worktrees", "empty", "attached", "error", "none",
        "state", "pid", "version", "instance", "started", "bundle", "protocol", "url", "port", "auth",
        "root", "hash", "running"].map((k) => [k, k]),
    ) as Record<string, string>;
    strings.workspacesInWindow = "of {0} in this window";

    const render = (model: SectionsModel): string =>
      renderStatic(App({ model, strings, auto: true, setAuto: () => undefined, post: () => undefined }));

    /**
     * The summary strip as `label -> value` pairs, read off the rendered markup.
     *
     * Read STRUCTURALLY and not as substrings, because the first attempt at that was wrong in a way
     * worth recording: `not.toContain("42")` went red on a perfectly correct render, because the bridge
     * port is 7421. A screen full of numbers cannot be asserted about with `toContain`.
     */
    const metrics = (html: string): Record<string, string> => {
      const strip = /<div class="ck-metrics">([\s\S]*?)<\/div><div class="ck-card-list">|<div class="ck-metrics">([\s\S]*)$/.exec(html);
      const body = strip?.[1] ?? strip?.[2] ?? "";
      const pairs = [...body.matchAll(/<(?:div|span) class="label">([^<]*)<\/(?:div|span)><(?:div|span) class="value">([^<]*)<\/(?:div|span)>/g)];
      return Object.fromEntries(pairs.map((m) => [m[1], m[2]]));
    };

    it("prints the rows' numbers, not the aggregate's", () => {
      const m = metrics(render(lyingModel()));
      // one attached engine, no errors, 3/4 agents — each read off the single card below, while the
      // `overview` block sitting in the same model claims 99 / 42 / 77 of 88.
      expect(m).toMatchObject({ workspaces: "1", engines: "1", errors: "0", agents: "3/4" });
    });

    it("the workspace-wide counts still come from the aggregate that owns them", () => {
      // The other half of D3: `inboxPending`/`worktreesActive` have no per-row source, so they are NOT
      // forced through the derivation for symmetry — a "consistent" zero would be a worse answer.
      const model = lyingModel();
      const m = metrics(render({ ...model, overview: { ...model.overview, inboxPending: 7, worktreesActive: 5 } }));
      expect(m).toMatchObject({ inbox: "7", worktrees: "5" });
    });

    it("the card it summarises is on the same screen", () => {
      const html = render(lyingModel());
      expect(html).toContain('class="ci-ws"');
      expect(html).toContain('<div class="name">a</div>');
    });
  });
});

/**
 * SDD 500 — the two counts that are NOT derivable from the rows, and the one that would otherwise lie.
 */
describe("SDD 500 — the workspace-wide counts keep their own sources", () => {
  it("inboxPending and worktreesActive still come from model.overview, and the Inbox counter navigates", () => {
    const app = readFileSync("packages/webview-ui/src/webview/system/App.tsx", "utf8");
    expect(app).toContain("overview.inboxPending");
    expect(app).toContain("overview.worktreesActive");
    expect(app).toContain('type: "openSection", section: "inbox"');
  });

  it("the window's workspace count is labelled with its scope instead of counted as rows", () => {
    // t-72ff5a keeps `overview.workspaceCount` unscoped on purpose ("the only number that says a second
    // project exists"), and this app draws ONE card. Printing it as the Workspaces value would be the
    // counter-contradicts-the-cards state spec.md forbids, so the value is the rows and the window's
    // count survives underneath, saying its own scope.
    const app = readFileSync("packages/webview-ui/src/webview/system/App.tsx", "utf8");
    expect(app).toContain("derived.workspaces");
    expect(app).toContain("workspacesInWindow");
    expect(app).toContain("window > derived.workspaces");
  });

  it("model.overview survives, because formatSectionsDiagnostics still reads it", () => {
    // Measured rather than assumed: the field is not dead just because the screen stopped reading it
    // whole. Deleting it would silently empty three lines of the diagnostics a human copies when
    // something is already wrong.
    const model = readFileSync("packages/webview-ui/src/sections/model.ts", "utf8");
    for (const line of ["model.overview.approvalsPending", "model.overview.inboxPending", "model.overview.worktreesActive"]) {
      expect(model, `formatSectionsDiagnostics lost ${line}`).toContain(line);
    }
  });
});

/**
 * SDD 500 § Acceptance — "the actions both pages carried are all reachable, or their removal is a
 * recorded decision rather than an omission". All four survived, so this is the cheap version: the
 * union, checked, not remembered.
 */
describe("SDD 500 — every action both pages carried is on the merged screen", () => {
  it("auto-refresh, refresh, copy diagnostics and open doctor are all posted from System", () => {
    const app = readFileSync("packages/webview-ui/src/webview/system/App.tsx", "utf8");
    expect(app).toContain("setAuto");
    expect(app).toContain("type: POLL");
    expect(app).toContain('type: "copyDiagnostics"');
    expect(app).toContain('type: "openDoctor"');
  });

  it("and the host answers every one of them", () => {
    const host = readFileSync("apps/vscode-extension/src/webview/SystemPanel.ts", "utf8");
    for (const action of ["openDoctor", "openSection", "copyText", "engineLogJournal", "engineLogClear", "copyDiagnostics"]) {
      expect(host, `SystemPanel has no arm for ${action}`).toContain(`m.type === "${action}"`);
    }
  });
});
