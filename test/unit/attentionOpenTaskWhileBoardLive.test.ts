import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { openCockpit, type CockpitDeps, type CockpitMissionBoard, type CockpitTaskDetail } from "../../src/webview/Cockpit.js";
import { isCockpitSingletonClaimed } from "../../src/webview/cockpitSingleton.js";
import { legacyTaskDetailTarget } from "../../src/shell/TaskDetailTarget.js";
import { legacyMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import { makeFakeCockpitDeps } from "../mocks/cockpitDeps.js";
import { routes as cockpitRoutes } from "../../src/cockpit/route.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

/**
 * t-20bbfa — Attention → "Open" on a Task-note notice, while Control is ALREADY on the Board.
 *
 * The report (0.56.116): the Board stayed put with its task selected, Task Detail never opened, and
 * Control then rendered "No Tachyon workspace attached in this window." and stayed unusable.
 *
 * MEASURED at 0885fb0a before writing a line of fix: the transition works. `openCockpit({route:
 * task-detail})` against a live Board reveals the SAME panel and posts routePending → model →
 * task → routeReady, with `activeRoute` on the task. So this is a REGRESSION GUARD over three
 * landed fixes, not a fail-before for a live defect — the report's three named relations are each
 * one half of what it described, and all three shipped after 0.56.116:
 *
 *   - t-2f6cdd / t-6ced6f — `handleTaskDetailAction` answered the shell's READY and returned true,
 *     so a Control whose route was task-detail never received `init`; the client's `strings` stayed
 *     undefined and App.tsx rendered a bare `ds-empty`. READY is hoisted above the route chain now.
 *   - t-a632eb — `onDidDispose` guarded on `if (panel)` (truthiness) rather than panel identity, so
 *     a superseded panel's late disposal nulled the LIVE panel's wiring and suppressed every model
 *     push afterwards. `if (!m)` in App.tsx is precisely the "No Tachyon workspace attached in this
 *     window." branch the report ends on.
 *
 * Each of those has its own test for its own mechanism. None of them asserts the PRODUCT effect the
 * report is about, and none exercises the WARM shape — every existing task-detail handshake test
 * opens a COLD panel straight onto the route. The reported repro requires a Board that is already
 * live and already scoped, which is the one arrangement where the reveal path (requestNavigate on an
 * existing panel) runs instead of the create path. That gap is what this file closes.
 *
 * NOT the same defect as t-d16698, and the evidence is in t-5ca73a's own measurement: that task
 * localized the Review deadlock BY using this notice's "Open" as the working control. `openTask`
 * fires the UI request without awaiting it; `executeCommand` awaits, and the await was the deadlock.
 * The two symptoms rhyme and the causes are on opposite sides of one transport.
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attention-open-task-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeWorkspace(): Workspace {
  const root = mkroot();
  return { wsHash: "ws-1", folderName: "Project", workspaceRoot: root, taskStore: new TaskStore(root) } as unknown as Workspace;
}

function depsFor(ws: Workspace): CockpitDeps {
  const missionBoard: CockpitMissionBoard = {
    getWorkspaces: () => [legacyMissionControlTarget(ws)],
    openTaskStudio: () => {},
    onTasksChanged: () => {},
  };
  const taskDetail: CockpitTaskDetail = { getWorkspaces: () => [legacyTaskDetailTarget(ws)] };
  return makeFakeCockpitDeps(missionBoard, { taskDetail });
}

const live = () => __createdPanels.at(-1)!;
const postedOn = (panel: (typeof __createdPanels)[number], type: string): unknown[] =>
  panel.webview.posted.filter((m) => (m as { type?: string }).type === type);
const lastModel = (panel: (typeof __createdPanels)[number]) =>
  postedOn(panel, "model").at(-1) as { model?: { activeRoute?: { kind?: string; taskId?: string; wsHash?: string }; section?: string } } | undefined;

/** Control on the Board, handshaken, exactly as the report's step 1 leaves it. */
async function boardIsOpen(deps: CockpitDeps): Promise<(typeof __createdPanels)[number]> {
  await openCockpit(deps, { section: "mission", missionWsHash: "ws-1" });
  const panel = live();
  panel.webview.__receive({ type: "ready" });
  await flush();
  expect(lastModel(panel)?.model?.section, "precondition: the Board is what is on screen").toBe("mission");
  return panel;
}

/** The notice action itself: `tachyon.openControlTask`'s one-line body. */
const attentionOpen = (deps: CockpitDeps, wsHash: string, taskId: string): Promise<void> =>
  openCockpit(deps, { route: cockpitRoutes.taskDetail(wsHash, taskId) });

describe("t-20bbfa — Attention → Open lands on the Task, with Control still attached", () => {
  it("navigates the LIVE Board to the task's detail instead of leaving the Board selected", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "the task the note landed on", author: "human" });
    const deps = depsFor(ws);
    const panel = await boardIsOpen(deps);

    await attentionOpen(deps, ws.wsHash, task.id);
    await flush();

    // 1. The route actually moved. "Board stays selected" is the report's first symptom.
    expect(lastModel(panel)?.model?.activeRoute).toEqual({ kind: "task-detail", wsHash: ws.wsHash, taskId: task.id });
    // 2. The detail's own content arrived, not just the route.
    const taskVm = postedOn(panel, "task").at(-1) as { vm?: { id?: string; tombstone?: boolean } } | undefined;
    expect(taskVm?.vm?.id).toBe(task.id);
    expect(taskVm?.vm?.tombstone, "the task rendered as a tombstone rather than a document").toBe(false);
    // 3. One Control, revealed — not a second panel racing the first (the shape whose late disposal
    //    is what produced the detached shell in the report's step 4).
    expect(__createdPanels).toHaveLength(1);
    expect(panel.revealCount).toBe(1);
    expect(panel.disposed).toBe(false);
  });

  it("does not detach the workspace: a model still reaches the client after the transition", async () => {
    // "No Tachyon workspace attached in this window." is App.tsx's `if (!m)` branch — it is what the
    // client shows when NO model has been delivered, so the assertion that answers the report is
    // that models keep arriving on the same panel, and keep naming the workspace.
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "note target", author: "human" });
    const deps = depsFor(ws);
    const panel = await boardIsOpen(deps);
    const before = postedOn(panel, "model").length;

    await attentionOpen(deps, ws.wsHash, task.id);
    await flush();

    expect(postedOn(panel, "model").length, "the transition delivered no model").toBeGreaterThan(before);
    expect(isCockpitSingletonClaimed(), "Control released its singleton claim mid-navigation").toBe(true);
  });

  it("stays recoverable: reopening Control after the transition still reaches the same panel", async () => {
    // The report's last line is the expensive half — "novas tentativas de abrir o Control não
    // recuperam a superfície". A surface that cannot be reopened costs the window, not the click.
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "note target", author: "human" });
    const deps = depsFor(ws);
    const panel = await boardIsOpen(deps);

    await attentionOpen(deps, ws.wsHash, task.id);
    await flush();
    const afterOpen = postedOn(panel, "model").length;

    await openCockpit(deps); // "Tachyon: Open Control", the recovery the report says did not work
    await flush();

    expect(__createdPanels, "reopening Control forked a second panel").toHaveLength(1);
    expect(postedOn(panel, "model").length).toBeGreaterThan(afterOpen);
    expect(panel.revealCount).toBe(2);
  });

  it("keeps the note's OWN workspace, not the Board's shell scope, when they differ", async () => {
    // The route carries an immutable locator by design (cockpit/route.ts). A notice raised for one
    // root while Control is scoped to another must open THAT root's task — the "perde o workspace
    // anexado" half of the report read from the other direction.
    const scoped = fakeWorkspace();
    const other = { ...fakeWorkspace(), wsHash: "ws-2", folderName: "Other" } as Workspace;
    const task = await other.taskStore.create({ title: "raised elsewhere", author: "human" });
    const missionBoard: CockpitMissionBoard = {
      getWorkspaces: () => [legacyMissionControlTarget(scoped), legacyMissionControlTarget(other)],
      openTaskStudio: () => {},
      onTasksChanged: () => {},
    };
    const deps = makeFakeCockpitDeps(missionBoard, {
      taskDetail: { getWorkspaces: () => [legacyTaskDetailTarget(scoped), legacyTaskDetailTarget(other)] },
    });
    const panel = await boardIsOpen(deps);

    await attentionOpen(deps, "ws-2", task.id);
    await flush();

    expect(lastModel(panel)?.model?.activeRoute?.wsHash).toBe("ws-2");
    expect((postedOn(panel, "task").at(-1) as { vm?: { id?: string; tombstone?: boolean } } | undefined)?.vm)
      .toMatchObject({ id: task.id, tombstone: false });
  });
});
