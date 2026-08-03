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
import { PluginsPanelManager } from "../../src/webview/PluginsPanel.js";
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
 * A section whose module push is genuinely ASYNC and injectable, so an in-flight response can be held open
 * across a navigation. Runtime Ops is that section: `buildSnapshot()` is a dep, and `sendRuntime` captures
 * `navEpoch` before awaiting it exactly like every other sender.
 *
 * SDD 485 C5 — this used to be the Board's `listMissionControlAgents()`. The Board left Control for its own
 * app, so the vehicle changed; the mechanism under test (one `navEpoch`, captured before the await, checked
 * after) is Control-wide and unchanged, and its per-panel equivalent for the apps is the `PanelWorkGate`.
 */
function wedgeableRuntime(targets: WorkspaceMissionControlTarget[], build: () => Promise<never>) {
  return depsFor(targets, { runtimeOps: { buildSnapshot: build } as never });
}

const snapshotsOf = (type: string) =>
  __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === type);

const messageTypes = () => __createdPanels[0].webview.posted.map((m) => (m as { type?: string }).type);

describe("navigation epoch — discards stale responses from a superseded route", () => {
  it("a slow section response that resolves AFTER navigating away is never posted", async () => {
    const ws = fakeWorkspace();
    const pending = deferred<never>();
    const deps = wedgeableRuntime([target(ws)], () => pending.promise);

    await openCockpit(deps, { section: "runtime", wsHash: ws.wsHash });
    // "ready" is the real client's first message — triggers sendModel + sendSectionModule, so
    // sendRuntime's buildSnapshot() is now in-flight and wedged on `pending`.
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    expect(messageTypes()).not.toContain("runtimeOpsSnapshot");

    // navigate away before the slow buildSnapshot() resolves
    __createdPanels[0].webview.__receive({ type: "setSection", section: "overview" });
    await flush();
    expect(messageTypes()).not.toContain("runtimeOpsSnapshot");

    pending.resolve({ generatedAt: "", providers: [] } as never);
    await flush();
    await flush();
    // the wedged call finally resolves, but the epoch it captured is stale — still nothing posted
    expect(messageTypes()).not.toContain("runtimeOpsSnapshot");
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
    // BOTH visits await the SAME underlying promise, so they wake up at the identical tick off one
    // settle. That is the sharp case: the epoch guard has to let exactly the CURRENT (second) call's
    // post through and discard the stale first one, with no timing difference to hide behind.
    const wsA = fakeWorkspace(mkroot(), { hash: "ws-a" });
    const pending = deferred<never>();
    const deps = wedgeableRuntime([target(wsA)], () => pending.promise);

    await openCockpit(deps, { section: "runtime", wsHash: "ws-a" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush(); // the first sendRuntime's buildSnapshot() is now in-flight and wedged
    expect(messageTypes()).not.toContain("runtimeOpsSnapshot");

    // re-navigate to the same section (e.g. clicking the tile again) — bumps the epoch even though
    // the section string is unchanged; both sendRuntime calls now await the same promise.
    __createdPanels[0].webview.__receive({ type: "setSection", section: "runtime" });
    await flush();
    expect(messageTypes()).not.toContain("runtimeOpsSnapshot"); // still wedged — neither has resolved

    pending.resolve({ generatedAt: "", providers: [] } as never); // both calls wake up together
    await flush();
    await flush();
    // exactly ONE push — the first (stale-epoch) call's post was discarded, only the current
    // (second) navigate's own send resolved to a post.
    expect(snapshotsOf("runtimeOpsSnapshot")).toHaveLength(1);
  });

  it("switching the workspace scope invalidates an in-flight response built for the old scope", async () => {
    const wsA = fakeWorkspace(mkroot(), { hash: "ws-a" });
    const wsB = fakeWorkspace(mkroot(), { hash: "ws-b" });
    const pending = deferred<never>();
    let call = 0;
    // The FIRST read (built for ws-a) wedges; the read the scope switch triggers answers instantly.
    const deps = wedgeableRuntime([target(wsA), target(wsB)], (() => {
      call += 1;
      return call === 1 ? pending.promise : Promise.resolve({ generatedAt: "", providers: [] });
    }) as never);

    await openCockpit(deps, { section: "runtime", wsHash: "ws-a" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush(); // ws-a's read is now in-flight and wedged
    expect(messageTypes()).not.toContain("runtimeOpsSnapshot");

    __createdPanels[0].webview.__receive({ type: "switchControlWorkspace", wsHash: "ws-b" });
    await flush();
    // the post-switch read (instant) should have landed already
    expect(snapshotsOf("runtimeOpsSnapshot")).toHaveLength(1);

    pending.resolve({ generatedAt: "", providers: [] } as never);
    await flush();
    await flush();
    // the late ws-a response must NOT add a second push on top of the current scope's
    expect(snapshotsOf("runtimeOpsSnapshot")).toHaveLength(1);
  });
});

describe("persisted state — always writes schemaVersion 2", () => {
  it("a freshly created panel persists {schemaVersion:2, route} not the old bare section", async () => {
    const ws = fakeWorkspace();
    const deps = depsFor([target(ws)]);
    await openCockpit(deps, { section: "fleet" });
    expect(__createdPanels[0].webview.html).toContain('"schemaVersion":2');
    expect(__createdPanels[0].webview.html).toContain('"kind":"section"');
    expect(__createdPanels[0].webview.html).toContain('"section":"fleet"');
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

  it("PluginsPanelManager.deserialize redirects when unclaimed, no-ops when already claimed", () => {
    const mgr = new PluginsPanelManager(undefined as never, () => []);
    const panel = { dispose: () => {} } as never;

    mgr.deserialize(panel, { schemaVersion: 1, view: "tachyonPlugins", wsHash: "ws-1" });
    expect(__getExecutedCommands().some((c) => c.command === "tachyon.openPlugins")).toBe(true);

    __resetVscodeMock();
    markCockpitSingletonClaimed();
    mgr.deserialize(panel, { schemaVersion: 1, view: "tachyonPlugins", wsHash: "ws-1" });
    expect(__getExecutedCommands().some((c) => c.command === "tachyon.openPlugins")).toBe(false);
  });
});
