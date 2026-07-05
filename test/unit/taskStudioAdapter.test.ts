import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore, mintTaskId } from "../../src/tasks/TaskStore.js";
import { TaskDetailStore, hashBody } from "../../src/tasks/TaskDetailStore.js";
import { TaskAttachmentStore } from "../../src/tasks/TaskAttachmentStore.js";
import { TaskStudioAdapter } from "../../src/webview/TaskStudioAdapter.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import { computeTaskDirty, serializeTaskPatch, canDiscardTaskFields, type TaskFields } from "../../src/webview/task-studio/domain.js";

/** spec 350 T1 — TaskStudioAdapter in isolation: no vscode, no panel, no protocol — just the
 *  StudioHostAdapter<TaskDetailEntity,TaskFields,TaskPatch> contract wrapping TaskDetailStore/
 *  TaskAttachmentStore/TaskStore. The end-to-end panel behavior stays covered by taskStudioPanel.test.ts
 *  until T2 migrates the panel itself onto this adapter. */

function mkroot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-studio-adapter-"));
}

function fakeWorkspace(root = mkroot(), agents: Record<string, unknown> = {}): Workspace {
  return {
    wsHash: "ws-1",
    folderName: "Project",
    workspaceRoot: root,
    taskStore: new TaskStore(root),
    config: { agents },
  } as unknown as Workspace;
}

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };
const docWithText = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

function baseFields(overrides: Partial<TaskFields> = {}): TaskFields {
  return {
    title: "x",
    deps: [],
    artifact_refs: [],
    doc: EMPTY_DOC,
    attachments: [],
    dirty: {},
    docDirty: false,
    ...overrides,
  };
}

describe("TaskStudioAdapter — load", () => {
  it("returns an empty new-task entity when entityId is undefined", () => {
    const ws = fakeWorkspace();
    const adapter = new TaskStudioAdapter(ws);
    const result = adapter.load(undefined);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.title).toBe("");
    expect(result.entity.anchor).toBe("load");
    expect(result.entity.expectUpdatedAt).toBeUndefined();
  });

  it("returns an empty entity for a pre-minted id with no task behind it yet (staged new-mode)", () => {
    const ws = fakeWorkspace();
    const adapter = new TaskStudioAdapter(ws);
    const id = mintTaskId();
    const result = adapter.load(id);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.taskId).toBe(id);
    expect(result.entity.title).toBe("");
  });

  it("reimports the doc from body when there is no sidecar yet", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "**bold** body" });
    const adapter = new TaskStudioAdapter(ws);
    const result = adapter.load(task.id);
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.anchor).toBe("reimport");
    expect(JSON.stringify(result.entity.doc)).toContain("bold");
    expect(result.entity.expectUpdatedAt).toBe(task.updatedAt);
  });

  it("loads the sidecar doc when its bodyHash matches the current body", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "hello" });
    const detailStore = new TaskDetailStore(ws.workspaceRoot);
    detailStore.write({
      schemaVersion: 1,
      taskId: task.id,
      doc: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "rich" }] }] },
      attachments: [],
      bodyHash: hashBody("hello"),
      taskUpdatedAt: task.updatedAt,
    });
    const adapter = new TaskStudioAdapter(ws);
    const result = adapter.load(task.id);
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.anchor).toBe("load");
    expect(result.entity.doc).toMatchObject({ content: [{ type: "heading" }] });
  });

  it("is fail-closed read-only on a malformed sidecar", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "hi" });
    const detailStore = new TaskDetailStore(ws.workspaceRoot);
    fs.mkdirSync(detailStore.detailsDir, { recursive: true });
    fs.writeFileSync(detailStore.detailPath(task.id), "{ not json", "utf8");
    const adapter = new TaskStudioAdapter(ws);
    const result = adapter.load(task.id);
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.anchor).toBe("read-only");
    expect(result.entity.anchorError).toMatch(/not valid JSON/);
  });

  it("inlines image attachments as data: URIs (no panel/webview dependency)", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "hello" });
    const attStore = new TaskAttachmentStore(ws.workspaceRoot, task.id);
    const att = attStore.putImage({ data: Buffer.from("fake-png-bytes"), mediaType: "image/png", source: "paste" });
    const detailStore = new TaskDetailStore(ws.workspaceRoot);
    detailStore.write({ schemaVersion: 1, taskId: task.id, doc: EMPTY_DOC, attachments: [att], bodyHash: hashBody("hello"), taskUpdatedAt: task.updatedAt });
    const adapter = new TaskStudioAdapter(ws);
    const result = adapter.load(task.id);
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.attachments).toHaveLength(1);
    expect(result.entity.attachments[0]!.uri).toMatch(/^data:image\/png;base64,/);
  });

  it("resolves known deps and flags missing ones", async () => {
    const ws = fakeWorkspace();
    const dep = await ws.taskStore.create({ title: "dep", author: "human" });
    const task = await ws.taskStore.create({ title: "x", author: "human", deps: [dep.id] });
    // a dangling id that was never created
    await ws.taskStore.update(task.id, { deps: [dep.id, "t-000000"] });
    const adapter = new TaskStudioAdapter(ws);
    const result = adapter.load(task.id);
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.deps).toEqual([
      { id: dep.id, title: "dep", missing: false },
      { id: "t-000000", missing: true },
    ]);
  });
});

