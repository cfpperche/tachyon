import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { TaskDetailStore, hashBody } from "../../src/tasks/TaskDetailStore.js";
import { TaskAttachmentStore } from "../../src/tasks/TaskAttachmentStore.js";
import { legacyTaskStudioTarget } from "../../src/shell/TaskStudioTarget.js";
import { TaskStudioPanelManager } from "../../src/webview/TaskStudioPanel.js";
import { envelope } from "../../src/webview/shared/studio/protocol.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import type { TaskDetailEntity, TaskPatch } from "../../src/webview/task-studio/domain.js";

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-studio-panel-"));
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

function studioTarget(ws: Workspace) {
  return legacyTaskStudioTarget(ws);
}

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

/** the host's message handling is async (TaskStore's own mutation queue, and the base's load() is
 *  await-based per spec 350 T2); poll instead of a fixed delay so this suite doesn't flake on how many
 *  microtask hops a given load/save path happens to need. */
function settled<T>(fn: () => T): Promise<T> {
  return vi.waitFor(fn, { timeout: 1000, interval: 5 });
}

function entityOf(panelIndex = 0): Promise<TaskDetailEntity> {
  return settled(() => {
    const posted = __createdPanels[panelIndex].webview.posted.filter((m) => (m as { type?: string }).type === "load") as { entity: TaskDetailEntity }[];
    if (!posted.length) throw new Error("no load message posted yet");
    return posted[posted.length - 1]!.entity;
  });
}

/** the shell's protocol is patch-then-save (not one combined message, spec 350 T2) — `patch` before `save`
 *  mirrors what App.tsx's continuous patch-sync effect does on every field change. */
function saveVia(panelIndex: number, patch: Partial<TaskPatch> & Pick<TaskPatch, "title" | "deps" | "artifact_refs" | "doc" | "attachments" | "dirty" | "docDirty">): void {
  __createdPanels[panelIndex].webview.__receive(envelope({ type: "patch", patch }));
  __createdPanels[panelIndex].webview.__receive(envelope({ type: "save" }));
}

describe("TaskStudioPanelManager — panel identity", () => {
  it("reveals the existing new-task panel instead of opening a second one per workspace", () => {
    const ws = fakeWorkspace();
    const manager = new TaskStudioPanelManager(Uri.file("/ext"), () => {});
    manager.openNew(studioTarget(ws));
    manager.openNew(studioTarget(ws));
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
  });

  it("reveals the existing editor for the same task id instead of opening a second panel", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human" });
    const manager = new TaskStudioPanelManager(Uri.file("/ext"), () => {});
    manager.openExisting(studioTarget(ws), task.id);
    manager.openExisting(studioTarget(ws), task.id);
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
  });
});

