import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PinAttachmentStore } from "../../src/pins/PinAttachmentStore.js";
import { PinStore, type TiptapJSON } from "../../src/pins/PinStore.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-rich-pins-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const doc = (text = "body"): TiptapJSON => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("PinStore rich details", () => {
  let store: PinStore;
  let attachments: PinAttachmentStore;

  beforeEach(() => {
    fs.rmSync(path.join(root, ".tachyon"), { recursive: true, force: true });
    store = new PinStore(root);
    attachments = new PinAttachmentStore(root);
  });

  it("returns summary-only detail for legacy pins without creating detail files", () => {
    const pin = store.create("legacy", "claude");
    const got = store.readDetail(pin.id);
    expect(got).toMatchObject({ detail: false, doc: null, attachments: [] });
    expect(got.summary).toMatchObject({ id: pin.id, text: "legacy", detail: false });
    expect(fs.existsSync(store.detailPath(pin.id))).toBe(false);
  });

  it("creates and reads rich details with resolved attachment availability", () => {
    const att = attachments.putImage({ data: Buffer.from("img"), mediaType: "image/png", name: "img.png", source: "paste", now: "2026-06-24T00:01:00.000Z" });
    const pin = store.createRich(" rich title ", "human", { doc: doc(), attachments: [att], now: "2026-06-24T00:02:00.000Z" });
    expect(pin).toMatchObject({ text: "rich title", detail: true, attachmentCount: 1, updatedAt: "2026-06-24T00:02:00.000Z" });
    const got = store.readDetail(pin.id);
    expect(got.detail).toBe(true);
    expect(got.doc).toEqual(doc());
    expect(got.attachments[0]).toMatchObject({ id: att.id, path: `.tachyon/pins/blobs/${att.blobRef}`, available: true });
    const raw = JSON.parse(fs.readFileSync(store.detailPath(pin.id), "utf8")) as { schemaVersion: number };
    expect(raw.schemaVersion).toBe(2);
  });

  it("reads schemaVersion 1 details without rewriting them", () => {
    const pin = store.create("legacy rich", "human");
    const att = attachments.putImage({ data: Buffer.from("legacy-img"), mediaType: "image/png", source: "paste" });
    fs.mkdirSync(store.pinDetailsDir, { recursive: true });
    const legacy = `${JSON.stringify({ schemaVersion: 1, pinId: pin.id, doc: doc("legacy"), attachments: [att] }, null, 2)}\n`;
    fs.writeFileSync(store.detailPath(pin.id), legacy, "utf8");

    const got = store.readDetail(pin.id);
    expect(got).toMatchObject({ detail: true, doc: doc("legacy") });
    expect(got.attachments[0]).toMatchObject({ kind: "image", available: true });
    expect(fs.readFileSync(store.detailPath(pin.id), "utf8")).toBe(legacy);
  });

  it("reads schemaVersion 2 sketch details with independent scene and preview availability", () => {
    const sketch = attachments.putExcalidraw({
      sceneJson: JSON.stringify({ type: "excalidraw", elements: [], appState: {}, files: {} }),
      previewData: Buffer.from("preview"),
      source: "blank",
      now: "2026-06-24T00:02:00.000Z",
    });
    const pin = store.createRich("sketch", "human", {
      doc: { type: "doc", content: [{ type: "tachyonSketch", attrs: { attachmentId: sketch.id } }] },
      attachments: [sketch],
      now: "2026-06-24T00:03:00.000Z",
    });
    fs.rmSync(attachments.blobPath(sketch.previewBlobRef), { force: true });

    const resolved = store.readDetail(pin.id).attachments[0];
    expect(resolved).toMatchObject({
      kind: "excalidraw",
      scenePath: `.tachyon/pins/blobs/${sketch.sceneBlobRef}`,
      sceneAvailable: true,
      previewPath: `.tachyon/pins/blobs/${sketch.previewBlobRef}`,
      previewAvailable: false,
    });
  });

  it("counts annotated sketches as one sidebar visual while retaining the base image dependency", () => {
    const image = attachments.putImage({
      data: Buffer.from("base screenshot"),
      mediaType: "image/png",
      name: "screenshot.png",
      source: "paste",
      now: "2026-06-24T00:01:00.000Z",
    });
    const sketch = attachments.putExcalidraw({
      sceneJson: JSON.stringify({ type: "excalidraw", elements: [], appState: {}, files: {} }),
      previewData: Buffer.from("preview"),
      source: "annotate-image",
      baseImageAttachmentId: image.id,
      now: "2026-06-24T00:02:00.000Z",
    });
    const pin = store.createRich("annotation", "human", {
      doc: { type: "doc", content: [{ type: "tachyonSketch", attrs: { attachmentId: sketch.id } }] },
      attachments: [image, sketch],
      now: "2026-06-24T00:03:00.000Z",
    });

    expect(pin).toMatchObject({ detail: true, attachmentCount: 1 });
    expect(store.list()[0]).toMatchObject({ detail: true, attachmentCount: 1 });
    const detail = store.readDetail(pin.id);
    expect(detail.summary).toMatchObject({ detail: true, attachmentCount: 1 });
    expect(detail.attachments.map((att) => att.id)).toEqual([image.id, sketch.id]);
  });

  it("saves rich detail while preserving identity fields and done state", () => {
    const pin = store.create("plain", "human");
    store.setDone(pin.id, true);
    const before = store.list()[0];
    const saved = store.saveDetail(pin.id, { text: "new title", doc: doc("new"), attachments: [], now: "2026-06-24T00:03:00.000Z" });
    expect(saved).toMatchObject({ id: before.id, by: before.by, createdAt: before.createdAt, done: true, text: "new title", detail: true, attachmentCount: 0 });
    expect(saved.updatedAt).toBe("2026-06-24T00:03:00.000Z");
    expect(store.readDetail(pin.id).doc).toEqual(doc("new"));
  });

  it("reports missing blobs as unavailable without failing the rich detail read", () => {
    const att = attachments.putImage({ data: Buffer.from("gone"), mediaType: "image/webp", source: "drop" });
    const pin = store.createRich("missing", "human", { doc: doc(), attachments: [att] });
    fs.rmSync(attachments.blobPath(att.blobRef), { force: true });
    expect(store.readDetail(pin.id).attachments[0]).toMatchObject({ available: false, path: `.tachyon/pins/blobs/${att.blobRef}` });
  });

  it("removes a rich pin detail without deleting a shared content-addressed blob", () => {
    const att = attachments.putImage({ data: Buffer.from("shared"), mediaType: "image/gif", source: "import" });
    const a = store.createRich("a", "human", { doc: doc("a"), attachments: [att] });
    const b = store.createRich("b", "human", { doc: doc("b"), attachments: [att] });
    store.remove(a.id);
    expect(fs.existsSync(store.detailPath(a.id))).toBe(false);
    expect(fs.existsSync(attachments.blobPath(att.blobRef))).toBe(true);
    const resolved = store.readDetail(b.id).attachments[0];
    expect(resolved.kind).toBe("image");
    if (resolved.kind === "image") expect(resolved.available).toBe(true);
  });

  it("keeps error behavior precise for unknown ids and corrupt details", () => {
    expect(() => store.readDetail("p-000000")).toThrow("unknown pin");
    const pin = store.createRich("bad", "human", { doc: doc(), attachments: [] });
    fs.writeFileSync(store.detailPath(pin.id), "{bad", "utf8");
    expect(() => store.readDetail(pin.id)).toThrow("not valid JSON");
  });
});