describe("TaskStudioAdapter — save (staged create)", () => {
  it("mints via the staged transaction and derives body from the doc", async () => {
    const ws = fakeWorkspace();
    const adapter = new TaskStudioAdapter(ws);
    const id = mintTaskId();
    const patch = baseFields({
      title: "from studio",
      kind: "bug",
      priority: 1,
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
      dirty: { title: true, kind: true, priority: true },
      docDirty: true,
    });
    const result = await adapter.save(id, patch);
    expect(result.status).toBe("ok");
    const task = ws.taskStore.get(id);
    expect(task).toMatchObject({ title: "from studio", kind: "bug", priority: 1, author: "human", status: "inbox", body: "hello" });
    const detail = new TaskDetailStore(ws.workspaceRoot).read(id);
    expect(detail.status).toBe("ok");
  });

  it("never lets assignee be set in create mode even if the patch carried one (325 mutability table)", async () => {
    const ws = fakeWorkspace();
    const adapter = new TaskStudioAdapter(ws);
    const id = mintTaskId();
    const result = await adapter.save(id, baseFields({ title: "x", assignee: "someone", dirty: { title: true } }));
    expect(result.status).toBe("ok");
    expect(ws.taskStore.get(id).assignee).toBeUndefined();
  });

  it("cleans up the provisional attachment namespace when the staged create fails", async () => {
    const ws = fakeWorkspace();
    const adapter = new TaskStudioAdapter(ws);
    const id = mintTaskId();
    const attachmentStore = new TaskAttachmentStore(ws.workspaceRoot, id);
    attachmentStore.putImage({ data: Buffer.from("during-editing"), mediaType: "image/png", source: "paste" });
    expect(fs.existsSync(attachmentStore.taskAttachmentsDir)).toBe(true);

    // force a collision: a task with this exact id already exists
    fs.mkdirSync(ws.taskStore.dir, { recursive: true });
    fs.writeFileSync(ws.taskStore.pathFor(id), JSON.stringify({ id, title: "already here", status: "inbox", author: "human", createdAt: "x", updatedAt: "x" }), "utf8");

    const result = await adapter.save(id, baseFields({ title: "collides" }));
    expect(result.status).toBe("error");
    expect(fs.existsSync(attachmentStore.taskAttachmentsDir)).toBe(false);
  });
});

