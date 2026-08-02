import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { openCockpit, type CockpitMissionBoard, type CockpitTaskDetail } from "../../src/webview/Cockpit.js";
import { legacyTaskDetailTarget } from "../../src/shell/TaskDetailTarget.js";
import { legacyMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import { makeFakeCockpitDeps } from "../mocks/cockpitDeps.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import type { CockpitWorkspaceBundle } from "../../src/cockpit/model.js";

/**
 * t-ac79a7 — human report: clicking a task on the Board leaves the screen apparently unchanged for
 * seconds, then swaps abruptly to Task Detail. Nothing acknowledges the click.
 *
 * MEASURED cause (not deduced): the click's route commit is already synchronous — `handleMission-
 * Action`'s "openTask" calls `requestNavigate`, which off a studio route passes straight through to
 * `navigate()`. What the client never learned is that it happened, because the first thing posted
 * afterwards is the MODEL, and `sendModel()` opens with `await deps.collect()` — a serial sweep of
 * five engine round-trips PER WORKSPACE (engineLogHealth, tmux.health, companion.status,
 * worktrees.classified, deliveries.classified; see t-af3eef). The client renders the old route until
 * that resolves, so the delay is entirely dead air.
 *
 * The fix brackets navigation with two messages emitted at the two authoritative points —
 * `routePending` from `navigate()` (the single commit every navigation intent funnels through) and
 * `routeReady` from the end of `sendSectionModule()` (the single place a route's module finishes
 * loading). These tests exercise that bracket through the real cockpit host.
 *
 * The ORDERING assertion is the one that matters: routePending must precede the model, because
 * arriving after it would make the whole feature pointless — the client would learn the navigation
 * had happened only once it already had the content.
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-nav-pending-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeWorkspace(opts: { hash?: string; name?: string } = {}) {
  const root = mkroot();
  return {
    wsHash: opts.hash ?? "ws-1",
    folderName: opts.name ?? "Project",
    workspaceRoot: root,
    taskStore: new TaskStore(root),
  } as unknown as Workspace;
}

function depsFor(all: Workspace[], overrides: { collect?: () => Promise<CockpitWorkspaceBundle[]> } = {}) {
  const missionBoard: CockpitMissionBoard = {
    getWorkspaces: () => all.map((w) => legacyMissionControlTarget(w)),
    openTaskStudio: () => {},
    onTasksChanged: () => {},
  };
  const taskDetail: CockpitTaskDetail = { getWorkspaces: () => all.map((w) => legacyTaskDetailTarget(w)) };
  // A minimal handoff target: the bracket assertion only needs the route to RESOLVE and commit, so
  // this stubs the content load rather than standing up a real ProjectHandoffStore.
  const handoff = {
    getWorkspaces: () =>
      all.map((w) => ({
        workspaceRoot: (w as unknown as { workspaceRoot: string }).workspaceRoot,
        wsHash: w.wsHash,
        folderName: w.folderName,
        loadHandoff: async () => ({ body: "", revision: "r1", pending: [], pendingThrough: null }),
        ensureHandoffFile: async () => "HANDOFF.md",
        startHandoffDistill: async () => ({ ok: true }),
      })),
  } as unknown as NonNullable<Parameters<typeof makeFakeCockpitDeps>[1]>["handoff"];
  return makeFakeCockpitDeps(missionBoard, {
    taskDetail,
    handoff,
    ...(overrides.collect ? { collect: overrides.collect } : {}),
  });
}

const posted = () => __createdPanels[0].webview.posted as Array<{
  type?: string;
  routeKey?: string;
  model?: { activeRoute?: { kind?: string; wsHash?: string; taskId?: string } };
}>;
const postedTypes = (): string[] => posted().map((m) => m.type ?? "");
/** Index of the first message of a type, or -1 — ordering is the point of most assertions here. */
const firstIndexOf = (type: string): number => postedTypes().indexOf(type);

describe("t-ac79a7: every navigation is bracketed by routePending / routeReady", () => {
  it("posts routePending for a Board click BEFORE the model the client used to wait on", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "open me from the board", author: "human" });

    // A Board click is exactly this: the panel is on the mission section, the card posts openTask.
    await openCockpit(depsFor([ws]), { section: "mission" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    const before = posted().length;

    __createdPanels[0].webview.__receive({ type: "openTask", id: t.id });
    await flush();

    const after = posted().slice(before) as Array<{ type?: string; routeKey?: string }>;
    const types = after.map((m) => m.type ?? "");
    const pendingAt = types.indexOf("routePending");
    const modelAt = types.indexOf("model");

    expect(pendingAt, `no routePending after the click; got ${JSON.stringify(types)}`).toBeGreaterThanOrEqual(0);
    expect(modelAt, `no model after the click; got ${JSON.stringify(types)}`).toBeGreaterThanOrEqual(0);
    // The whole point: acknowledgement lands ahead of the expensive payload, not with it.
    expect(pendingAt).toBeLessThan(modelAt);
    // It names WHICH navigation, so the client can ignore a superseded route's late ready.
    expect(after[pendingAt].routeKey).toBe(`task-detail:${ws.wsHash}:${t.id}`);
  });

  it("closes the bracket with routeReady only after the route's own content is posted", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "ready comes last", author: "human" });

    await openCockpit(depsFor([ws]), { section: "mission" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    const before = posted().length;

    __createdPanels[0].webview.__receive({ type: "openTask", id: t.id });
    await flush();

    const after = posted().slice(before) as Array<{ type?: string; routeKey?: string }>;
    const types = after.map((m) => m.type ?? "");
    const taskAt = types.indexOf("task");
    const readyAt = types.indexOf("routeReady");

    expect(taskAt, `no task push; got ${JSON.stringify(types)}`).toBeGreaterThanOrEqual(0);
    expect(readyAt, `no routeReady; got ${JSON.stringify(types)}`).toBeGreaterThanOrEqual(0);
    // Ready must mean "the content is there", or the client would drop its pending state onto an
    // empty surface — the abrupt swap this task exists to remove.
    expect(taskAt).toBeLessThan(readyAt);
    expect(after[readyAt].routeKey).toBe(`task-detail:${ws.wsHash}:${t.id}`);
  });

  it("brackets a DIFFERENT detail route kind with the same primitive — one emit, not one per route", async () => {
    const ws = fakeWorkspace();

    // project-handoff is a detail route that shares nothing with task-detail's handler. It gets the
    // bracket anyway, because the emit lives at the shared commit point rather than in either
    // route's own code path. This is the "does the same primitive serve other detail routes without
    // duplication" question, answered by execution instead of by reading.
    await openCockpit(depsFor([ws]), { section: "overview" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    const before = posted().length;

    __createdPanels[0].webview.__receive({ type: "openProjectHandoff" });
    await flush();

    const after = posted().slice(before) as Array<{ type?: string; routeKey?: string }>;
    const pending = after.find((m) => m.type === "routePending");
    expect(pending, `no routePending for project-handoff; got ${JSON.stringify(after.map((m) => m.type))}`).toBeDefined();
    expect(pending?.routeKey).toBe(`project-handoff:${ws.wsHash}`);
    expect(after.some((m) => m.type === "routeReady" && m.routeKey === `project-handoff:${ws.wsHash}`)).toBe(true);
  });

  it("emits the pending bracket for a section switch too, so the shell is never silently busy", async () => {
    const ws = fakeWorkspace();

    await openCockpit(depsFor([ws]), { section: "overview" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    const before = posted().length;

    __createdPanels[0].webview.__receive({ type: "setSection", section: "fleet" });
    await flush();

    const after = posted().slice(before) as Array<{ type?: string; routeKey?: string }>;
    expect(after.some((m) => m.type === "routePending" && m.routeKey === "section:fleet")).toBe(true);
    expect(after.some((m) => m.type === "routeReady" && m.routeKey === "section:fleet")).toBe(true);
  });

  it("suppresses a superseded route's routeReady so it cannot clear a newer navigation's pending state", async () => {
    const ws = fakeWorkspace();
    const first = await ws.taskStore.create({ title: "superseded", author: "human" });
    const second = await ws.taskStore.create({ title: "the one the user wants", author: "human" });

    // Hold collect open so the FIRST navigation is still mid-load when the second one commits —
    // the interleaving a real impatient double-click on two different cards produces, which the
    // measured latency (seconds) makes easy to hit rather than theoretical.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const collect = async (): Promise<CockpitWorkspaceBundle[]> => {
      calls += 1;
      if (calls === 2) await gate; // 1st call is the initial READY's own model
      return [];
    };

    await openCockpit(depsFor([ws], { collect }), { section: "mission" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    __createdPanels[0].webview.__receive({ type: "openTask", id: first.id });
    await flush();
    const before = posted().length;

    // Second click supersedes while the first is parked inside collect().
    __createdPanels[0].webview.__receive({ type: "openTask", id: second.id });
    await flush();
    const modelsBeforeStaleSettles = posted().filter((m) => m.type === "model");
    expect(modelsBeforeStaleSettles.at(-1)).toMatchObject({
      model: { activeRoute: { kind: "task-detail", wsHash: ws.wsHash, taskId: second.id } },
    });
    release?.();
    await flush();
    await flush();

    const after = posted().slice(before) as Array<{ type?: string; routeKey?: string }>;
    const staleReady = after.filter((m) => m.type === "routeReady" && m.routeKey === `task-detail:${ws.wsHash}:${first.id}`);
    // A ready for the abandoned route would clear the pending state of the route the user actually
    // wants, dropping the UI back to "loaded" while the real destination is still loading.
    expect(staleReady, `stale routeReady leaked: ${JSON.stringify(after)}`).toHaveLength(0);
    expect(after.some((m) => m.type === "routePending" && m.routeKey === `task-detail:${ws.wsHash}:${second.id}`)).toBe(true);
    // The model whose collect() began for the first route is stale too. Dropping it is expected,
    // but must not leave the live panel model-less: the superseding hot navigation schedules and
    // delivers its own model before the old collect settles. Releasing the old call must therefore
    // add no model and cannot overwrite the current route with old workspace data.
    const modelsAfterStaleSettles = posted().filter((m) => m.type === "model");
    expect(modelsAfterStaleSettles).toHaveLength(modelsBeforeStaleSettles.length);
    expect(modelsAfterStaleSettles.at(-1)).toMatchObject({
      model: { activeRoute: { kind: "task-detail", wsHash: ws.wsHash, taskId: second.id } },
    });
  });

  it("still delivers model before task — the t-9993cc ordering this feature must not disturb", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "guard intact", author: "human" });

    await openCockpit(depsFor([ws]), { route: { kind: "task-detail", wsHash: ws.wsHash, taskId: t.id } });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    const modelAt = firstIndexOf("model");
    const taskAt = firstIndexOf("task");
    expect(modelAt).toBeGreaterThanOrEqual(0);
    expect(taskAt).toBeGreaterThanOrEqual(0);
    // The client rejects a TASK whose route it hasn't learned yet (t-9993cc). Adding the bracket
    // must not reorder these two; this case passes both with and without the feature, on purpose —
    // it is here to catch the bracket breaking someone else's invariant, not to prove the bracket.
    expect(modelAt).toBeLessThan(taskAt);
  });
});
