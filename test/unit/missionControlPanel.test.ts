import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import { __createdPanels, __getClipboardText, __resetVscodeMock } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import { MISSION_CONTROL_AGENT_LIST_TIMEOUT_MS, MissionControlPanelManager } from "../../src/webview/MissionControlPanel.js";
import { legacyMissionControlTarget, type WorkspaceMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
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

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeWorkspace(root = mkroot(), agents: Record<string, unknown> = {}, opts: { hash?: string; name?: string; managedEntries?: Array<{ name: string; running?: boolean; declared?: boolean; kind?: "agent" | "terminal" }> } = {}) {
  return {
    wsHash: opts.hash ?? "ws-1",
    folderName: opts.name ?? "Project",
    workspaceRoot: root,
    taskStore: new TaskStore(root),
    validationStore: new ValidationStore(root),
    config: { agents },
    manager: {
      list: async () => (opts.managedEntries ?? []).map((a) => ({
        session: `tachyon-test-${a.name}`,
        dead: false,
        crashed: false,
        ...a,
        running: a.running ?? true,
        declared: a.declared ?? false,
        kind: a.kind ?? "agent",
      })),
    },
  } as unknown as Workspace;
}

const target = (workspace: Workspace): WorkspaceMissionControlTarget => legacyMissionControlTarget(workspace);

describe("MissionControlPanelManager", () => {
  it("reveals an existing panel per workspace instead of opening a second one", () => {
    const ws = fakeWorkspace();
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(ws)], () => {}, () => {}, () => {});
    manager.open(ws.wsHash);
    manager.open(ws.wsHash);
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
  });

  it("posts a snapshot with declared agents + human + relevant ad-hoc chips on open", async () => {
    const ws = fakeWorkspace(undefined, { codex: {} }, { managedEntries: [{ name: "codex", declared: true }, { name: "live-ad-hoc" }] });
    const t = await ws.taskStore.create({ title: "seed", author: "human" });
    await ws.taskStore.update(t.id, { status: "triaged", assignee: "open-ad-hoc" });
    const done = await ws.taskStore.create({ title: "done", author: "human" });
    await ws.taskStore.update(done.id, { status: "triaged", assignee: "dead-ad-hoc" });
    await ws.taskStore.update(done.id, { status: "active" });
    await ws.taskStore.update(done.id, { status: "done" });
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(ws)], () => {}, () => {}, () => {});

    manager.open(ws.wsHash);
    await flush();

    const msg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "snapshot") as { vm: { agentLiveness?: { status: string }; snapshot: { chips: Array<{ agent: string }> } } };
    expect(msg.vm.snapshot.chips.map((c) => c.agent)).toEqual(["codex", "human", "live-ad-hoc", "open-ad-hoc"]);
    expect("liveAgents" in msg.vm.snapshot).toBe(false);
    expect(msg.vm).toMatchObject({ agentLiveness: { status: "available" } });
  });

  it("falls back to task data when agent listing rejects, including after the timeout", async () => {
    vi.useFakeTimers();
    try {
      let rejectList!: (reason: Error) => void;
      const ws = fakeWorkspace();
      ws.manager.list = () => new Promise((_, reject) => { rejectList = reject; });
      await ws.taskStore.create({ title: "task store survives", author: "human" });
      const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(ws)], () => {}, () => {}, () => {});

      manager.open(ws.wsHash);
      await vi.advanceTimersByTimeAsync(MISSION_CONTROL_AGENT_LIST_TIMEOUT_MS);
      rejectList(new Error("late tmux failure"));
      await Promise.resolve();

      const messages = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "snapshot");
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        vm: {
          agentLiveness: { status: "unavailable" },
          snapshot: { views: [{ task: { title: "task store survives" } }] },
        },
      });
      expect(vi.getTimerCount()).toBe(0);
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces refreshes and runs exactly one trailing retry after a timed-out list settles", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<Awaited<ReturnType<Workspace["manager"]["list"]>>>();
      const ws = fakeWorkspace();
      ws.manager.list = vi.fn()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValueOnce([]);
      const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(ws)], () => {}, () => {}, () => {});

      manager.open(ws.wsHash);
      __createdPanels[0].webview.__receive({ type: "requestSnapshot" });
      __createdPanels[0].webview.__receive({ type: "requestSnapshot" });
      manager.refreshAll();
      await Promise.resolve();

      expect(ws.manager.list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(MISSION_CONTROL_AGENT_LIST_TIMEOUT_MS);
      const snapshots = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "snapshot");
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ vm: { agentLiveness: { status: "unavailable" } } });

      manager.refreshAll();
      manager.refreshAll();
      await Promise.resolve();
      expect(ws.manager.list).toHaveBeenCalledTimes(1);

      pending.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(ws.manager.list).toHaveBeenCalledTimes(2);
      const recovered = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "snapshot");
      expect(recovered.filter((m) => (m as { vm?: { agentLiveness?: { status?: string } } }).vm?.agentLiveness?.status === "available")).toHaveLength(1);
      expect(recovered.at(-1)).toMatchObject({ vm: { agentLiveness: { status: "available" } } });
      expect(vi.getTimerCount()).toBe(0);
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("posts workspace selector options even when there is only one workspace", async () => {
    const ws = fakeWorkspace();
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(ws)], () => {}, () => {}, () => {});

    manager.open(ws.wsHash);
    await flush();

    const msg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "snapshot") as { vm: { wsHash: string; workspaces: Array<{ hash: string; folder: string }> } };
    expect(msg.vm.wsHash).toBe("ws-1");
    expect(msg.vm.workspaces).toEqual([{ hash: "ws-1", folder: "Project" }]);
  });

  it("switches the existing panel to another workspace and posts that workspace's snapshot", async () => {
    const wsA = fakeWorkspace(mkroot(), {}, { hash: "ws-a", name: "Alpha" });
    const wsB = fakeWorkspace(mkroot(), {}, { hash: "ws-b", name: "Beta" });
    await wsB.taskStore.create({ title: "beta task", author: "human" });
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(wsA), target(wsB)], () => {}, () => {}, () => {});
    manager.open(wsA.wsHash);

    __createdPanels[0].webview.__receive({ type: "switchWorkspace", wsHash: "ws-b" });
    await flush();

    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].title).toBe("Mission Control — Beta");
    const snapshots = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "snapshot") as Array<{ vm: { folder: string; wsHash: string; snapshot: { views: Array<{ task: { title: string } }> } } }>;
    const latest = snapshots[snapshots.length - 1];
    expect(latest?.vm).toMatchObject({ folder: "Beta", wsHash: "ws-b" });
    expect(latest?.vm.snapshot.views.map((v) => v.task.title)).toEqual(["beta task"]);
  });

  it("never lets an old workspace timeout overwrite a recovered switched workspace", async () => {
    vi.useFakeTimers();
    try {
      const oldList = deferred<Awaited<ReturnType<Workspace["manager"]["list"]>>>();
      const wsA = fakeWorkspace(mkroot(), {}, { hash: "ws-a", name: "Alpha" });
      const wsB = fakeWorkspace(mkroot(), {}, { hash: "ws-b", name: "Beta" });
      wsA.manager.list = vi.fn(() => oldList.promise);
      wsB.manager.list = vi.fn(async () => []);
      await wsB.taskStore.create({ title: "newest beta snapshot", author: "human" });
      const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(wsA), target(wsB)], () => {}, () => {}, () => {});

      manager.open(wsA.wsHash);
      __createdPanels[0].webview.__receive({ type: "switchWorkspace", wsHash: wsB.wsHash });
      await Promise.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(MISSION_CONTROL_AGENT_LIST_TIMEOUT_MS);
      oldList.reject(new Error("late Alpha failure"));
      await Promise.resolve();

      const snapshots = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "snapshot") as Array<{ vm: { wsHash: string; agentLiveness: { status: string }; snapshot: { views: Array<{ task: { title: string } }> } } }>;
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.vm).toMatchObject({
        wsHash: "ws-b",
        agentLiveness: { status: "available" },
        snapshot: { views: [{ task: { title: "newest beta snapshot" } }] },
      });
      expect(wsA.manager.list).toHaveBeenCalledTimes(1);
      expect(wsB.manager.list).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reveals an already-open target workspace panel instead of duplicating it", () => {
    const wsA = fakeWorkspace(mkroot(), {}, { hash: "ws-a", name: "Alpha" });
    const wsB = fakeWorkspace(mkroot(), {}, { hash: "ws-b", name: "Beta" });
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(wsA), target(wsB)], () => {}, () => {}, () => {});
    manager.open(wsA.wsHash);
    manager.open(wsB.wsHash);

    __createdPanels[0].webview.__receive({ type: "switchWorkspace", wsHash: "ws-b" });

    expect(__createdPanels).toHaveLength(2);
    expect(__createdPanels[1].revealCount).toBe(1);
    expect(__createdPanels[0].title).toBe("Mission Control — Alpha");
  });

  it("posts validation counts in the Mission Control snapshot", async () => {
    const ws = fakeWorkspace();
    await ws.validationStore.create({ title: "Manual dogfood", author: "human", executor: "human" });
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(ws)], () => {}, () => {}, () => {});

    manager.open(ws.wsHash);
    await flush();

    const msg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "snapshot") as { vm: { snapshot: { validations?: { pendingCount: number; humanPendingCount: number } } } };
    expect(msg.vm.snapshot.validations).toMatchObject({ pendingCount: 1, humanPendingCount: 1 });
  });

  it("closes a validation from Mission Control only with an auditable note", async () => {
    const ws = fakeWorkspace();
    const validation = await ws.validationStore.create({ title: "Manual dogfood", author: "human", executor: "human" });
    let fanOuts = 0;
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(ws)], () => {}, () => {}, () => { fanOuts += 1; });
    manager.open(ws.wsHash);

    __createdPanels[0].webview.__receive({ type: "closeValidation", id: validation.id, outcome: "passed", result_note: "Checked installed VSIX manually" });
    await new Promise((r) => setTimeout(r, 0));

    expect(ws.validationStore.get(validation.id)).toMatchObject({ status: "closed", rounds: [{ outcome: "passed", result_note: "Checked installed VSIX manually" }] });
    expect(fanOuts).toBe(1);
  });

  // spec 339 — the board's former inline quick-add (createTask/CreateForm) is gone; "+ Task" and the card
  // context menu's "Edit in Studio" both route through this SAME openTaskStudio delegation instead (the
  // Studio itself, via TaskStudioPanelManager, is what now enforces author:"human" on create — panel tests
  // for THAT live in taskStudioPanel.test.ts). This test replaces the old "applies a create-from-board
  // action..." case per tasks.md's "spec-335 quick-add tests are UPDATED to cover the new path, not deleted."
  it("routes openTaskStudio (new-task, no id) to the injected callback", () => {
    const ws = fakeWorkspace();
    let opened: [WorkspaceMissionControlTarget, string | undefined] | undefined;
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(ws)], () => {}, (w, id) => { opened = [w, id]; }, () => {});
    manager.open(ws.wsHash);

    __createdPanels[0].webview.__receive({ type: "openTaskStudio" });
    expect(opened?.[0].wsHash).toBe(ws.wsHash);
    expect(opened?.[1]).toBeUndefined();
  });

  it("routes openTaskStudio (edit, with id) to the injected callback — the card menu's 'Edit in Studio'", () => {
    const ws = fakeWorkspace();
    let opened: [WorkspaceMissionControlTarget, string | undefined] | undefined;
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(ws)], () => {}, (w, id) => { opened = [w, id]; }, () => {});
    manager.open(ws.wsHash);

    __createdPanels[0].webview.__receive({ type: "openTaskStudio", id: "t-abc123" });
    expect(opened?.[0].wsHash).toBe(ws.wsHash);
    expect(opened?.[1]).toBe("t-abc123");
  });

  it("applies a status-transition update and re-posts a fresh snapshot", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "flow", author: "human" });
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(ws)], () => {}, () => {}, () => {});
    manager.open(ws.wsHash);

    __createdPanels[0].webview.__receive({ type: "updateTask", id: t.id, patch: { status: "triaged" } });
    await new Promise((r) => setTimeout(r, 0));

    expect(ws.taskStore.get(t.id).status).toBe("triaged");
  });

  it("posts a taskError (no throw) when a drop is rejected by the store — the board never optimistically moved the card", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "gate", author: "human" });
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(ws)], () => {}, () => {}, () => {});
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
    let opened: [WorkspaceMissionControlTarget, string] | undefined;
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(ws)], (w, id) => { opened = [w, id]; }, () => {}, () => {});
    manager.open(ws.wsHash);

    __createdPanels[0].webview.__receive({ type: "openTask", id: "t-abc123" });
    expect(opened?.[1]).toBe("t-abc123");
    expect(opened?.[0].wsHash).toBe(ws.wsHash);
  });

  it("copies a task id through the host clipboard", async () => {
    const ws = fakeWorkspace();
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(ws)], () => {}, () => {}, () => {});
    manager.open(ws.wsHash);

    __createdPanels[0].webview.__receive({ type: "copyTaskId", id: "t-abc123" });
    await new Promise((r) => setTimeout(r, 0));

    expect(__getClipboardText()).toBe("t-abc123");
  });

  it("calls the shared onTasksChanged fan-out (not a local closure) after a successful update — dogfood #1", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "flow", author: "human" });
    let fanOuts = 0;
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(ws)], () => {}, () => {}, () => { fanOuts += 1; });
    manager.open(ws.wsHash);

    __createdPanels[0].webview.__receive({ type: "updateTask", id: t.id, patch: { status: "triaged" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(fanOuts).toBe(1);
  });

  it("does not call onTasksChanged when a mutation is rejected by the store", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "gate", author: "human" });
    let fanOuts = 0;
    const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [target(ws)], () => {}, () => {}, () => { fanOuts += 1; });
    manager.open(ws.wsHash);

    __createdPanels[0].webview.__receive({ type: "updateTask", id: t.id, patch: { status: "done" } });
    await new Promise((r) => setTimeout(r, 0));

    expect(fanOuts).toBe(0);
  });
});
