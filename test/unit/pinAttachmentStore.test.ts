import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PinAttachmentStore, PIN_IMAGE_MAX_BYTES } from "@tachyon/engine/pins/PinAttachmentStore.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pin-blobs-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("PinAttachmentStore", () => {
  let store: PinAttachmentStore;

  beforeEach(() => {
    fs.rmSync(path.join(root, ".tachyon"), { recursive: true, force: true });
    store = new PinAttachmentStore(root);
  });

  it("stores allowed images content-addressed with workspace-relative paths", () => {
    const att = store.putImage({ data: Buffer.from("png bytes"), mediaType: "image/png", name: "shot.png", source: "paste", now: "2026-06-24T00:00:00.000Z" });
    expect(att).toMatchObject({ kind: "image", mediaType: "image/png", name: "shot.png", source: "paste", visibility: "local" });
    expect(att.blobRef).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(store.blobPath(att.blobRef))).toBe(true);
    expect(store.relativeBlobPath(att.blobRef)).toBe(`.tachyon/pins/blobs/${att.blobRef}`);
    expect(store.resolveAttachment(att)).toMatchObject({ path: `.tachyon/pins/blobs/${att.blobRef}`, available: true });
  });

  it("deduplicates identical bytes and does not leave temp files", () => {
    const a = store.putImage({ data: Buffer.from("same"), mediaType: "image/jpeg", source: "drop" });
    const b = store.putImage({ data: Buffer.from("same"), mediaType: "image/jpeg", source: "import" });
    expect(a.blobRef).toBe(b.blobRef);
    expect(fs.readdirSync(store.blobDir)).toEqual([a.blobRef]);
  });

  it("rejects unsupported and oversized images before writing", () => {
    expect(() => store.putImage({ data: Buffer.from("<svg/>"), mediaType: "image/svg+xml", source: "paste" })).toThrow("unsupported");
    expect(() => store.putImage({ data: Buffer.alloc(PIN_IMAGE_MAX_BYTES + 1), mediaType: "image/png", source: "paste" })).toThrow("10 MB");
    expect(fs.existsSync(store.blobDir)).toBe(false);
  });

  it("keeps blob paths contained to sha256 filenames", () => {
    expect(() => store.blobPath("../escape")).toThrow("invalid pin blob ref");
    expect(store.resolveAttachment({
      id: "att-bad",
      kind: "image",
      blobRef: "../escape",
      mediaType: "image/png",
      name: "bad.png",
      size: 1,
      createdAt: "2026-06-24T00:00:00.000Z",
      source: "paste",
      visibility: "local",
    })).toMatchObject({ path: ".tachyon/pins/blobs/.._escape", available: false });
  });

  it("normalizes Excalidraw scene files into Tachyon blobs and rehydrates them for the webview", () => {
    const imageData = Buffer.from("scene image");
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements: [{ id: "el-1", type: "image", fileId: "file-1" }],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {
        "file-1": {
          id: "file-1",
          mimeType: "image/png",
          created: 1,
          dataURL: `data:image/png;base64,${imageData.toString("base64")}`,
        },
      },
    };

    const att = store.putExcalidraw({
      sceneJson: JSON.stringify(scene),
      previewData: Buffer.from("preview"),
      name: "Flow sketch",
      source: "annotate-image",
      baseImageAttachmentId: "att-image",
      now: "2026-06-24T00:00:00.000Z",
    });

    expect(att).toMatchObject({
      kind: "excalidraw",
      name: "Flow sketch",
      source: "annotate-image",
      baseImageAttachmentId: "att-image",
      sceneMediaType: "application/vnd.tachyon.excalidraw+json",
      previewMediaType: "image/png",
      elementCount: 1,
    });
    const normalized = fs.readFileSync(store.blobPath(att.sceneBlobRef), "utf8");
    expect(normalized).not.toMatch(/data:image|base64|blob:|vscode-webview|\/home\/|\/mnt\//);
    expect(JSON.parse(normalized).files["file-1"]).toMatchObject({ blobRef: expect.stringMatching(/^[a-f0-9]{64}$/), mimeType: "image/png", size: imageData.length });

    const hydrated = store.readExcalidrawScene(att);
    expect(hydrated).toContain(`data:image/png;base64,${imageData.toString("base64")}`);
  });

  it("reports missing sketch scene and preview blobs independently", () => {
    const att = store.putExcalidraw({
      sceneJson: JSON.stringify({ type: "excalidraw", elements: [], appState: {}, files: {} }),
      previewData: Buffer.from("preview"),
      source: "blank",
    });
    fs.rmSync(store.blobPath(att.previewBlobRef), { force: true });
    expect(store.resolveAttachment(att)).toMatchObject({
      kind: "excalidraw",
      scenePath: `.tachyon/pins/blobs/${att.sceneBlobRef}`,
      sceneAvailable: true,
      previewPath: `.tachyon/pins/blobs/${att.previewBlobRef}`,
      previewAvailable: false,
    });
  });

  it("keeps sketch ids stable across edits while updating scene and preview refs", () => {
    const first = store.putExcalidraw({
      sceneJson: JSON.stringify({ type: "excalidraw", elements: [], appState: {}, files: {} }),
      previewData: Buffer.from("preview-1"),
      name: "Sketch",
      source: "blank",
      now: "2026-06-24T00:00:00.000Z",
    });
    const edited = store.putExcalidraw({
      sceneJson: JSON.stringify({ type: "excalidraw", elements: [{ id: "el-1", type: "rectangle" }], appState: {}, files: {} }),
      previewData: Buffer.from("preview-2"),
      source: "blank",
      existing: first,
      now: "2026-06-24T00:02:00.000Z",
    });
    expect(edited.id).toBe(first.id);
    expect(edited.createdAt).toBe(first.createdAt);
    expect(edited.updatedAt).toBe("2026-06-24T00:02:00.000Z");
    expect(edited.previewBlobRef).not.toBe(first.previewBlobRef);
    expect(edited.elementCount).toBe(1);
  });

  it("rejects sketch scenes that still contain forbidden local or inline payloads", () => {
    expect(() => store.putExcalidraw({
      sceneJson: JSON.stringify({ type: "excalidraw", elements: [], appState: { bad: "blob:abc" }, files: {} }),
      previewData: Buffer.from("preview"),
      source: "blank",
    })).toThrow("$.appState.bad");
    expect(() => store.putExcalidraw({
      sceneJson: JSON.stringify({ type: "excalidraw", elements: [], appState: { source: "file:///home/goat/private.png" }, files: {} }),
      previewData: Buffer.from("preview"),
      source: "blank",
    })).toThrow("$.appState.source");
  });

  it("does not reject ordinary sketch text that merely mentions base64", () => {
    const att = store.putExcalidraw({
      sceneJson: JSON.stringify({
        type: "excalidraw",
        elements: [{ id: "el-1", type: "text", text: "base64 is a word here" }],
        appState: {},
        files: {},
      }),
      previewData: Buffer.from("preview"),
      source: "blank",
    });
    expect(att.elementCount).toBe(1);
  });

  it("normalizes Excalidraw root source instead of persisting a webview URL", () => {
    const att = store.putExcalidraw({
      sceneJson: JSON.stringify({
        type: "excalidraw",
        source: "vscode-webview://example/index.html",
        elements: [],
        appState: {},
        files: {},
      }),
      previewData: Buffer.from("preview"),
      source: "blank",
    });
    const normalized = JSON.parse(fs.readFileSync(store.blobPath(att.sceneBlobRef), "utf8"));
    expect(normalized.source).toBe("tachyon-pin-studio");
    expect(JSON.stringify(normalized)).not.toMatch(/vscode-webview/);
  });
});
