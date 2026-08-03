import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { openCockpit, type CockpitDeps, type CockpitMissionBoard } from "../../src/webview/Cockpit.js";
import { isCockpitSingletonClaimed } from "../../src/webview/cockpitSingleton.js";
import { legacyTaskDetailTarget } from "../../src/shell/TaskDetailTarget.js";
import { legacyMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import { makeFakeCockpitDeps } from "../mocks/cockpitDeps.js";
import { TaskDetailPanelManager } from "../../src/webview/TaskDetailPanel.js";
import { readyMessage } from "../../src/webview/shared/ready.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

/**
 * t-20bbfa — Attention → "Open" on a Task-note notice, while Control is ALREADY on the Board.
 *
 * The report (0.56.116): the Board stayed put with its task selected, Task Detail never opened, and
 * Control then rendered "No Tachyon workspace attached in this window." and stayed unusable. Three
 * landed fixes (t-2f6cdd / t-6ced6f's hoisted READY, t-a632eb's panel-identity dispose guard) each
 * covered one mechanism; this file has always been the guard over the PRODUCT effect, in the WARM
 * shape the report needs — a Board that is already live and already scoped.
 *
 * SDD 485 C4 CHANGED THE ARCHITECTURE UNDER THIS REPORT, and the guard is kept rather than deleted
 * because the report's second half is still reachable and its first half is now a different claim:
 *
 *  - "Task Detail never opened" — the notice opens the task's OWN editor tab now, not a Control
 *    subroute. So the assertion moves from "Control's activeRoute is the task" to "a second panel
 *    exists, showing that task, beside a Control that did not move".
 *  - "Control then rendered 'No Tachyon workspace attached'" — that branch is `if (!m)` in App.tsx,
 *    reached when models stop arriving on a panel whose wiring was nulled. Control is still a
 *    singleton with the same module-scoped wiring, so the failure mode survives the migration and
 *    the guard over it is worth exactly as much as it was.
 *
 * What the new architecture buys, and what the last case below measures: the notice cannot disturb
 * Control at all, because it no longer navigates it. The old repro's whole surface — reveal a live
 * panel, re-navigate it, re-push its model — is gone from this path.
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

function fakeWorkspace(hash = "ws-1"): Workspace {
  const root = mkroot();
  return { wsHash: hash, folderName: "Project", workspaceRoot: root, taskStore: new TaskStore(root) } as unknown as Workspace;
}

/** The task-detail app manager, wired the way `extension.ts` wires it. */
function taskDetailApp(...workspaces: Workspace[]): TaskDetailPanelManager {
  const targets = workspaces.map((ws) => legacyTaskDetailTarget(ws));
  return new TaskDetailPanelManager(vscode.Uri.file("/ext"), () => targets, {
    onTasksChanged: () => {},
    openTaskStudio: () => {},
  });
}

function depsFor(app: TaskDetailPanelManager, ...workspaces: Workspace[]): CockpitDeps {
  const missionBoard: CockpitMissionBoard = {
    getWorkspaces: () => workspaces.map((ws) => legacyMissionControlTarget(ws)),
    openTaskStudio: () => {},
    onTasksChanged: () => {},
  };
  return makeFakeCockpitDeps(missionBoard, {
    taskDetail: {
      getWorkspaces: () => workspaces.map((ws) => legacyTaskDetailTarget(ws)),
      openDocument: (wsHash, taskId) => app.open(wsHash, taskId),
    },
  });
}

const postedOn = (panel: (typeof __createdPanels)[number], type: string): unknown[] =>
  panel.webview.posted.filter((m) => (m as { type?: string }).type === type);
const lastModel = (panel: (typeof __createdPanels)[number]): { model?: { activeRoute?: unknown } } | undefined =>
  postedOn(panel, "model").at(-1) as { model?: { activeRoute?: unknown } } | undefined;

/** Control, live and scoped to the Board — the WARM arrangement the report requires. */
async function boardIsOpen(deps: CockpitDeps, ws: Workspace) {
  await openCockpit(deps, { section: "mission", missionWsHash: ws.wsHash });
  const panel = __createdPanels[0]!;
  panel.webview.__receive(readyMessage());
  await flush();
  return panel;
}

/** The notice action itself: `tachyon.openControlTask`'s one-line body, post-C4. */
const attentionOpen = (app: TaskDetailPanelManager, wsHash: string, taskId: string): void => app.open(wsHash, taskId);

describe("t-20bbfa — Attention → Open lands on the Task, with Control still attached", () => {
  it("opens the task as its OWN tab beside the live Board", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "the task the note landed on", author: "human" });
    const app = taskDetailApp(ws);
    const control = await boardIsOpen(depsFor(app, ws), ws);

    attentionOpen(app, ws.wsHash, task.id);
    __createdPanels.at(-1)!.webview.__receive(readyMessage());
    await flush();

    // 1. A second panel — the report's "Task Detail never opened", read against the new architecture.
    expect(__createdPanels).toHaveLength(2);
    const doc = __createdPanels[1]!;
    expect(doc).not.toBe(control);
    // 2. The detail's own content arrived on it, and as a document rather than a tombstone.
    const vm = (postedOn(doc, "task").at(-1) as { vm?: { id?: string; tombstone?: boolean } } | undefined)?.vm;
    expect(vm?.id).toBe(task.id);
    expect(vm?.tombstone, "the task rendered as a tombstone rather than a document").toBe(false);
    // 3. Control is untouched: not revealed, not re-navigated, not disposed.
    expect(control.disposed).toBe(false);
    expect(control.revealCount).toBe(0);
    expect(lastModel(control)?.model?.activeRoute).toBeUndefined();
  });

  it("does not detach the workspace: Control keeps its panel, its claim and its model flow", async () => {
    // "No Tachyon workspace attached in this window." is App.tsx's `if (!m)` branch — what the client
    // shows when NO model has been delivered. The claim + a later model is what answers the report.
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "note target", author: "human" });
    const app = taskDetailApp(ws);
    const deps = depsFor(app, ws);
    const control = await boardIsOpen(deps, ws);
    const before = postedOn(control, "model").length;

    attentionOpen(app, ws.wsHash, task.id);
    await flush();
    await openCockpit(deps); // "Tachyon: Open Control", the recovery the report says did not work

    expect(isCockpitSingletonClaimed(), "Control released its singleton claim").toBe(true);
    expect(__createdPanels.filter((p) => p === control)).toHaveLength(1);
    expect(postedOn(control, "model").length).toBeGreaterThanOrEqual(before);
    expect(control.revealCount, "reopening Control did not reach the existing panel").toBe(1);
  });

  it("keeps the note's OWN workspace, not the Board's shell scope, when they differ", async () => {
    // The document's identity is the notice's wsHash, frozen at open. A notice raised for one root
    // while Control is scoped to another must open THAT root's task — the "perde o workspace anexado"
    // half of the report, read from the other direction, and the C4 identity rule from the same angle.
    const scoped = fakeWorkspace("ws-1");
    const other = fakeWorkspace("ws-2");
    const task = await other.taskStore.create({ title: "raised elsewhere", author: "human" });
    const app = taskDetailApp(scoped, other);
    await boardIsOpen(depsFor(app, scoped, other), scoped);

    attentionOpen(app, "ws-2", task.id);
    __createdPanels.at(-1)!.webview.__receive(readyMessage());
    await flush();

    const vm = (postedOn(__createdPanels[1]!, "task").at(-1) as { vm?: { id?: string; wsHash?: string; tombstone?: boolean } } | undefined)?.vm;
    expect(vm).toMatchObject({ id: task.id, wsHash: "ws-2", tombstone: false });
  });

  it("reopening the same notice REVEALS the tab it already opened", async () => {
    // The old shape's risk was a second Control racing the first. The document's is a second TAB for
    // one task; the cardinality forbids it, and the notice is the caller most likely to be clicked twice.
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "clicked twice", author: "human" });
    const app = taskDetailApp(ws);
    await boardIsOpen(depsFor(app, ws), ws);

    attentionOpen(app, ws.wsHash, task.id);
    attentionOpen(app, ws.wsHash, task.id);
    await flush();

    expect(__createdPanels).toHaveLength(2); // Control + one document
    expect(__createdPanels[1]!.revealCount).toBe(1);
  });
});