describe("TaskStudioAdapter — save (CAS update)", () => {
  it("composes a dirty-field-only patch and never touches status/rank", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "old title", author: "human", kind: "chore", body: "b" });
    const adapter = new TaskStudioAdapter(ws);
    const result = await adapter.save(task.id, baseFields({ title: "old title", kind: "bug", dirty: { kind: true }, expectUpdatedAt: task.updatedAt }));
    expect(result.status).toBe("ok");
    const updated = ws.taskStore.get(task.id);
    expect(updated.kind).toBe("bug");
    expect(updated.title).toBe("old title"); // present but not dirty — never overwrote anything
    expect(updated.status).toBe("inbox");
  });

  it("derives body from the doc and writes the sidecar only when the doc itself was dirty", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "original" });
    const adapter = new TaskStudioAdapter(ws);
    const result = await adapter.save(
      task.id,
      baseFields({ title: "x", doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "new body" }] }] }, docDirty: true, expectUpdatedAt: task.updatedAt }),
    );
    expect(result.status).toBe("ok");
    expect(ws.taskStore.get(task.id).body).toBe("new body");
    expect(new TaskDetailStore(ws.workspaceRoot).read(task.id).status).toBe("ok");
  });

  it("does not write a no-op body when a reimported doc serializes back to its original body", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "original body" });
    const adapter = new TaskStudioAdapter(ws);
    const result = await adapter.save(
      task.id,
      baseFields({ title: "x", doc: docWithText("original body"), bodyBaseline: "original body", docDirty: true, expectUpdatedAt: task.updatedAt }),
    );
    expect(result.status).toBe("ok");
    expect(ws.taskStore.get(task.id).updatedAt).toBe(task.updatedAt);
    expect(new TaskDetailStore(ws.workspaceRoot).read(task.id).status).toBe("missing");
  });

  it("writes the body from a reimported doc when it differs from the original imported body", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "original body" });
    const adapter = new TaskStudioAdapter(ws);
    const result = await adapter.save(
      task.id,
      baseFields({ title: "x", doc: docWithText("edited body"), bodyBaseline: "original body", docDirty: true, expectUpdatedAt: task.updatedAt }),
    );
    expect(result.status).toBe("ok");
    expect(ws.taskStore.get(task.id).body).toBe("edited body");
    expect(new TaskDetailStore(ws.workspaceRoot).read(task.id).status).toBe("ok");
  });

  it("a no-op save (nothing dirty) is a status:ok with no write", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "b" });
    const before = ws.taskStore.get(task.id).updatedAt;
    const adapter = new TaskStudioAdapter(ws);
    const result = await adapter.save(task.id, baseFields({ title: "x", expectUpdatedAt: task.updatedAt }));
    expect(result.status).toBe("ok");
    expect(ws.taskStore.get(task.id).updatedAt).toBe(before);
  });

  it("surfaces a CAS conflict as status:conflict instead of throwing, and never silently overwrites", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human", body: "b", now: "2026-07-03T00:00:00.000Z" });
    const staleExpectUpdatedAt = task.updatedAt;
    await ws.taskStore.update(task.id, { title: "changed underneath", now: "2026-07-03T00:00:01.000Z" });

    const adapter = new TaskStudioAdapter(ws);
    const result = await adapter.save(task.id, baseFields({ title: "my edit", dirty: { title: true }, expectUpdatedAt: staleExpectUpdatedAt }));
    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") throw new Error("unreachable");
    expect(result.error.message).toMatch(/precondition-failed/);
    expect(ws.taskStore.get(task.id).title).toBe("changed underneath");
  });
});

describe("TaskStudioAdapter — concurrency + dirty hooks", () => {
  it("declares cas concurrency and revisionOf reads expectUpdatedAt", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "x", author: "human" });
    const adapter = new TaskStudioAdapter(ws);
    expect(adapter.concurrency).toEqual({ kind: "cas" });
    const result = adapter.load(task.id);
    if (result.status !== "ok") throw new Error("unreachable");
    expect(adapter.revisionOf!(result.entity)).toBe(task.updatedAt);
  });

  it("computeTaskDirty/serializeTaskPatch/canDiscardTaskFields agree on dirty vs clean fields", () => {
    const clean = baseFields();
    expect(computeTaskDirty(undefined, clean)).toBe(false);
    expect(serializeTaskPatch(clean, false)).toBeUndefined();
    expect(canDiscardTaskFields(clean)).toBe(true);

    const dirty = baseFields({ dirty: { title: true } });
    expect(computeTaskDirty(undefined, dirty)).toBe(true);
    expect(serializeTaskPatch(dirty, true)).toBe(dirty);
    expect(canDiscardTaskFields(dirty)).toBe(false);

    const docDirty = baseFields({ docDirty: true });
    expect(computeTaskDirty(undefined, docDirty)).toBe(true);
    expect(canDiscardTaskFields(docDirty)).toBe(false);

    const normalizedImport = baseFields({ doc: docWithText("same body"), bodyBaseline: "same body", docDirty: true });
    expect(computeTaskDirty(undefined, normalizedImport)).toBe(false);
    expect(canDiscardTaskFields(normalizedImport)).toBe(true);

    const editedImport = baseFields({ doc: docWithText("changed body"), bodyBaseline: "same body" });
    expect(computeTaskDirty(undefined, editedImport)).toBe(true);
    expect(serializeTaskPatch(editedImport, true)).toBe(editedImport);
  });
});
