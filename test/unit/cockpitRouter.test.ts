import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { __createdPanels, __resetVscodeMock, __getExecutedCommands } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import { openCockpit, type CockpitMissionBoard } from "../../src/webview/Cockpit.js";
import { legacyMissionControlTarget, type WorkspaceMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import { makeFakeCockpitDeps } from "../mocks/cockpitDeps.js";
import { isCockpitSingletonClaimed, markCockpitSingletonClaimed, clearCockpitSingletonClaim } from "../../src/webview/cockpitSingleton.js";
import { ApprovalPanelManager } from "../../src/webview/ApprovalPanel.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

/**
 * t-610705 (SDD 410 Phase C.0) — the router infrastructure's own behaviors: navigation-epoch
 * staleness discard, schemaVersion 2 persistence, and revive precedence between the Cockpit's own
 * trusted revival and every legacy panel's dispose+redirect shim. These are exactly the mechanisms
 * the router design dueto (probe-840f7a80) found missing.
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-router-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  __resetVscodeMock();
  clearCockpitSingletonClaim();
});
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  clearCockpitSingletonClaim();
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function fakeWorkspace(root = mkroot(), opts: { hash?: string } = {}) {
  return {
    wsHash: opts.hash ?? "ws-1",
    folderName: "Project",
    workspaceRoot: root,
    taskStore: new TaskStore(root),
    validationStore: new ValidationStore(root),
    config: { agents: {} },
    manager: { list: async () => [] },
  } as unknown as Workspace;
}

const target = (workspace: Workspace): WorkspaceMissionControlTarget => legacyMissionControlTarget(workspace);

function boardOf(targets: WorkspaceMissionControlTarget[]): CockpitMissionBoard {
  return {
    getWorkspaces: () => targets,
    openTaskStudio: () => {},
    onTasksChanged: () => {},
  };
}

/**
 * handleValidationsAction resolves a workspace via `deps.validations.getWorkspaces()` for EVERY
 * inbound message, not just validations ones — an empty list makes it swallow "ready"/"setSection"/
 * "switchControlWorkspace" too (resolveMissionWs returns undefined -> `if (!ws) return true`).
 * makeFakeCockpitDeps' bare default is `getWorkspaces: () => []`, which trips this for any test
 * that (correctly) drives the router through real client messages instead of only
 * MissionControlAction types (which short-circuit before handleValidationsAction ever runs). Route
 * tests need a deps builder whose validations list mirrors the board's, so router-level messages
 * reach the actual switch. Not a router bug — filed separately as t-3990c3.
 */
function depsFor(
  targets: WorkspaceMissionControlTarget[],
  overrides: Partial<ReturnType<typeof makeFakeCockpitDeps>> = {},
): ReturnType<typeof makeFakeCockpitDeps> {
  return makeFakeCockpitDeps(boardOf(targets), {
    validations: { getWorkspaces: () => targets, onValidationsChanged: () => {} },
    ...overrides,
  });
}

/**
 * An ASYNC, injectable await on the navigation path, so an in-flight response can be held open across a
 * navigation. It is `deps.collect()` inside `sendModel`, which captures `navEpoch` before awaiting it and
 * checks it after, exactly like every other sender.
 *
 * **This is the vehicle's THIRD home, and the third move is the one that says something.** C5 moved these
 * cases off the Board's `listMissionControlAgents()` when the Board became an app; D3 moves them off
 * Runtime Ops' `buildSnapshot()` for the same reason — and this time there was nowhere else in the
 * sections to go. After D3, **no section module Control still renders awaits anything injectable**:
 * `sendApprovals`, `sendValidations`, `sendInbox` and `sendRuntimeConfig` are all `async` functions with
 * no `await` in their bodies, so their epoch check can never observe a difference. Every remaining
 * wedgeable await belongs to a detail ROUTE (handoff, probes) whose workspace comes from the route's own
 * immutable locator — which makes the scope-switch case below unstateable against them.
 *
 * `deps.collect` is chosen because it cannot be migrated away by the next Phase D section leaving: it is
 * the ONE await every navigation and every scope switch makes, for as long as Control renders anything at
 * all. The mechanism under test (one `navEpoch`, captured before the await, checked after) is Control-wide
 * and unchanged; its per-panel equivalent for the apps is the `PanelWorkGate`.
 *
 * `wedgeFirstCollect` wedges only the FIRST call and answers every later one instantly, which is what lets
 * each case assert the sharp property: exactly ONE model lands, the CURRENT one. Asserting only "the stale
 * one was not posted" would pass just as readily against a door that posts nothing at all — the weakness
 * `boardPanel.test.ts`'s poll case was strengthened for.
 */
function wedgeFirstCollect(targets: WorkspaceMissionControlTarget[]) {
  const pending = deferred<never>();
  let calls = 0;
  const deps = depsFor(targets, {
    collect: (() => {
      calls += 1;
      return calls === 1 ? pending.promise : Promise.resolve([]);
    }) as never,
  });
  return { deps, releaseWedged: () => pending.resolve([] as never) };
}

/** every `model` push the panel has received, newest last. */
const modelsPosted = () => snapshotsOf("model") as Array<{ model?: { section?: string } }>;

const snapshotsOf = (type: string) =>
  __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === type);

