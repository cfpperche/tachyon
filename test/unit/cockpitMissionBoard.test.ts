import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __createdPanels, __getClipboardText, __resetVscodeMock } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import { openCockpit, refreshCockpitMissionBoard, type CockpitMissionBoard } from "../../src/webview/Cockpit.js";
import { legacyMissionControlTarget, type WorkspaceMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import type { WorkspacePresentationTarget } from "../../src/shell/WorkspacePresentation.js";
import { makeFakeCockpitDeps } from "../mocks/cockpitDeps.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

/**
 * t-610705 Phase B #6 — board ROUTING coverage for Control → Mission, ported from the retired
 * MissionControlPanelManager's tests: the standalone panel is gone, so the cockpit host is now the
 * one path for every board action (updateTask/reorderLane/closeValidation/openTask/copyTaskId/
 * openTask/copyTaskId) and must keep the same behavior contract (fan-out on success only, taskError on
 * store rejection, snapshot re-post when the global scope changes — t-46eb4f retired the Board's own
 * `switchWorkspace` mirror).
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-mission-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  // Cockpit's panel is a module-level singleton — dispose it so the next test creates a fresh one.
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeWorkspace(root = mkroot(), agents: Record<string, unknown> = {}, opts: { hash?: string; name?: string } = {}) {
  return {
    wsHash: opts.hash ?? "ws-1",
    folderName: opts.name ?? "Project",
    workspaceRoot: root,
    taskStore: new TaskStore(root),
    validationStore: new ValidationStore(root),
    config: { agents },
    manager: { list: async () => [] },
  } as unknown as Workspace;
}

const target = (workspace: Workspace): WorkspaceMissionControlTarget => legacyMissionControlTarget(workspace);

function boardOf(targets: WorkspaceMissionControlTarget[], hooks: Partial<CockpitMissionBoard> = {}): { board: CockpitMissionBoard; fanOuts: () => number } {
  let fanOuts = 0;
  const board: CockpitMissionBoard = {
    getWorkspaces: () => targets,
    openTaskStudio: () => {},
    onTasksChanged: () => {
      fanOuts += 1;
      refreshCockpitMissionBoard();
    },
    ...hooks,
  };
  return { board, fanOuts: () => fanOuts };
}

const snapshots = () =>
  __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "snapshot") as Array<{ vm: { folder: string; wsHash: string; agentLiveness?: { status: string }; snapshot: { views: Array<{ task: { title: string; status: string } }>; chips: Array<{ agent: string }> } } }>;

describe("Control → Mission board routing", () => {
  it("opens ONE cockpit panel and reveals it on a second open", async () => {
    const ws = fakeWorkspace();
    const { board } = boardOf([target(ws)]);
    const deps = makeFakeCockpitDeps(board);
    await openCockpit(deps, { section: "mission", wsHash: ws.wsHash });
    await openCockpit(deps, { section: "mission", wsHash: ws.wsHash });
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
  });

  it("posts a board snapshot with liveness + chips on requestSnapshot", async () => {
    const ws = fakeWorkspace(undefined, { codex: {} });
    await ws.taskStore.create({ title: "seed", author: "human" });
    const { board } = boardOf([target(ws)]);
    await openCockpit(makeFakeCockpitDeps(board), { section: "mission", wsHash: ws.wsHash });

    __createdPanels[0].webview.__receive({ type: "requestSnapshot" });
    await flush();

    const [snap] = snapshots();
    expect(snap.vm).toMatchObject({ folder: "Project", wsHash: "ws-1", agentLiveness: { status: "available" } });
    expect(snap.vm.snapshot.chips.map((c) => c.agent)).toEqual(["codex", "human"]);
  });

  it("applies a status-transition update, fans out once, and the fan-out re-posts a fresh snapshot", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "flow", author: "human" });
    const { board, fanOuts } = boardOf([target(ws)]);
    await openCockpit(makeFakeCockpitDeps(board), { section: "mission", wsHash: ws.wsHash });

    __createdPanels[0].webview.__receive({ type: "updateTask", id: t.id, patch: { status: "triaged" } });
    await flush();
    await flush();

    expect(ws.taskStore.get(t.id).status).toBe("triaged");
    expect(fanOuts()).toBe(1);
    const latest = snapshots().at(-1);
    expect(latest?.vm.snapshot.views.some((v) => v.task.title === "flow" && v.task.status === "triaged")).toBe(true);
  });

  it("posts a taskError (no fan-out, no move) when the store rejects a transition", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "gate", author: "human" });
    const { board, fanOuts } = boardOf([target(ws)]);
    await openCockpit(makeFakeCockpitDeps(board), { section: "mission", wsHash: ws.wsHash });

    // inbox -> done is not an allowed transition
    __createdPanels[0].webview.__receive({ type: "updateTask", id: t.id, patch: { status: "done" } });
    await flush();

    const errMsg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "taskError") as { taskId?: string; message: string };
    expect(errMsg.taskId).toBe(t.id);
    expect(errMsg.message).toMatch(/invalid status transition/);
    expect(ws.taskStore.get(t.id).status).toBe("inbox");
    expect(fanOuts()).toBe(0);
  });

  it("closes a validation from the board only with an auditable note, then fans out", async () => {
    const ws = fakeWorkspace();
    const validation = await ws.validationStore.create({ title: "Manual dogfood", author: "human", executor: "human" });
    const { board, fanOuts } = boardOf([target(ws)]);
    await openCockpit(makeFakeCockpitDeps(board), { section: "mission", wsHash: ws.wsHash });

    __createdPanels[0].webview.__receive({ type: "closeValidation", id: validation.id, outcome: "passed", result_note: "Checked installed VSIX manually" });
    await flush();

    expect(ws.validationStore.get(validation.id)).toMatchObject({ status: "closed", rounds: [{ outcome: "passed", result_note: "Checked installed VSIX manually" }] });
    expect(fanOuts()).toBe(1);
  });

  it("openTask asks for the task's OWN editor tab and leaves Control on the Board (SDD 485 C4)", async () => {
    // The card click used to navigate Control in place, which is why one panel could show one task.
    // It now opens the `document` app — and the wsHash it passes is the BOARD's workspace, which becomes
    // that document's identity for life, never re-derived from Control's shell scope afterwards.
    const ws = fakeWorkspace();
    const { board } = boardOf([target(ws)]);
    const opened: Array<[string, string]> = [];
    const deps = makeFakeCockpitDeps(board, {
      taskDetail: { getWorkspaces: () => [], openDocument: (wsHash, taskId) => { opened.push([wsHash, taskId]); } },
    });
    await openCockpit(deps, { section: "mission", wsHash: ws.wsHash });
    __createdPanels[0].webview.__receive({ type: "ready" }); // the shell handshake, so a model exists to compare
    await flush();

    __createdPanels[0].webview.__receive({ type: "openTask", id: "t-abc123" });
    await flush();

    expect(opened).toEqual([[ws.wsHash, "t-abc123"]]);
    const models = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model") as Array<{ model: { section: string; activeRoute?: unknown } }>;
    const latest = models.at(-1);
    expect(latest?.model.section).toBe("mission");
    expect(latest?.model.activeRoute, "Control navigated somewhere instead of opening a tab").toBeUndefined();
    expect(__createdPanels, "the Board forked a second Control panel").toHaveLength(1);
  });

  it("openTaskStudio still routes to the injected callback with the resolved workspace (Task Studio isn't migrated yet)", async () => {
    const ws = fakeWorkspace();
    let studio: [WorkspacePresentationTarget, string | undefined] | undefined;
    const { board } = boardOf([target(ws)], {
      openTaskStudio: (w, id) => { studio = [w, id]; },
    });
    await openCockpit(makeFakeCockpitDeps(board), { section: "mission", wsHash: ws.wsHash });

    __createdPanels[0].webview.__receive({ type: "openTaskStudio" });
    __createdPanels[0].webview.__receive({ type: "openTaskStudio", id: "t-abc123" });
    await flush();

    expect(studio?.[0].wsHash).toBe(ws.wsHash);
    expect(studio?.[1]).toBe("t-abc123");
  });

  it("copies a task id through the host clipboard", async () => {
    const ws = fakeWorkspace();
    const { board } = boardOf([target(ws)]);
    await openCockpit(makeFakeCockpitDeps(board), { section: "mission", wsHash: ws.wsHash });

    __createdPanels[0].webview.__receive({ type: "copyTaskId", id: "t-abc123" });
    await flush();

    expect(__getClipboardText()).toBe("t-abc123");
  });

  it("follows the ONE global workspace scope and posts that workspace's snapshot (t-46eb4f)", async () => {
    const wsA = fakeWorkspace(mkroot(), {}, { hash: "ws-a", name: "Alpha" });
    const wsB = fakeWorkspace(mkroot(), {}, { hash: "ws-b", name: "Beta" });
    await wsB.taskStore.create({ title: "beta task", author: "human" });
    const { board } = boardOf([target(wsA), target(wsB)]);
    await openCockpit(makeFakeCockpitDeps(board), { section: "mission", wsHash: "ws-a" });

    // t-46eb4f — the Board no longer has (or needs) a workspace control of its own: the scope is
    // chosen once, in Overview, and the Board renders whatever it is handed.
    __createdPanels[0].webview.__receive({ type: "switchControlWorkspace", wsHash: "ws-b" });
    await flush();

    const latest = snapshots().at(-1);
    expect(latest?.vm).toMatchObject({ folder: "Beta", wsHash: "ws-b" });
    expect(latest?.vm.snapshot.views.map((v) => v.task.title)).toEqual(["beta task"]);
  });
});
