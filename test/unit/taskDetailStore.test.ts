import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore, mintTaskId } from "@tachyon/engine/tasks/TaskStore.js";
import { TaskAttachmentStore } from "@tachyon/engine/tasks/TaskAttachmentStore.js";
import { TaskDetailStore, hashBody, TASK_DETAIL_SCHEMA_VERSION } from "@tachyon/engine/tasks/TaskDetailStore.js";
import { EMPTY_DOC } from "../../src/webview/rich-doc/document.js";

let root: string;
let taskStore: TaskStore;
let detailStore: TaskDetailStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-task-details-"));
  taskStore = new TaskStore(root);
  detailStore = new TaskDetailStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("TaskDetailStore lifecycle", () => {
  it("treats a missing sidecar as valid (import from body)", async () => {
    const task = await taskStore.create({ title: "no sidecar yet", author: "human", body: "plain body" });
    expect(detailStore.read(task.id)).toEqual({ status: "missing" });
  });

  it("round-trips a written sidecar", async () => {
    const task = await taskStore.create({ title: "x", author: "human", body: "hello" });
    detailStore.write({
      schemaVersion: 1,
      taskId: task.id,
      doc: EMPTY_DOC,
      attachments: [],
      bodyHash: hashBody("hello"),
      taskUpdatedAt: task.updatedAt,
    });
    const result = detailStore.read(task.id);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.detail.taskId).toBe(task.id);
      expect(result.detail.bodyHash).toBe(hashBody("hello"));
      expect(result.detail.schemaVersion).toBe(TASK_DETAIL_SCHEMA_VERSION);
    }
    // atomic write leaves no temp files behind
    expect(fs.readdirSync(detailStore.detailsDir)).toEqual([`${task.id}.json`]);
  });

  it("fails closed (read-only) on invalid JSON without touching the file", async () => {
    const id = "t-abc123";
    fs.mkdirSync(detailStore.detailsDir, { recursive: true });
    fs.writeFileSync(detailStore.detailPath(id), "{ not json", "utf8");
    const result = detailStore.read(id);
    expect(result.status).toBe("malformed");
    if (result.status === "malformed") expect(result.error).toMatch(/not valid JSON/);
  });

  it("fails closed on an unknown/newer schemaVersion", async () => {
    const id = "t-abc123";
    fs.mkdirSync(detailStore.detailsDir, { recursive: true });
    fs.writeFileSync(detailStore.detailPath(id), JSON.stringify({ schemaVersion: 2, taskId: id, doc: EMPTY_DOC, attachments: [], bodyHash: "x", taskUpdatedAt: "now" }), "utf8");
    const result = detailStore.read(id);
    expect(result.status).toBe("malformed");
    if (result.status === "malformed") expect(result.error).toMatch(/schemaVersion/);
  });

  it("fails closed when required fields are missing", async () => {
    const id = "t-abc123";
    fs.mkdirSync(detailStore.detailsDir, { recursive: true });
    fs.writeFileSync(detailStore.detailPath(id), JSON.stringify({ schemaVersion: 1, taskId: id }), "utf8");
    expect(detailStore.read(id).status).toBe("malformed");
  });

  it("rejects writing a sidecar with the wrong schemaVersion", () => {
    expect(() => detailStore.write({ schemaVersion: 2 as never, taskId: "t-abc123", doc: EMPTY_DOC, attachments: [], bodyHash: "x", taskUpdatedAt: "now" })).toThrow("schemaVersion 1");
  });
});

describe("TaskDetailStore.createStaged", () => {
  it("uses the pre-minted id for both the task and the sidecar", async () => {
    const id = mintTaskId();
    const task = await detailStore.createStaged(taskStore, id, {
      title: "from studio",
      doc: EMPTY_DOC,
      attachments: [],
      body: "derived markdown",
    });
    expect(task.id).toBe(id);
    expect(task.status).toBe("inbox");
    expect(task.author).toBe("human");
    expect(task.body).toBe("derived markdown");
    const result = detailStore.read(id);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.detail.bodyHash).toBe(hashBody("derived markdown"));
      expect(result.detail.taskUpdatedAt).toBe(task.updatedAt);
    }
  });

  it("passes through optional scalar fields", async () => {
    const id = mintTaskId();
    const task = await detailStore.createStaged(taskStore, id, {
      title: "with fields",
      kind: "bug",
      priority: 1,
      artifact_refs: [{ type: "sdd", ref: "docs/specs/339" }],
      deps: [],
      doc: EMPTY_DOC,
      attachments: [],
      body: "b",
    });
    expect(task).toMatchObject({ kind: "bug", priority: 1, artifact_refs: [{ type: "sdd", ref: "docs/specs/339" }] });
  });

  it("surfaces the underlying error and creates nothing when the id collides", async () => {
    const id = mintTaskId();
    await taskStore.create({ id, title: "already here", author: "human" });
    await expect(detailStore.createStaged(taskStore, id, { title: "x", doc: EMPTY_DOC, attachments: [], body: "b" })).rejects.toThrow();
    expect(detailStore.read(id)).toEqual({ status: "missing" });
  });
});