describe("navigation epoch — discards stale responses from a superseded route", () => {
  it("a slow section response that resolves AFTER navigating away is never posted", async () => {
    const ws = fakeWorkspace();
    const { deps, releaseWedged } = wedgeFirstCollect([target(ws)]);

    await openCockpit(deps, { section: "fleet", wsHash: ws.wsHash });
    // "ready" is the real client's first message — triggers sendModel, so its collect() is now
    // in-flight and wedged.
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    expect(modelsPosted()).toHaveLength(0);

    // navigate away before the slow collect() resolves. This send's own collect answers instantly,
    // so the CURRENT route's model lands while the stale one is still wedged.
    __createdPanels[0].webview.__receive({ type: "setSection", section: "overview" });
    await flush();
    expect(modelsPosted()).toHaveLength(1);
    expect(modelsPosted()[0].model?.section).toBe("validations");

    releaseWedged();
    await flush();
    await flush();
    // the wedged call finally resolves, but the epoch it captured is stale — it adds nothing, and in
    // particular does not repaint Control as "fleet" underneath the route the human is now on.
    expect(modelsPosted()).toHaveLength(1);
    expect(modelsPosted()[0].model?.section).toBe("validations");
  });

  it("the global scope survives navigation between screens (t-46eb4f)", async () => {
    // One selector, in Overview; every screen after it reads the same scope.
    const wsA = fakeWorkspace(mkroot(), { hash: "ws-a" });
    const wsB = fakeWorkspace(mkroot(), { hash: "ws-b" });
    await wsB.validationStore.create({ title: "beta check", author: "human" });
    const deps = depsFor([target(wsA), target(wsB)]);

    await openCockpit(deps, { section: "overview", wsHash: "ws-a" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    __createdPanels[0].webview.__receive({ type: "switchControlWorkspace", wsHash: "ws-b" });
    await flush();
    __createdPanels[0].webview.__receive({ type: "setSection", section: "validations" });
    await flush();

    const validations = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "validations");
    expect(validations.at(-1)).toMatchObject({ vm: { wsHash: "ws-b" } });
    expect((validations.at(-1) as { vm: { validations: unknown[] } }).vm.validations).toHaveLength(1);
  });

  it("a reload restores the global root from the persisted panel state (t-46eb4f)", async () => {
    const wsA = fakeWorkspace(mkroot(), { hash: "ws-a" });
    const wsB = fakeWorkspace(mkroot(), { hash: "ws-b" });
    await wsB.validationStore.create({ title: "beta check", author: "human" });
    const deps = depsFor([target(wsA), target(wsB)]);

    // What decodePanelState hands back on revive: the route plus the scope that was open.
    await openCockpit(deps, { section: "validations", wsHash: "ws-b" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    const validations = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "validations");
    expect(validations.at(-1)).toMatchObject({ vm: { wsHash: "ws-b" } });
  });

  it("a fresh navigate to the SAME section invalidates an in-flight response from the prior visit", async () => {
    // The sharp case: re-navigating to the section already on screen still bumps the epoch, so the
    // first visit's in-flight response must be discarded rather than posted a second time.
    const wsA = fakeWorkspace(mkroot(), { hash: "ws-a" });
    const { deps, releaseWedged } = wedgeFirstCollect([target(wsA)]);

    await openCockpit(deps, { section: "fleet", wsHash: "ws-a" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush(); // the first sendModel's collect() is in-flight and wedged
    expect(modelsPosted()).toHaveLength(0);

    // re-navigate to the SAME section (e.g. clicking the tile again) — bumps the epoch even though
    // the section string is unchanged.
    __createdPanels[0].webview.__receive({ type: "setSection", section: "fleet" });
    await flush();
    expect(modelsPosted()).toHaveLength(1); // the second visit's own send landed

    releaseWedged();
    await flush();
    await flush();
    // still exactly ONE push — the first (stale-epoch) call's post was discarded even though it is
    // the same section, which is the only thing separating this case from a no-op.
    expect(modelsPosted()).toHaveLength(1);
  });

  it("switching the workspace scope invalidates an in-flight response built for the old scope", async () => {
    const wsA = fakeWorkspace(mkroot(), { hash: "ws-a" });
    const wsB = fakeWorkspace(mkroot(), { hash: "ws-b" });
    // The FIRST read (built for ws-a) wedges; the read the scope switch triggers answers instantly.
    const { deps, releaseWedged } = wedgeFirstCollect([target(wsA), target(wsB)]);

    await openCockpit(deps, { section: "fleet", wsHash: "ws-a" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush(); // ws-a's read is now in-flight and wedged
    expect(modelsPosted()).toHaveLength(0);

    __createdPanels[0].webview.__receive({ type: "switchControlWorkspace", wsHash: "ws-b" });
    await flush();
    // the post-switch read (instant) should have landed already, carrying ws-b
    expect(modelsPosted()).toHaveLength(1);

    releaseWedged();
    await flush();
    await flush();
    // the late ws-a response must NOT add a second push on top of the current scope's — a scope
    // switch is the same "the world changed" event class as a navigation and bumps the same epoch.
    expect(modelsPosted()).toHaveLength(1);
  });
});

describe("persisted state — always writes schemaVersion 2", () => {
  it("does not open Overview when Control itself lands, but a deliberate Overview navigation still does", async () => {
    const ws = fakeWorkspace();
    let overviewOpens = 0;
    const deps = depsFor([target(ws)], { openOverview: () => { overviewOpens += 1; } });

    await openCockpit(deps);
    expect(overviewOpens).toBe(0);

    __createdPanels[0].webview.__receive({ type: "setSection", section: "overview" });
    await flush();
    expect(overviewOpens).toBe(1);
  });

  it("opening a pin document does not also open Overview", async () => {
    const ws = fakeWorkspace();
    const pinOpens: string[] = [];
    let overviewOpens = 0;
    const deps = depsFor([target(ws)], {
      openOverview: () => { overviewOpens += 1; },
      pinDetail: {
        openDocument: (_wsHash, pinId) => { pinOpens.push(pinId); },
        openEditDocument: (_wsHash, pinId) => { pinOpens.push(pinId); },
      },
    });

    await openCockpit(deps, { route: { kind: "studio-edit", studio: "pin", wsHash: ws.wsHash, entityId: "p-abc123", returnRoute: null } });
    expect(pinOpens).toEqual(["p-abc123"]);
    expect(overviewOpens).toBe(0);
  });

  it("a freshly created panel persists {schemaVersion:2, route} not the old bare section", async () => {
    const ws = fakeWorkspace();
    const deps = depsFor([target(ws)]);
    await openCockpit(deps, { section: "settings" });
    expect(__createdPanels[0].webview.html).toContain('"schemaVersion":2');
    expect(__createdPanels[0].webview.html).toContain('"kind":"section"');
    // SDD 485 D10 — Settings is redirected to its own app before Control commits state.
    expect(__createdPanels[0].webview.html).toContain('"section":"validations"');
  });
});

describe("revive precedence — the Cockpit's own revival wins over a raced legacy-shim duplicate", () => {
  it("reviving Cockpit's OWN persisted panel disposes an interim duplicate a shim already created", async () => {
    const ws = fakeWorkspace();
    const deps = depsFor([target(ws)]);

    // a legacy shim redirect fires first (singleton not yet claimed) and creates a fresh panel
    await openCockpit(deps, { section: "tmux" });
    expect(__createdPanels).toHaveLength(1);
    const interim = __createdPanels[0];
    expect(interim.disposed).toBe(false);

    // VS Code's OWN Cockpit revival now fires, handing Cockpit.ts a GENUINELY DISTINCT persisted
    // panel object (not a shallow copy sharing the interim's dispose closure — a real revival
    // never does that; this mirrors it by minting its own independent mock panel).
    const revivedPanel = vscode.window.createWebviewPanel("tachyonCockpit", "Control", -1, {});
    await openCockpit(deps, { revivedPanel: revivedPanel as never, section: "fleet" });

    expect(interim.disposed).toBe(true); // the raced duplicate is retired
    expect(__createdPanels).toHaveLength(2);
    expect(__createdPanels[1].disposed).toBe(false); // the real revival survives as canonical
  });
});

describe("revive precedence — legacy shims skip their redirect once Control is already claimed", () => {
  it("isCockpitSingletonClaimed reflects a real openCockpit open, and clears on dispose", async () => {
    expect(isCockpitSingletonClaimed()).toBe(false);
    const ws = fakeWorkspace();
    const deps = depsFor([target(ws)]);
    await openCockpit(deps, { section: "overview" });
    expect(isCockpitSingletonClaimed()).toBe(true);

    __createdPanels[0].dispose();
    expect(isCockpitSingletonClaimed()).toBe(false);
  });

  it("ApprovalPanelManager.deserialize redirects when unclaimed, no-ops when already claimed", () => {
    const mgr = new ApprovalPanelManager(undefined as never, () => []);
    const panel = { dispose: () => {} } as never;

    mgr.deserialize(panel, { schemaVersion: 1, view: "tachyonApprovals", wsHash: "ws-1" });
    expect(__getExecutedCommands().some((c) => c.command === "tachyon.openApprovals")).toBe(true);

    __resetVscodeMock();
    markCockpitSingletonClaimed();
    mgr.deserialize(panel, { schemaVersion: 1, view: "tachyonApprovals", wsHash: "ws-1" });
    expect(__getExecutedCommands().some((c) => c.command === "tachyon.openApprovals")).toBe(false);
  });

  it("ApprovalPanelManager.open() is unguarded — a live jump always navigates even when claimed", () => {
    const mgr = new ApprovalPanelManager(undefined as never, () => []);
    markCockpitSingletonClaimed();
    mgr.open({ wsHash: "ws-1" } as never);
    expect(__getExecutedCommands().some((c) => c.command === "tachyon.openApprovals")).toBe(true);
  });

  // SDD 485 D2 — the Plugins case left this suite with the redirect it was about. There is no
  // dispose-and-redirect for `tachyonPlugins` any more: the app REUSES that viewType, so a revived panel
  // is kept and re-keyed rather than thrown away and re-requested through a command, and the
  // `isCockpitSingletonClaimed()` guard went with it (that guard existed because the redirect would
  // otherwise navigate a Control panel someone else had already restored — opening an app touches no
  // Control state). What replaced this case is `pluginsApp.test.ts`'s revive block, which drives a REAL
  // `registerTrustedPanelSerializer` with both the app's own state and the pre-410 `{wsHash}` record.
});
