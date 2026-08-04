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
  // SDD 485 C4 — a task opens as its own tab; `openDocument` is what Control asks for, and this file's
  // first case is precisely that it does NOT bracket a navigation it never makes.
  const taskDetail: CockpitTaskDetail = {
    getWorkspaces: () => all.map((w) => legacyTaskDetailTarget(w)),
    openDocument: () => {},
  };
  // A minimal handoff target — no real ProjectHandoffStore. SDD 485 C4 made project-handoff the detail
  // route these bracket assertions ride on (the task detail left Control), so the snapshot now carries
  // every field `sendHandoff` reads: a stub that throws on a missing field posts NO content, and the
  // ordering claims below are exactly about the content push landing before `routeReady`.
  const handoff = {
    getWorkspaces: () =>
      all.map((w) => ({
        workspaceRoot: (w as unknown as { workspaceRoot: string }).workspaceRoot,
        wsHash: w.wsHash,
        folderName: w.folderName,
        loadHandoff: async () => ({
          exists: true,
          body: "",
          revision: "r1",
          staleness: "fresh",
          pendingCount: 0,
          notes: [],
          distillTargets: [],
        }),
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
  it("posts routePending for a detail route BEFORE the model the client used to wait on", async () => {
    // This case used to drive a Board card click, which navigated Control to the task-detail subroute.
    // SDD 485 C4 made that a tab rather than a navigation, so the bracket is measured on the detail
    // route Control still owns. The property is unchanged and is the point of the feature:
    // acknowledgement lands ahead of the expensive payload.
    const ws = fakeWorkspace();

    await openCockpit(depsFor([ws]), { section: "overview" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    const before = posted().length;

    __createdPanels[0].webview.__receive({ type: "openProjectHandoff" });
    await flush();

    const after = posted().slice(before) as Array<{ type?: string; routeKey?: string }>;
    const types = after.map((m) => m.type ?? "");
    const pendingAt = types.indexOf("routePending");
    const modelAt = types.indexOf("model");

    expect(pendingAt, `no routePending after the click; got ${JSON.stringify(types)}`).toBeGreaterThanOrEqual(0);
    expect(modelAt, `no model after the click; got ${JSON.stringify(types)}`).toBeGreaterThanOrEqual(0);
    expect(pendingAt).toBeLessThan(modelAt);
    // It names WHICH navigation, so the client can ignore a superseded route's late ready.
    expect(after[pendingAt].routeKey).toBe(`project-handoff:${ws.wsHash}`);
  });

  it("closes the bracket with routeReady only after the route's own content is posted", async () => {
    const ws = fakeWorkspace();

    await openCockpit(depsFor([ws]), { section: "overview" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    const before = posted().length;

    __createdPanels[0].webview.__receive({ type: "openProjectHandoff" });
    await flush();

    const after = posted().slice(before) as Array<{ type?: string; routeKey?: string }>;
    const types = after.map((m) => m.type ?? "");
    const contentAt = types.indexOf("handoff");
    const readyAt = types.indexOf("routeReady");

    expect(contentAt, `no content push; got ${JSON.stringify(types)}`).toBeGreaterThanOrEqual(0);
    expect(readyAt, `no routeReady; got ${JSON.stringify(types)}`).toBeGreaterThanOrEqual(0);
    // Ready must mean "the content is there", or the client would drop its pending state onto an
    // empty surface — the abrupt swap this task exists to remove.
    expect(contentAt).toBeLessThan(readyAt);
    expect(after[readyAt].routeKey).toBe(`project-handoff:${ws.wsHash}`);
  });

  it("does NOT bracket a click that opens a DOCUMENT — Control never navigated (SDD 485 C4)", async () => {
    // The bracket is a promise about a navigation THIS panel is making. A Board card now opens the
    // task's own editor tab and leaves Control where it is, so a pending state here would be a
    // progress bar for a navigation that never arrives — the client would sit in it forever.
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "opens as its own tab", author: "human" });

    await openCockpit(depsFor([ws]), { section: "mission" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    const before = posted().length;

    __createdPanels[0].webview.__receive({ type: "openTask", id: t.id });
    await flush();

    const types = posted().slice(before).map((m) => m.type ?? "");
    expect(types, `Control bracketed a navigation it did not make: ${JSON.stringify(types)}`).not.toContain("routePending");
    expect(types).not.toContain("routeReady");
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

    __createdPanels[0].webview.__receive({ type: "setSection", section: "approvals" });
    await flush();

    const after = posted().slice(before) as Array<{ type?: string; routeKey?: string }>;
    expect(after.some((m) => m.type === "routePending" && m.routeKey === "section:approvals")).toBe(true);
    expect(after.some((m) => m.type === "routeReady" && m.routeKey === "section:approvals")).toBe(true);
  });

  it("suppresses a superseded route's routeReady so it cannot clear a newer navigation's pending state", async () => {
    const ws = fakeWorkspace();

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

    await openCockpit(depsFor([ws], { collect }), { section: "overview" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    __createdPanels[0].webview.__receive({ type: "setSection", section: "fleet" });
    await flush();
    const before = posted().length;

    // Second click supersedes while the first is parked inside collect().
    __createdPanels[0].webview.__receive({ type: "setSection", section: "engine" });
    await flush();
    const modelsBeforeStaleSettles = posted().filter((m) => m.type === "model");
    expect(modelsBeforeStaleSettles.at(-1)).toMatchObject({ model: { section: "engine" } });
    release?.();
    await flush();
    await flush();

    const after = posted().slice(before) as Array<{ type?: string; routeKey?: string }>;
    const staleReady = after.filter((m) => m.type === "routeReady" && m.routeKey === "section:fleet");
    // A ready for the abandoned route would clear the pending state of the route the user actually
    // wants, dropping the UI back to "loaded" while the real destination is still loading.
    expect(staleReady, `stale routeReady leaked: ${JSON.stringify(after)}`).toHaveLength(0);
    expect(after.some((m) => m.type === "routePending" && m.routeKey === "section:engine")).toBe(true);
    // The model whose collect() began for the first route is stale too. Dropping it is expected,
    // but must not leave the live panel model-less: the superseding hot navigation schedules and
    // delivers its own model before the old collect settles. Releasing the old call must therefore
    // add no model and cannot overwrite the current route with old workspace data.
    const modelsAfterStaleSettles = posted().filter((m) => m.type === "model");
    expect(modelsAfterStaleSettles).toHaveLength(modelsBeforeStaleSettles.length);
    expect(modelsAfterStaleSettles.at(-1)).toMatchObject({ model: { section: "engine" } });
  });

  it("still delivers model before a detail route's content — the ordering this feature must not disturb", async () => {
    // The client rejects content for a route it has not learned yet (t-9993cc's rule, which the task
    // detail carried before SDD 485 C4 moved it out; the same ordering still binds every detail route
    // Control keeps). This case passes both with and without the bracket, on purpose — it is here to
    // catch the bracket breaking someone else's invariant, not to prove the bracket.
    const ws = fakeWorkspace();

    await openCockpit(depsFor([ws]), { route: { kind: "project-handoff", wsHash: ws.wsHash } });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    const modelAt = firstIndexOf("model");
    const contentAt = firstIndexOf("handoff");
    expect(modelAt).toBeGreaterThanOrEqual(0);
    expect(contentAt).toBeGreaterThanOrEqual(0);
    expect(modelAt).toBeLessThan(contentAt);
  });
});
