import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { TaskAttachmentStore } from "../../src/tasks/TaskAttachmentStore.js";
import { TaskDetailStore, hashBody } from "../../src/tasks/TaskDetailStore.js";
import { TaskPrototypeStore } from "../../src/tasks/TaskPrototypeStore.js";
import { openCockpit, type CockpitMissionBoard, type CockpitTaskDetail } from "../../src/webview/Cockpit.js";
import { legacyTaskDetailTarget, type WorkspaceTaskDetailTarget } from "../../src/shell/TaskDetailTarget.js";
import { legacyMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import { makeFakeCockpitDeps } from "../mocks/cockpitDeps.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

/**
 * t-610705 (SDD 410 Phase C.1) — Task Detail ROUTING coverage for Control → mission/task/<id>,
 * ported from the retired TaskDetailPanelManager's tests: the standalone panel is gone (`open()` was
 * already fully unreachable in production before this — see TaskDetailPanel.ts's retirement note),
 * so the cockpit host is now the one path for every detail action (updateTask/prototype review/
 * openTask/openTaskStudio) and must keep the same behavior contract (CAS enforcement, the tombstone
 * fallback on load failure — dueto F8 — and no cross-navigation staleness).
 *
 * A few panel-era tests don't port 1:1 because the premise changed: there is no longer a per-task
 * panel to "dispose" or "keep open independent of a board filter" — Control is a single active
 * route, not a Map of tabs. Those are dropped rather than faked.
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-task-detail-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeWorkspace(root = mkroot(), opts: { hash?: string; name?: string } = {}) {
  return {
    wsHash: opts.hash ?? "ws-1",
    folderName: opts.name ?? "Project",
    workspaceRoot: root,
    taskStore: new TaskStore(root),
  } as unknown as Workspace;
}

const detailTarget = (workspace: Workspace): WorkspaceTaskDetailTarget => legacyTaskDetailTarget(workspace);

function depsFor(ws: Workspace, hooks: Partial<CockpitMissionBoard> = {}): { deps: ReturnType<typeof makeFakeCockpitDeps>; fanOuts: () => number } {
  let fanOuts = 0;
  const missionBoard: CockpitMissionBoard = {
    getWorkspaces: () => [legacyMissionControlTarget(ws)],
    openTaskStudio: () => {},
    onTasksChanged: () => { fanOuts += 1; },
    ...hooks,
  };
  const taskDetail: CockpitTaskDetail = { getWorkspaces: () => [detailTarget(ws)] };
  return { deps: makeFakeCockpitDeps(missionBoard, { taskDetail }), fanOuts: () => fanOuts };
}

async function openTaskDetail(ws: Workspace, taskId: string, hooks: Partial<CockpitMissionBoard> = {}) {
  const { deps, fanOuts } = depsFor(ws, hooks);
  await openCockpit(deps, { route: { kind: "task-detail", wsHash: ws.wsHash, taskId } });
  __createdPanels[0].webview.__receive({ type: "requestSnapshot" });
  await flush();
  return { fanOuts };
}

const taskMessages = () => __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "task") as Array<{ vm: { tombstone: boolean; task?: { title: string; body?: string; status: string }; journal: unknown[]; deps: unknown[] } }>;

describe("Control → task-detail routing", () => {
  it("posts the task VM on requestSnapshot, resolving deps to linked task title/status", async () => {
    const ws = fakeWorkspace();
    const dep = await ws.taskStore.create({ title: "dependency", author: "human" });
    const t = await ws.taskStore.create({ title: "root", author: "human", deps: [dep.id, "t-ffffff"] });
    await openTaskDetail(ws, t.id);

    const vm = taskMessages().at(-1)?.vm;
    expect(vm?.tombstone).toBe(false);
    expect(vm?.deps).toContainEqual({ id: dep.id, title: "dependency", status: "inbox", missing: false });
    expect(vm?.deps).toContainEqual({ id: "t-ffffff", missing: true });
  });

  it("applies a quick-control update through the CAS expect and fans out (t-d16a39 shared fan-out)", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "edit me", author: "human" });
    await ws.taskStore.update(t.id, { status: "triaged" });
    const { fanOuts } = await openTaskDetail(ws, t.id);
    const startUpdatedAt = ws.taskStore.get(t.id).updatedAt;

    __createdPanels[0].webview.__receive({ type: "updateTask", patch: { assignee: "codex", expect: { updatedAt: startUpdatedAt } } });
    await flush();

    expect(ws.taskStore.get(t.id).assignee).toBe("codex");
    expect(fanOuts()).toBe(1);
  });

  it("surfaces a CAS failure as taskError without corrupting the task", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "stale edit", author: "human" });
    await openTaskDetail(ws, t.id);

    __createdPanels[0].webview.__receive({ type: "updateTask", patch: { priority: 1, expect: { updatedAt: "2000-01-01T00:00:00.000Z" } } });
    await flush();

    const errMsg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "taskError") as { message: string };
    expect(errMsg.message).toMatch(/precondition-failed/);
    expect(ws.taskStore.get(t.id).title).toBe("stale edit");
    expect(ws.taskStore.get(t.id).priority).toBeUndefined();
  });

  it("t-4d59d3: navigating into task-detail NEVER reassigns webview.options on the live panel", async () => {
    // Reassigning options on a live panel makes VS Code recreate the webview's inner iframe, and
    // that reload wedged at the fake.html placeholder — the whole Control surface went permanently
    // blank the moment a Board card was clicked (reproduced headlessly, iframe stuck at fake.html).
    // Every resource root is granted once at creation instead; reference identity proves no
    // later assignment happened.
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "no reload", author: "human" });
    const { deps } = depsFor(ws);
    await openCockpit(deps, { section: "mission" });
    const optionsAtCreation = __createdPanels[0].webview.options;
    expect(optionsAtCreation).toBeDefined();

    // in-place navigate into the task (the Board card click path) + full detail load
    __createdPanels[0].webview.__receive({ type: "openTask", id: t.id });
    await flush();
    __createdPanels[0].webview.__receive({ type: "requestSnapshot" });
    await flush();

    expect(taskMessages().at(-1)?.vm.task?.title).toBe("no reload");
    expect(__createdPanels[0].webview.options).toBe(optionsAtCreation);
  });

  it("t-4d59d3: the creation grant covers every task's blob dir via the workspace attachments parent", async () => {
    const ws = fakeWorkspace();
    const { deps } = depsFor(ws);
    await openCockpit(deps, { section: "mission" });
    const roots = (__createdPanels[0].webview.options as { localResourceRoots?: Array<{ fsPath?: string; path?: string }> }).localResourceRoots ?? [];
    const rootPaths = roots.map((r) => String(r.fsPath ?? r.path ?? r));
    expect(rootPaths.some((p) => p.includes(path.join(".tachyon", "tasks", "attachments")))).toBe(true);
  });

  it("renders a tombstone from the last-known state when the task file disappears (dueto F8) — the route stays open", async () => {
    const root = mkroot();
    const ws = fakeWorkspace(root);
    const t = await ws.taskStore.create({ title: "vanishing", author: "human" });
    await openTaskDetail(ws, t.id);
    expect(taskMessages().at(-1)?.vm.tombstone).toBe(false);

    fs.rmSync(ws.taskStore.pathFor(t.id));
    __createdPanels[0].webview.__receive({ type: "requestSnapshot" });
    await flush();

    expect(__createdPanels[0].disposed).toBe(false);
    const vm = taskMessages().at(-1)?.vm;
    expect(vm?.tombstone).toBe(true);
    expect(vm?.task?.title).toBe("vanishing"); // last known state, not blank
  });

  it("never lets an older remote response overwrite a newer refresh (navEpoch, t-610705 Phase C.0 mechanism)", async () => {
    // navEpoch only bumps on an actual route change (navigate()), not on a same-route refresh — see
    // cockpitRouter.test.ts's "navigation epoch" describe block for the established contract. So the
    // superseding event here is an in-place `openTask` navigate (still task-detail, different task
    // id), not a second requestSnapshot on the unchanged route.
    const root = mkroot();
    const t = await (new TaskStore(root)).create({ title: "seed", author: "human" }); // pathFor plumbing only
    let resolveStale!: (v: unknown) => void;
    let calls = 0;
    const stalePromise = new Promise((res) => { resolveStale = res; });
    const target: WorkspaceTaskDetailTarget = {
      workspaceRoot: root,
      wsHash: "ws-remote",
      folderName: "Remote",
      loadTaskDetail: async (taskId: string) => {
        calls += 1;
        if (calls === 1) return stalePromise as never; // the FIRST call (below) never resolves on its own
        return { schemaVersion: 1, task: { id: taskId, title: "fresh", status: "inbox" as const, author: "human", createdAt: t.createdAt, updatedAt: t.updatedAt }, journal: [], deps: [], imageAttachments: [], prototypes: { readOnly: false, prototypes: [] } };
      },
      updateTask: async () => {},
      reviewPrototype: async () => {},
      attachmentBlobRoot: () => root,
      attachmentsRoot: () => root,
      attachmentBlobPath: () => root,
      prototypeHtml: () => { throw new Error("no prototype"); },
    };
    const missionBoard: CockpitMissionBoard = { getWorkspaces: () => [], openTaskStudio: () => {}, onTasksChanged: () => {} };
    const deps = makeFakeCockpitDeps(missionBoard, { taskDetail: { getWorkspaces: () => [target] } });
    await openCockpit(deps, { route: { kind: "task-detail", wsHash: "ws-remote", taskId: t.id } });

    __createdPanels[0].webview.__receive({ type: "requestSnapshot" }); // wedges on the stale promise
    await flush();
    __createdPanels[0].webview.__receive({ type: "openTask", id: "t-second" }); // in-place navigate, bumps navEpoch
    await flush();

    const staleTitleTask = {
      schemaVersion: 1 as const, task: { id: t.id, title: "stale", status: "inbox" as const, author: "human", createdAt: t.createdAt, updatedAt: t.updatedAt },
      journal: [], deps: [], imageAttachments: [], prototypes: { readOnly: false as const, prototypes: [] },
    };
    resolveStale(staleTitleTask); // the wedged FIRST call finally settles — its epoch is now stale
    await flush();
    await flush();

    const vm = taskMessages().at(-1)?.vm;
    expect(vm?.task?.title).toBe("fresh");
  });

  it("routes openTask (a related/dependent task link) to an in-place navigate, same workspace", async () => {
    const ws = fakeWorkspace();
    const a = await ws.taskStore.create({ title: "a", author: "human" });
    const b = await ws.taskStore.create({ title: "b", author: "human" });
    await openTaskDetail(ws, a.id);

    __createdPanels[0].webview.__receive({ type: "openTask", id: b.id });
    __createdPanels[0].webview.__receive({ type: "requestSnapshot" });
    await flush();

    expect(taskMessages().at(-1)?.vm.task?.title).toBe("b");
    expect(__createdPanels).toHaveLength(1); // in place — no second panel
  });

  it("routes openTaskStudio to the injected callback for the CURRENT route's task", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "x", author: "human" });
    let opened: [{ wsHash: string }, string | undefined] | undefined;
    await openTaskDetail(ws, t.id, { openTaskStudio: (w, id) => { opened = [w, id]; } });

    __createdPanels[0].webview.__receive({ type: "openTaskStudio" });
    await flush();

    expect(opened?.[0].wsHash).toBe(ws.wsHash);
    expect(opened?.[1]).toBe(t.id);
  });

  it("resolves an attachment: ref in the body to a webview-displayable URI (dogfood round 1 #5)", async () => {
    const root = mkroot();
    const ws = fakeWorkspace(root);
    const t = await ws.taskStore.create({ title: "with screenshot", author: "human" });
    const attStore = new TaskAttachmentStore(root, t.id);
    const att = attStore.putImage({ data: Buffer.from("png bytes"), mediaType: "image/png", name: "shot.png", source: "paste" });
    const body = `see ![shot](attachment:${att.id})`;
    // the resolved-attachment list comes from the task's own detail sidecar (Studio's doc), not the
    // markdown body directly — mirrors how TaskDetailPanelManager's port test set this up (spec 339).
    new TaskDetailStore(root).write({
      schemaVersion: 1,
      taskId: t.id,
      doc: { type: "doc", content: [] },
      attachments: [att],
      bodyHash: hashBody(body),
      taskUpdatedAt: t.updatedAt,
    });
    await ws.taskStore.update(t.id, { body });

    await openTaskDetail(ws, t.id);

    const resolvedBody = taskMessages().at(-1)?.vm.task?.body ?? "";
    expect(resolvedBody).not.toContain(`attachment:${att.id}`);
    expect(resolvedBody).toContain(attStore.blobPath(att.blobRef));
  });

  it("materializes the append-only journal into the detail VM", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "with notes", author: "human" });
    ws.taskStore.journal.append(t.id, { author: "codex", text: "note" });

    await openTaskDetail(ws, t.id);

    expect(taskMessages().at(-1)?.vm.journal).toEqual([expect.objectContaining({ author: "codex", text: "note" })]);
  });

  it("approves through first-party chrome and clears only an exact matching prototype subject", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "decision", author: "human", now: "2026-01-01T00:00:00.000Z" });
    const store = new TaskPrototypeStore(ws.workspaceRoot, task.id);
    const snapshot = store.createDraft({ html: "<button>Proposal</button>", title: "Proposal", author: "agent", now: "2026-01-01T00:00:01.000Z" });
    const draft = snapshot.prototypes[0]!;
    await ws.taskStore.update(task.id, { awaitingHuman: { reason: "Review", kind: "decision", since: "2026-01-01T00:00:02.000Z", subject: { type: "task-prototype", prototypeId: draft.id } }, now: "2026-01-01T00:00:02.000Z" });
    await openTaskDetail(ws, task.id);

    __createdPanels[0].webview.__receive({ type: "approvePrototype", prototypeId: draft.id, expectUpdatedAt: snapshot.updatedAt, review: "Ship this layout" });
    await flush();

    expect(store.read().approved).toMatchObject({ id: draft.id, state: "approved", approvedBy: "human" });
    expect(ws.taskStore.get(task.id).awaitingHuman).toBeUndefined();
  });

  it("does not clear a mismatched awaitingHuman prototype subject", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "decision", author: "human", now: "2026-01-01T00:00:00.000Z" });
    const store = new TaskPrototypeStore(ws.workspaceRoot, task.id);
    const first = store.createDraft({ html: "<p>One</p>", title: "One", author: "agent", now: "2026-01-01T00:00:01.000Z" });
    const second = store.createDraft({ html: "<p>Two</p>", title: "Two", author: "agent", now: "2026-01-01T00:00:02.000Z" });
    await ws.taskStore.update(task.id, { awaitingHuman: { reason: "Review one", kind: "decision", since: "2026-01-01T00:00:03.000Z", subject: { type: "task-prototype", prototypeId: first.prototypes[0]!.id } }, now: "2026-01-01T00:00:03.000Z" });
    await openTaskDetail(ws, task.id);

    __createdPanels[0].webview.__receive({ type: "approvePrototype", prototypeId: second.prototypes.at(-1)!.id, expectUpdatedAt: second.updatedAt });
    await flush();

    expect(ws.taskStore.get(task.id).awaitingHuman?.subject?.prototypeId).toBe(first.prototypes[0]!.id);
  });
});
