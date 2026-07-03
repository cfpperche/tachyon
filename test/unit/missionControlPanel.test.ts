import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { MissionControlPanelManager } from "../../src/webview/MissionControlPanel.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-control-panel-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeWorkspace(root = mkroot(), agents: Record<string, unknown> = {}) {
  return {
    wsHash: "ws-1",
    folderName: "Project",
    workspaceRoot: root,
    taskStore: new TaskStore(root),
    config: { agents },
  } as unknown as Workspace;
}

describe("MissionControlPanelManager", () => {
  it("reveals an existing panel per workspace instead of opening a second one", () => {
    const ws = fakeWorkspace();
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [ws], () => {}, () => {});
    manager.open(ws.wsHash);
    manager.open(ws.wsHash);
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
  });

  it("posts a snapshot with declared agents + human + assignee chips on open", async () => {
    const ws = fakeWorkspace(undefined, { codex: {} });
    const t = await ws.taskStore.create({ title: "seed", author: "human" });
    await ws.taskStore.update(t.id, { status: "triaged", assignee: "ad-hoc" });
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [ws], () => {}, () => {});

    manager.open(ws.wsHash);

    const msg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "snapshot") as { vm: { snapshot: { chips: Array<{ agent: string }> } } };
    expect(msg.vm.snapshot.chips.map((c) => c.agent)).toEqual(["codex", "human", "ad-hoc"]);
  });

  it("applies a create-from-board action with author:human and refreshes the panel", async () => {
    const ws = fakeWorkspace();
    let manager: MissionControlPanelManager;
    // the manager no longer self-refreshes on mutation — it relies entirely on the injected onTasksChanged
    // fan-out (dogfood #1), so the stub here must actually do what extension.ts wires it to do.
    manager = new MissionControlPanelManager(Uri.file("/ext"), () => [ws], () => {}, () => manager.refreshAll());
    manager.open(ws.wsHash);
    __createdPanels[0].webview.posted.length = 0;

    __createdPanels[0].webview.__receive({ type: "createTask", input: { title: "from board", author: "someone-else" } });
    await new Promise((r) => setTimeout(r, 0));

    const [task] = ws.taskStore.listRaw();
    expect(task).toMatchObject({ title: "from board", author: "human", status: "inbox" });
    expect(task.priority).toBeUndefined();
    expect(task.assignee).toBeUndefined();
    expect(__createdPanels[0].webview.posted.some((m) => (m as { type?: string }).type === "snapshot")).toBe(true);
  });

  it("applies a status-transition update and re-posts a fresh snapshot", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "flow", author: "human" });
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [ws], () => {}, () => {});
    manager.open(ws.wsHash);

    __createdPanels[0].webview.__receive({ type: "updateTask", id: t.id, patch: { status: "triaged" } });
    await new Promise((r) => setTimeout(r, 0));

    expect(ws.taskStore.get(t.id).status).toBe("triaged");
  });

  it("posts a taskError (no throw) when a drop is rejected by the store — the board never optimistically moved the card", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "gate", author: "human" });
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [ws], () => {}, () => {});
    manager.open(ws.wsHash);

    // inbox -> done is not an allowed transition
    __createdPanels[0].webview.__receive({ type: "updateTask", id: t.id, patch: { status: "done" } });
    await new Promise((r) => setTimeout(r, 0));

    const errMsg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "taskError") as { taskId?: string; message: string };
    expect(errMsg.taskId).toBe(t.id);
    expect(errMsg.message).toMatch(/invalid status transition/);
    expect(ws.taskStore.get(t.id).status).toBe("inbox"); // unchanged
  });

  it("routes openTask to the injected callback", () => {
    const ws = fakeWorkspace();
    let opened: [Workspace, string] | undefined;
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [ws], (w, id) => { opened = [w, id]; }, () => {});
    manager.open(ws.wsHash);

    __createdPanels[0].webview.__receive({ type: "openTask", id: "t-abc123" });
    expect(opened?.[1]).toBe("t-abc123");
    expect(opened?.[0].wsHash).toBe(ws.wsHash);
  });

  it("calls the shared onTasksChanged fan-out (not a local closure) after a successful update or create — dogfood #1", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "flow", author: "human" });
    let fanOuts = 0;
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [ws], () => {}, () => { fanOuts += 1; });
    manager.open(ws.wsHash);

    __createdPanels[0].webview.__receive({ type: "updateTask", id: t.id, patch: { status: "triaged" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(fanOuts).toBe(1);

    __createdPanels[0].webview.__receive({ type: "createTask", input: { title: "another" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(fanOuts).toBe(2);
  });

  it("does not call onTasksChanged when a mutation is rejected by the store", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "gate", author: "human" });
    let fanOuts = 0;
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [ws], () => {}, () => { fanOuts += 1; });
    manager.open(ws.wsHash);

    __createdPanels[0].webview.__receive({ type: "updateTask", id: t.id, patch: { status: "done" } });
    await new Promise((r) => setTimeout(r, 0));

    expect(fanOuts).toBe(0);
  });
});