describe("TaskStudioPanelManager — create (staged transaction)", () => {
  it("mints a task via the staged transaction, derives body from the doc, and reveals it", async () => {
    let refreshed = 0;
    const ws = fakeWorkspace();
    const manager = new TaskStudioPanelManager(Uri.file("/ext"), () => { refreshed += 1; });
    manager.openNew(studioTarget(ws));
    const entity = await entityOf();
    expect(entity.expectUpdatedAt).toBeUndefined(); // new mode: no task behind this pre-minted id yet
    expect(entity.assignee).toBeUndefined();

    saveVia(0, {
      title: "from studio",
      kind: "bug",
      priority: 1,
      deps: [],
      artifact_refs: [],
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
      attachments: [],
      dirty: { title: true, kind: true, priority: true },
      docDirty: true,
    } as TaskPatch);

    await settled(() => expect(ws.taskStore.listRaw()).toHaveLength(1));
    const [task] = ws.taskStore.listRaw();
    expect(task).toMatchObject({ id: entity.taskId, title: "from studio", kind: "bug", priority: 1, author: "human", status: "inbox", body: "hello" });
    expect(refreshed).toBe(1);
    expect(__createdPanels[0].disposed).toBe(true);
    const detail = new TaskDetailStore(ws.workspaceRoot).read(task.id);
    expect(detail.status).toBe("ok");
  });

  it("never lets assignee be set in create mode even if the webview sent one (325 mutability table)", async () => {
    const ws = fakeWorkspace();
    const manager = new TaskStudioPanelManager(Uri.file("/ext"), () => {});
    manager.openNew(studioTarget(ws));
    saveVia(0, { title: "x", assignee: "someone", deps: [], artifact_refs: [], doc: EMPTY_DOC, attachments: [], dirty: { title: true }, docDirty: false } as TaskPatch);
    await settled(() => expect(ws.taskStore.listRaw()).toHaveLength(1));
    const [task] = ws.taskStore.listRaw();
    expect(task.assignee).toBeUndefined();
  });

  it("cleans up the provisional attachment namespace when the staged create fails", async () => {
    const ws = fakeWorkspace();
    const manager = new TaskStudioPanelManager(Uri.file("/ext"), () => {});
    manager.openNew(studioTarget(ws));
    const entity = await entityOf();
    const attachmentStore = new TaskAttachmentStore(ws.workspaceRoot, entity.taskId);
    attachmentStore.putImage({ data: Buffer.from("during-editing"), mediaType: "image/png", source: "paste" });
    expect(fs.existsSync(attachmentStore.taskAttachmentsDir)).toBe(true);

    // force a collision: a task with this exact id already exists
    fs.mkdirSync(ws.taskStore.dir, { recursive: true });
    fs.writeFileSync(ws.taskStore.pathFor(entity.taskId), JSON.stringify({ id: entity.taskId, title: "already here", status: "inbox", author: "human", createdAt: "x", updatedAt: "x" }), "utf8");

    saveVia(0, { title: "collides", deps: [], artifact_refs: [], doc: EMPTY_DOC, attachments: [], dirty: {}, docDirty: false } as TaskPatch);

    await settled(() => expect(__createdPanels[0].webview.posted.some((m) => (m as { type?: string }).type === "error")).toBe(true));
    expect(fs.existsSync(attachmentStore.taskAttachmentsDir)).toBe(false);
    expect(__createdPanels[0].disposed).toBe(false);
  });

  it("cleans up the provisional attachment namespace on cancel", async () => {
    const ws = fakeWorkspace();
    const manager = new TaskStudioPanelManager(Uri.file("/ext"), () => {});
    manager.openNew(studioTarget(ws));
    const entity = await entityOf();
    const attachmentStore = new TaskAttachmentStore(ws.workspaceRoot, entity.taskId);
    attachmentStore.putImage({ data: Buffer.from("abandoned"), mediaType: "image/png", source: "paste" });
    expect(fs.existsSync(attachmentStore.taskAttachmentsDir)).toBe(true);
    __createdPanels[0].webview.__receive(envelope({ type: "cancel" }));
    expect(fs.existsSync(attachmentStore.taskAttachmentsDir)).toBe(false);
    // onCancel is awaited before dispose (spec 350 Amendment 3) — dispose lands a microtask later.
    await settled(() => expect(__createdPanels[0].disposed).toBe(true));
  });
});

