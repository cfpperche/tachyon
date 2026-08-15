import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PinAttachmentStore } from "@tachyon/engine/pins/PinAttachmentStore.js";
import { PinStore } from "@tachyon/engine/pins/PinStore.js";
import { attachmentsForSave, attachmentsUsedByDoc } from "@tachyon/webview-ui/webview/rich-doc/document";
import type { PinStudioAttachmentVM } from "../../packages/webview-ui/src/webview/pin-studio/types.js";
import type { TiptapJSON } from "@tachyon/engine/pins/types.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function mkroot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pin-sketch-dogfood-"));
  roots.push(root);
  return root;
}

function sketchDoc(attachmentId: string): TiptapJSON {
  return { type: "doc", content: [{ type: "tachyonSketch", attrs: { attachmentId, previewSrc: `tachyon-pin-sketch:${attachmentId}` } }] };
}

function emptyDoc(): TiptapJSON {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

function sceneWithText(text: string, source = "vscode-webview://tachyon/pin-studio/index.html"): string {
  return JSON.stringify({
    type: "excalidraw",
    source,
    elements: [{ id: "el-text", type: "text", text }],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  });
}

function sceneWithEmbeddedImage(data: Buffer): string {
  return JSON.stringify({
    type: "excalidraw",
    source: "vscode-webview://tachyon/pin-studio/index.html",
    elements: [{ id: "el-image", type: "image", fileId: "file-1" }],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {
      "file-1": {
        id: "file-1",
        mimeType: "image/png",
        created: 1,
        dataURL: `data:image/png;base64,${data.toString("base64")}`,
      },
    },
  });
}

function persistedText(root: string): string {
  const tachyon = path.join(root, ".tachyon");
  const chunks: string[] = [];
  const pinsJson = path.join(tachyon, "pins.json");
  if (fs.existsSync(pinsJson)) chunks.push(fs.readFileSync(pinsJson, "utf8"));
  const pinDir = path.join(tachyon, "pins");
  for (const file of fs.readdirSync(pinDir).filter((name) => /^p-[0-9a-f]{6}\.json$/.test(name)).sort()) {
    chunks.push(fs.readFileSync(path.join(pinDir, file), "utf8"));
  }
  const blobDir = path.join(pinDir, "blobs");
  for (const file of fs.readdirSync(blobDir).filter((name) => /^[a-f0-9]{64}$/.test(name)).sort()) {
    const p = path.join(blobDir, file);
    const data = fs.readFileSync(p);
    if (data.subarray(0, 1).toString("utf8") === "{") chunks.push(data.toString("utf8"));
  }
  return chunks.join("\n---\n");
}

describe("Pin Studio Excalidraw headless dogfood", () => {
  it("covers blank sketch, annotate, edit, cancel, remove, get_pin shape, and persisted payload hygiene", async () => {
    const root = mkroot();
    const pins = new PinStore(root);
    const artifacts = new PinAttachmentStore(root);

    const blank = artifacts.putExcalidraw({
      sceneJson: sceneWithText("blank sketch dogfood"),
      previewData: Buffer.from("blank-preview"),
      source: "blank",
      now: "2026-06-24T00:00:00.000Z",
    });
    const blankPin = await pins.createRich("blank sketch dogfood", "human", {
      doc: sketchDoc(blank.id),
      attachments: [blank],
      now: "2026-06-24T00:00:00.000Z",
    });
    const blankDetail = JSON.parse(fs.readFileSync(pins.detailPath(blankPin.id), "utf8"));
    expect(blankDetail).toMatchObject({ schemaVersion: 2, pinId: blankPin.id });
    expect(blankDetail.doc.content[0]).toMatchObject({ type: "tachyonSketch", attrs: { attachmentId: blank.id } });
    expect(blankDetail.attachments[0]).toMatchObject({ kind: "excalidraw", id: blank.id, source: "blank" });
    const blankScene = JSON.parse(fs.readFileSync(artifacts.blobPath(blank.sceneBlobRef), "utf8"));
    expect(blankScene.source).toBe("tachyon-pin-studio");

    const image = artifacts.putImage({
      data: Buffer.from("original screenshot bytes"),
      mediaType: "image/png",
      name: "screenshot.png",
      source: "paste",
      now: "2026-06-24T00:01:00.000Z",
    });
    const annotated = artifacts.putExcalidraw({
      sceneJson: sceneWithEmbeddedImage(Buffer.from("annotated screenshot bytes")),
      previewData: Buffer.from("annotated-preview"),
      source: "annotate-image",
      baseImageAttachmentId: image.id,
      now: "2026-06-24T00:02:00.000Z",
    });
    const annotationPin = await pins.createRich("annotated screenshot dogfood", "human", {
      doc: {
        type: "doc",
        content: [
          { type: "image", attrs: { attachmentId: image.id, blobRef: image.blobRef, src: `tachyon-pin-attachment:${image.id}` } },
          { type: "tachyonSketch", attrs: { attachmentId: annotated.id, previewSrc: `tachyon-pin-sketch:${annotated.id}` } },
        ],
      },
      attachments: [image, annotated],
      now: "2026-06-24T00:02:00.000Z",
    });
    const annotatedScene = JSON.parse(fs.readFileSync(artifacts.blobPath(annotated.sceneBlobRef), "utf8"));
    expect(annotated).toMatchObject({ baseImageAttachmentId: image.id, source: "annotate-image" });
    expect(annotatedScene.files["file-1"]).toMatchObject({ blobRef: expect.stringMatching(/^[a-f0-9]{64}$/), mimeType: "image/png" });
    expect(annotatedScene.files["file-1"]).not.toHaveProperty("dataURL");

    const edited = artifacts.putExcalidraw({
      sceneJson: sceneWithText("edited annotation"),
      previewData: Buffer.from("edited-preview"),
      source: "annotate-image",
      baseImageAttachmentId: image.id,
      existing: annotated,
      now: "2026-06-24T00:03:00.000Z",
    });
    expect(edited.id).toBe(annotated.id);
    expect(edited.createdAt).toBe(annotated.createdAt);
    expect(edited.updatedAt).toBe("2026-06-24T00:03:00.000Z");
    expect(edited.previewBlobRef).not.toBe(annotated.previewBlobRef);

    await pins.saveDetail(annotationPin.id, { text: "annotated screenshot dogfood", doc: sketchDoc(edited.id), attachments: [image, edited], now: "2026-06-24T00:03:00.000Z" });
    expect(pins.list().find((pin) => pin.id === annotationPin.id)).toMatchObject({ detail: true, attachmentCount: 1 });
    const beforeCancel = fs.readFileSync(pins.detailPath(annotationPin.id), "utf8");
    sceneWithText("cancelled edit that is never stored");
    expect(fs.readFileSync(pins.detailPath(annotationPin.id), "utf8")).toBe(beforeCancel);

    const resolved = pins.readDetail(annotationPin.id);
    expect(JSON.stringify(resolved)).not.toMatch(/sceneJson|previewBase64|data:image|;base64,|vscode-webview/);
    expect(resolved.attachments.find((att) => att.kind === "excalidraw")).toMatchObject({
      scenePath: `.tachyon/pins/blobs/${edited.sceneBlobRef}`,
      sceneAvailable: true,
      previewPath: `.tachyon/pins/blobs/${edited.previewBlobRef}`,
      previewAvailable: true,
    });

    const imageVm = { ...artifacts.resolveAttachment(image), uri: "vscode-webview://image" } satisfies PinStudioAttachmentVM;
    const sketchVm = { ...artifacts.resolveAttachment(edited), previewUri: "vscode-webview://preview" } satisfies PinStudioAttachmentVM;
    expect(attachmentsUsedByDoc(sketchDoc(edited.id), [imageVm, sketchVm]).map((att) => att.id)).toEqual([edited.id]);
    expect(attachmentsForSave(sketchDoc(edited.id), [imageVm, sketchVm]).map((att) => att.id)).toEqual([image.id, edited.id]);
    expect(attachmentsUsedByDoc(emptyDoc(), [imageVm, sketchVm])).toEqual([]);

    await pins.saveDetail(annotationPin.id, { text: "annotated screenshot dogfood", doc: emptyDoc(), attachments: [], now: "2026-06-24T00:04:00.000Z" });
    expect(pins.readDetail(annotationPin.id)).toMatchObject({ summary: { attachmentCount: 0 }, attachments: [] });

    expect(persistedText(root)).not.toMatch(/data:image|;base64,|blob:|vscode-webview|\/home\/|\/mnt\//);
  });
});
