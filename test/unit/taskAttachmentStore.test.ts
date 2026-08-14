import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskAttachmentStore, TASK_IMAGE_MAX_BYTES } from "@tachyon/engine/tasks/TaskAttachmentStore.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-task-blobs-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("TaskAttachmentStore", () => {
  let store: TaskAttachmentStore;

  beforeEach(() => {
    fs.rmSync(path.join(root, ".tachyon"), { recursive: true, force: true });
    store = new TaskAttachmentStore(root, "t-abc123");
  });

  it("rejects a malformed task id at construction", () => {
    expect(() => new TaskAttachmentStore(root, "not-a-task-id")).toThrow("invalid task id");
    expect(() => new TaskAttachmentStore(root, "p-abc123")).toThrow("invalid task id");
  });

  it("stores allowed images content-addressed under the task's own namespace", () => {
    const att = store.putImage({ data: Buffer.from("png bytes"), mediaType: "image/png", name: "shot.png", source: "paste", now: "2026-07-03T00:00:00.000Z" });
    expect(att).toMatchObject({ kind: "image", mediaType: "image/png", name: "shot.png", source: "paste", visibility: "local" });
    expect(att.blobRef).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(store.blobPath(att.blobRef))).toBe(true);
    expect(store.relativeBlobPath(att.blobRef)).toBe(`.tachyon/tasks/attachments/t-abc123/blobs/${att.blobRef}`);
    expect(store.resolveAttachment(att)).toMatchObject({ path: `.tachyon/tasks/attachments/t-abc123/blobs/${att.blobRef}`, available: true });
  });

  it("isolates two tasks' blob directories from each other (cross-entity rejection)", () => {
    const other = new TaskAttachmentStore(root, "t-def456");
    const att = store.putImage({ data: Buffer.from("only-in-abc123"), mediaType: "image/png", source: "paste" });
    expect(fs.existsSync(store.blobPath(att.blobRef))).toBe(true);
    // the SAME blobRef, resolved through a different task's store, does not exist under that task's namespace
    expect(() => other.blobPath(att.blobRef)).not.toThrow(); // ref shape itself is valid...
    expect(fs.existsSync(other.blobPath(att.blobRef))).toBe(false); // ...but nothing was ever written there
    expect(other.relativeBlobPath(att.blobRef)).toBe(`.tachyon/tasks/attachments/t-def456/blobs/${att.blobRef}`);
    expect(store.relativeBlobPath(att.blobRef)).not.toBe(other.relativeBlobPath(att.blobRef));
  });

  it("keeps blob paths contained to sha256 filenames (rejects traversal refs)", () => {
    expect(() => store.blobPath("../escape")).toThrow("invalid task attachment blob ref");
    expect(() => store.blobPath("../../other-task/blobs/deadbeef")).toThrow("invalid task attachment blob ref");
    expect(store.resolveAttachment({
      id: "att-bad",
      kind: "image",
      blobRef: "../escape",
      mediaType: "image/png",
      name: "bad.png",
      size: 1,
      createdAt: "2026-07-03T00:00:00.000Z",
      source: "paste",
      visibility: "local",
    })).toMatchObject({ path: ".tachyon/tasks/attachments/t-abc123/blobs/.._escape", available: false });
  });

  it("rejects unsupported and oversized images before writing", () => {
    expect(() => store.putImage({ data: Buffer.from("<svg/>"), mediaType: "image/svg+xml", source: "paste" })).toThrow("unsupported");
    expect(() => store.putImage({ data: Buffer.alloc(TASK_IMAGE_MAX_BYTES + 1), mediaType: "image/png", source: "paste" })).toThrow("10 MB");
    expect(fs.existsSync(store.blobDir)).toBe(false);
  });

  it("deduplicates identical bytes within one task's namespace", () => {
    const a = store.putImage({ data: Buffer.from("same"), mediaType: "image/jpeg", source: "drop" });
    const b = store.putImage({ data: Buffer.from("same"), mediaType: "image/jpeg", source: "import" });
    expect(a.blobRef).toBe(b.blobRef);
    expect(fs.readdirSync(store.blobDir)).toEqual([a.blobRef]);
  });

  it("normalizes Excalidraw scenes with the same forbidden-payload rules as pins", () => {
    expect(() => store.putExcalidraw({
      sceneJson: JSON.stringify({ type: "excalidraw", elements: [], appState: { bad: "blob:abc" }, files: {} }),
      previewData: Buffer.from("preview"),
      source: "blank",
    })).toThrow("$.appState.bad");
    const att = store.putExcalidraw({
      sceneJson: JSON.stringify({ type: "excalidraw", elements: [{ id: "el-1", type: "rectangle" }], appState: {}, files: {} }),
      previewData: Buffer.from("preview"),
      name: "Flow sketch",
      source: "blank",
    });
    expect(att).toMatchObject({ kind: "excalidraw", name: "Flow sketch", elementCount: 1, sceneMediaType: "application/vnd.tachyon.excalidraw+json" });
  });
});