describe("TaskDetailStore.delete", () => {
  it("removes the sidecar and the whole attachment namespace, best-effort", async () => {
    const task = await taskStore.create({ title: "x", author: "human", body: "b" });
    const attachments = new TaskAttachmentStore(root, task.id);
    const image = attachments.putImage({ data: Buffer.from("img"), mediaType: "image/png", source: "paste" });
    detailStore.write({ schemaVersion: 1, taskId: task.id, doc: EMPTY_DOC, attachments: [image], bodyHash: hashBody("b"), taskUpdatedAt: task.updatedAt });

    expect(fs.existsSync(detailStore.detailPath(task.id))).toBe(true);
    expect(fs.existsSync(attachments.blobDir)).toBe(true);

    const { errors } = detailStore.delete(task.id);
    expect(errors).toEqual([]);
    expect(fs.existsSync(detailStore.detailPath(task.id))).toBe(false);
    expect(fs.existsSync(attachments.taskAttachmentsDir)).toBe(false);
  });

  it("tolerates deleting a task with no sidecar at all", () => {
    const { errors } = detailStore.delete("t-abc123");
    expect(errors).toEqual([]);
  });
});

describe("TaskDetailStore.gcRemovedAttachments", () => {
  it("removes blobs no longer referenced, keeping ones still referenced by another kept attachment", async () => {
    const task = await taskStore.create({ title: "x", author: "human", body: "b" });
    const store = new TaskAttachmentStore(root, task.id);
    const removedImg = store.putImage({ data: Buffer.from("removed"), mediaType: "image/png", source: "paste" });
    const keptImg = store.putImage({ data: Buffer.from("kept"), mediaType: "image/png", source: "paste" });
    const dupImg = store.putImage({ data: Buffer.from("kept"), mediaType: "image/png", source: "paste" }); // same bytes as keptImg — same blobRef
    expect(dupImg.blobRef).toBe(keptImg.blobRef);

    const { removed, errors } = detailStore.gcRemovedAttachments(task.id, [removedImg, keptImg], [keptImg]);
    expect(errors).toEqual([]);
    expect(removed).toEqual([removedImg.blobRef]);
    expect(fs.existsSync(store.blobPath(removedImg.blobRef))).toBe(false);
    expect(fs.existsSync(store.blobPath(keptImg.blobRef))).toBe(true); // still referenced by `next`
  });

  it("keeps an excalidraw's scene/preview blobs distinctly", async () => {
    const task = await taskStore.create({ title: "x", author: "human", body: "b" });
    const store = new TaskAttachmentStore(root, task.id);
    const sketch = store.putExcalidraw({
      sceneJson: JSON.stringify({ type: "excalidraw", elements: [], appState: {}, files: {} }),
      previewData: Buffer.from("preview"),
      source: "blank",
    });
    const { removed, errors } = detailStore.gcRemovedAttachments(task.id, [sketch], []);
    expect(errors).toEqual([]);
    expect(removed.sort()).toEqual([sketch.sceneBlobRef, sketch.previewBlobRef].sort());
  });

  it("never throws when a stale blob was already removed out-of-band", async () => {
    const task = await taskStore.create({ title: "x", author: "human", body: "b" });
    const store = new TaskAttachmentStore(root, task.id);
    const img = store.putImage({ data: Buffer.from("gone"), mediaType: "image/png", source: "paste" });
    fs.rmSync(store.blobPath(img.blobRef));
    expect(() => detailStore.gcRemovedAttachments(task.id, [img], [])).not.toThrow();
  });

  it("reports a GC error instead of throwing when a blob ref is invalid", async () => {
    const task = await taskStore.create({ title: "x", author: "human", body: "b" });
    const bad = { id: "att-bad", kind: "image", blobRef: "../escape", mediaType: "image/png", name: "bad.png", size: 1, createdAt: "2026-07-03T00:00:00.000Z", source: "paste", visibility: "local" } as const;
    const { removed, errors } = detailStore.gcRemovedAttachments(task.id, [bad], []);
    expect(removed).toEqual([]);
    expect(errors.length).toBe(1);
  });
});