describe("TaskStudioPanelManager — edit (anchoring + dirty patch + CAS)", () => {
  it("reimports the doc from body when there is no sidecar yet", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "**bold** body" });
    const manager = new TaskStudioPanelManager(Uri.file("/ext"), () => {});
    manager.openExisting(studioTarget(ws), task.id);
    const entity = await entityOf();
    expect(entity.anchor).toBe("reimport");
    expect(JSON.stringify(entity.doc)).toContain("bold");
  });

  it("loads the sidecar doc when its bodyHash matches the current body", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "hello" });
    const detailStore = new TaskDetailStore(ws.workspaceRoot);
    detailStore.write({ schemaVersion: 1, taskId: task.id, doc: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "rich" }] }] }, attachments: [], bodyHash: hashBody("hello"), taskUpdatedAt: task.updatedAt });
    const manager = new TaskStudioPanelManager(Uri.file("/ext"), () => {});
    manager.openExisting(studioTarget(ws), task.id);
    const entity = await entityOf();
    expect(entity.anchor).toBe("load");
    expect(entity.doc).toMatchObject({ content: [{ type: "heading" }] });
  });

  it("is fail-closed read-only on a malformed sidecar", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "hi" });
    const detailStore = new TaskDetailStore(ws.workspaceRoot);
    fs.mkdirSync(detailStore.detailsDir, { recursive: true });
    fs.writeFileSync(detailStore.detailPath(task.id), "{ not json", "utf8");
    const manager = new TaskStudioPanelManager(Uri.file("/ext"), () => {});
    manager.openExisting(studioTarget(ws), task.id);
    const entity = await entityOf();
    expect(entity.anchor).toBe("read-only");
    expect(entity.anchorError).toMatch(/not valid JSON/);
  });

  it("composes a dirty-field-only patch and never touches status/rank", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "old title", author: "human", kind: "chore", body: "b" });
    const manager = new TaskStudioPanelManager(Uri.file("/ext"), () => {});
    manager.openExisting(studioTarget(ws), task.id);
    const entity = await entityOf();

    saveVia(0, {
      title: entity.title,
      kind: "bug", // changed
      deps: [],
      artifact_refs: [],
      doc: EMPTY_DOC,
      attachments: [],
      dirty: { kind: true }, // ONLY kind marked dirty — title is untouched even though present in the message
      docDirty: false,
      expectUpdatedAt: entity.expectUpdatedAt,
    } as TaskPatch);

    await settled(() => expect(ws.taskStore.get(task.id).kind).toBe("bug"));
    const updated = ws.taskStore.get(task.id);
    expect(updated.title).toBe("old title"); // proves title (present but not dirty) never overwrote anything
    expect(updated.status).toBe("inbox");
    expect(__createdPanels[0].disposed).toBe(true);
  });

  it("derives body from the doc and writes the sidecar only when the doc itself was dirty", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "original" });
    const manager = new TaskStudioPanelManager(Uri.file("/ext"), () => {});
    manager.openExisting(studioTarget(ws), task.id);
    const entity = await entityOf();

    saveVia(0, {
      title: entity.title,
      deps: [],
      artifact_refs: [],
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "new body" }] }] },
      attachments: [],
      dirty: {},
      docDirty: true,
      expectUpdatedAt: entity.expectUpdatedAt,
    } as TaskPatch);

    await settled(() => expect(ws.taskStore.get(task.id).body).toBe("new body"));
    const detail = new TaskDetailStore(ws.workspaceRoot).read(task.id);
    expect(detail.status).toBe("ok");
  });

  it("a no-op Save (nothing dirty) disposes the panel without writing anything", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "b" });
    const before = ws.taskStore.get(task.id).updatedAt;
    const manager = new TaskStudioPanelManager(Uri.file("/ext"), () => {});
    manager.openExisting(studioTarget(ws), task.id);
    const entity = await entityOf();
    saveVia(0, { title: entity.title, deps: [], artifact_refs: [], doc: EMPTY_DOC, attachments: [], dirty: {}, docDirty: false, expectUpdatedAt: entity.expectUpdatedAt } as TaskPatch);
    await settled(() => expect(__createdPanels[0].disposed).toBe(true));
    expect(ws.taskStore.get(task.id).updatedAt).toBe(before);
  });

  it("surfaces a CAS conflict as a blocking error instead of throwing, and does not dispose the panel", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "b", now: "2026-07-03T00:00:00.000Z" });
    const manager = new TaskStudioPanelManager(Uri.file("/ext"), () => {});
    manager.openExisting(studioTarget(ws), task.id);
    const entity = await entityOf();

    // someone else updates the task first — an explicit, later `now` guarantees a genuinely different
    // updatedAt (task creation and this update could otherwise land in the same millisecond and mask the
    // CAS mismatch this test is specifically about).
    await ws.taskStore.update(task.id, { title: "changed underneath", now: "2026-07-03T00:00:01.000Z" });

    saveVia(0, {
      title: "my edit",
      deps: [],
      artifact_refs: [],
      doc: EMPTY_DOC,
      attachments: [],
      dirty: { title: true },
      docDirty: false,
      expectUpdatedAt: entity.expectUpdatedAt, // stale — the task moved on since this was loaded
    } as TaskPatch);

    await settled(() => expect(__createdPanels[0].webview.posted.some((m) => (m as { type?: string }).type === "error" && (m as { code?: string }).code === "task/precondition-failed")).toBe(true));
    const conflictMsg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "error" && (m as { code?: string }).code === "task/precondition-failed") as { message: string };
    expect(conflictMsg.message).toMatch(/precondition-failed/);
    expect(__createdPanels[0].disposed).toBe(false);
    expect(ws.taskStore.get(task.id).title).toBe("changed underneath"); // never silently overwritten
  });

  it("re-sending ready re-posts the freshest task+sidecar state (Reload latest's mechanism)", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "b" });
    const manager = new TaskStudioPanelManager(Uri.file("/ext"), () => {});
    manager.openExisting(studioTarget(ws), task.id);
    await entityOf();
    await ws.taskStore.update(task.id, { title: "renamed elsewhere" });
    __createdPanels[0].webview.__receive(envelope({ type: "ready" }));
    const entity = await settled(() => {
      const posted = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "load") as { entity: TaskDetailEntity }[];
      const last = posted[posted.length - 1]!.entity;
      if (last.title !== "renamed elsewhere") throw new Error("not yet refreshed");
      return last;
    });
    expect(entity.title).toBe("renamed elsewhere");
  });
});
