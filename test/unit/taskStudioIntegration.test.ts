import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { TaskDetailStore } from "../../src/tasks/TaskDetailStore.js";
import { TaskAttachmentStore } from "../../src/tasks/TaskAttachmentStore.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import { MissionControlPanelManager } from "../../src/webview/MissionControlPanel.js";
import { legacyMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import { legacyTaskDetailTarget } from "../../src/shell/TaskDetailTarget.js";
import { TaskDetailPanelManager } from "../../src/webview/TaskDetailPanel.js";
import { TaskStudioPanelManager } from "../../src/webview/TaskStudioPanel.js";
import { envelope } from "../../src/webview/shared/studio/protocol.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import type { TaskDetailEntity, TaskPatch } from "../../src/webview/task-studio/domain.js";

/**
 * spec 339 (T7) — the cross-manager integration coverage the spec's acceptance criteria list by name:
 * the board "+ Task" flow end to end (Mission Control -> Task Studio -> back), and attachment add/remove
 * GC exercised through the actual panel Save path (not just TaskDetailStore's own unit tests). Every other
 * named integration case (create-transaction failure cleanup, edit-with-missing-sidecar, CAS vs a concurrent
 * update_task) already lives in taskStudioPanel.test.ts — this file only adds what genuinely needs MULTIPLE
 * wired-together managers, mirroring extension.ts's own wiring.
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-studio-integration-"));
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
    validationStore: new ValidationStore(root),
    config: { agents },
    manager: { list: async () => [] },
  } as unknown as Workspace;
}

/** Wires the three panel managers exactly like extension.ts does. */
function wireManagers(ws: Workspace) {
  let missionControlPanels!: MissionControlPanelManager;
  let taskDetailPanels!: TaskDetailPanelManager;
  let fanOuts = 0;
  const onTasksChanged = () => {
    fanOuts += 1;
    missionControlPanels.refreshAll();
    taskDetailPanels.refreshAll();
    taskStudioPanels.refreshAll();
  };
  const taskStudioPanels = new TaskStudioPanelManager(Uri.file("/ext"), onTasksChanged);
  taskDetailPanels = new TaskDetailPanelManager(
    Uri.file("/ext"),
    () => [legacyTaskDetailTarget(ws)],
    (_target, id) => taskStudioPanels.openExisting(ws, id),
    onTasksChanged,
  );
  missionControlPanels = new MissionControlPanelManager(
    Uri.file("/ext"),
    () => [legacyMissionControlTarget(ws)],
    (_target, id) => taskDetailPanels.open(legacyTaskDetailTarget(ws), id),
    (_target, id) => { if (id) taskStudioPanels.openExisting(ws, id); else taskStudioPanels.openNew(ws); },
    onTasksChanged,
  );
  return { missionControlPanels, taskDetailPanels, taskStudioPanels, fanOuts: () => fanOuts };
}

function settled<T>(fn: () => T): Promise<T> {
  return vi.waitFor(fn, { timeout: 1000, interval: 5 });
}

// the base's load() is await-based (spec 350 T2) — even a synchronous adapter resolves on a microtask tick,
// so the panel's first "load" push arrives one tick after open(); wait for it rather than reading synchronously.
function studioEntityOf(panelIndex: number): Promise<TaskDetailEntity> {
  return settled(() => {
    const posted = __createdPanels[panelIndex].webview.posted.filter((m) => (m as { type?: string }).type === "load") as { entity: TaskDetailEntity }[];
    if (!posted.length) throw new Error("no load message posted yet");
    return posted[posted.length - 1]!.entity;
  });
}

/** the shell's protocol is patch-then-save (not one combined message) — `patch` before `save` mirrors
 *  what App.tsx's continuous patch-sync effect does on every field change. */
function saveVia(panelIndex: number, patch: TaskPatch): void {
  __createdPanels[panelIndex].webview.__receive(envelope({ type: "patch", patch }));
  __createdPanels[panelIndex].webview.__receive(envelope({ type: "save" }));
}

describe("board '+ Task' flow end to end (spec F12/F19)", () => {
  it("board -> openTaskStudio(new) -> Studio Save -> task exists -> board reflects it", async () => {
    const ws = fakeWorkspace();
    const { missionControlPanels, fanOuts } = wireManagers(ws);

    missionControlPanels.open(ws.wsHash);
    expect(__createdPanels).toHaveLength(1);

    // the board's "+ Task" button posts this exact action (mission-control/App.tsx)
    __createdPanels[0].webview.__receive({ type: "openTaskStudio" });
    expect(__createdPanels).toHaveLength(2); // Task Studio opened as a second panel
    const entity = await studioEntityOf(1);
    expect(entity.expectUpdatedAt).toBeUndefined(); // new mode: no task behind this id yet

    saveVia(1, {
      title: "from the board's + Task button",
      deps: [],
      artifact_refs: [],
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
      attachments: [],
      dirty: { title: true },
      docDirty: true,
    });
    const studioPanel = __createdPanels[1];

    await settled(() => expect(ws.taskStore.listRaw()).toHaveLength(1));
    expect(studioPanel.disposed).toBe(true);
    expect(fanOuts()).toBeGreaterThan(0);

    // the board panel got a fresh snapshot reflecting the new inbox card (dueto: "board reveals it")
    const latestSnapshot = await settled(() => {
      const snapshotMsgs = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "snapshot") as Array<{ vm: { snapshot: { views: Array<{ task: { title: string; status: string } }> } } }>;
      const latest = snapshotMsgs[snapshotMsgs.length - 1]?.vm.snapshot;
      if (!latest) throw new Error("no snapshot message posted yet");
      return latest;
    });
    expect(latestSnapshot.views.some((v) => v.task.title === "from the board's + Task button" && v.task.status === "inbox")).toBe(true);
  });

  it("board -> card menu 'Edit in Studio' -> openTaskStudio(id) opens the SAME task, never a duplicate create", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "existing", author: "human" });
    const { missionControlPanels } = wireManagers(ws);
    missionControlPanels.open(ws.wsHash);

    __createdPanels[0].webview.__receive({ type: "openTaskStudio", id: task.id });
    expect(__createdPanels).toHaveLength(2);
    const entity = await studioEntityOf(1);
    expect(entity.expectUpdatedAt).toBe(task.updatedAt); // edit mode: a real, already-loaded task
    expect(entity.taskId).toBe(task.id);
    expect(ws.taskStore.listRaw()).toHaveLength(1); // no accidental second task
  });
});

describe("attachment add/remove GC through the actual Save path (spec F13, T3 exercised end to end)", () => {
  it("removes a blob only after the Save that drops it from the doc, never before", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "b" });
    const attachmentStore = new TaskAttachmentStore(ws.workspaceRoot, task.id);
    const image = attachmentStore.putImage({ data: Buffer.from("screenshot-bytes"), mediaType: "image/png", source: "paste" });

    const { taskStudioPanels } = wireManagers(ws);
    taskStudioPanels.openExisting(ws, task.id);
    const entity = await studioEntityOf(0);

    // first Save: the doc references the image — GC must NOT remove it
    saveVia(0, {
      title: entity.title,
      deps: [],
      artifact_refs: [],
      doc: { type: "doc", content: [{ type: "paragraph" }, { type: "image", attrs: { attachmentId: image.id, alt: "shot" } }] },
      attachments: [image],
      dirty: {},
      docDirty: true,
      expectUpdatedAt: entity.expectUpdatedAt,
    });
    await settled(() => expect(new TaskDetailStore(ws.workspaceRoot).read(task.id).status).toBe("ok"));
    expect(fs.existsSync(attachmentStore.blobPath(image.blobRef))).toBe(true);
    expect(__createdPanels[0].disposed).toBe(true); // a successful edit Save closes the panel (pin-studio convention)

    // re-open (a fresh panel, since the first one disposed) for a second Save that drops the image entirely
    taskStudioPanels.openExisting(ws, task.id);
    const entity2 = await studioEntityOf(1);

    saveVia(1, {
      title: entity2.title,
      deps: [],
      artifact_refs: [],
      doc: { type: "doc", content: [{ type: "paragraph" }] },
      attachments: [],
      dirty: {},
      docDirty: true,
      expectUpdatedAt: entity2.expectUpdatedAt,
    });

    await settled(() => expect(fs.existsSync(attachmentStore.blobPath(image.blobRef))).toBe(false));
    const finalDetail = new TaskDetailStore(ws.workspaceRoot).read(task.id);
    expect(finalDetail.status).toBe("ok");
    if (finalDetail.status === "ok") expect(finalDetail.detail.attachments).toEqual([]);
  });
});

describe("imported Task Studio body save regression", () => {
  it("persists an edited reimported body even when Save is clicked before the continuous patch sync catches up", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "imported", author: "human", body: "Original body" });
    const updateSpy = vi.spyOn(ws.taskStore, "update");
    const { taskStudioPanels } = wireManagers(ws);

    taskStudioPanels.openExisting(ws, task.id);
    const entity = await studioEntityOf(0);
    expect(entity.anchor).toBe("reimport");
    expect(new TaskDetailStore(ws.workspaceRoot).read(task.id).status).toBe("missing");

    const stalePatch: TaskPatch = {
      title: entity.title,
      deps: [],
      artifact_refs: [],
      doc: entity.doc,
      attachments: [],
      bodyBaseline: entity.bodyBaseline,
      dirty: {},
      docDirty: false,
      expectUpdatedAt: entity.expectUpdatedAt,
    };
    __createdPanels[0].webview.__receive(envelope({ type: "patch", patch: stalePatch }));

    const editedPatch: TaskPatch = {
      ...stalePatch,
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Original body Teste de edicao" }] }] },
      docDirty: true,
    };
    __createdPanels[0].webview.__receive(envelope({ type: "save", patch: editedPatch }));

    await settled(() => expect(__createdPanels[0].disposed).toBe(true));
    expect(updateSpy).toHaveBeenCalledWith(task.id, expect.objectContaining({ body: "Original body Teste de edicao" }));
    expect(ws.taskStore.get(task.id).body).toBe("Original body Teste de edicao");
  });
});
