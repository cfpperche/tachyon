import { describe, it, expect } from "vitest";
import { attachmentFromVM, attachmentsForSave, attachmentsUsedByDoc, toEditorDoc, toStoredDoc, upsertAttachment } from "../../src/webview/pin-studio/document.js";
import { dataURLWithMediaType } from "../../src/webview/pin-studio/data-url.js";
import type { PinStudioAttachmentVM } from "../../src/webview/pin-studio/types.js";
import type { TiptapJSON } from "@tachyon/engine/pins/types.js";

const attachment: PinStudioAttachmentVM = {
  id: "att-abc123",
  kind: "image",
  blobRef: "a".repeat(64),
  mediaType: "image/png",
  name: "shot.png",
  size: 123,
  createdAt: "2026-06-24T00:00:00.000Z",
  source: "paste",
  visibility: "local",
  path: `.tachyon/pins/blobs/${"a".repeat(64)}`,
  available: true,
  uri: "vscode-webview://workspace/pins/blobs/a",
};

describe("Pin Studio document model", () => {
  it("rewrites canonical attachment refs to webview URIs for editing only", () => {
    const stored: TiptapJSON = {
      type: "doc",
      content: [{ type: "image", attrs: { src: "tachyon-pin-attachment:att-abc123", attachmentId: "att-abc123", blobRef: "a".repeat(64) } }],
    };
    const editor = toEditorDoc(stored, [attachment]);
    expect(editor.content?.[0].attrs).toMatchObject({ src: attachment.uri, attachmentId: attachment.id, blobRef: attachment.blobRef });
  });

  it("canonicalizes image src before saving so webview URIs are not persisted", () => {
    const editorDoc: TiptapJSON = {
      type: "doc",
      content: [{ type: "image", attrs: { src: attachment.uri, attachmentId: attachment.id, blobRef: attachment.blobRef } }],
    };
    expect(toStoredDoc(editorDoc).content?.[0].attrs).toMatchObject({ src: `tachyon-pin-attachment:${attachment.id}` });
  });

  it("strips render-only attachment fields before save messages", () => {
    expect(attachmentFromVM(attachment)).toEqual({
      id: attachment.id,
      kind: "image",
      blobRef: attachment.blobRef,
      mediaType: "image/png",
      name: "shot.png",
      size: 123,
      createdAt: "2026-06-24T00:00:00.000Z",
      source: "paste",
      visibility: "local",
    });
  });

  it("rewrites sketch previews for editing but stores only attachment ids", () => {
    const sketch: PinStudioAttachmentVM = {
      id: "att-sketch",
      kind: "excalidraw",
      name: "Sketch",
      sceneBlobRef: "b".repeat(64),
      previewBlobRef: "c".repeat(64),
      sceneMediaType: "application/vnd.tachyon.excalidraw+json",
      previewMediaType: "image/png",
      sceneSize: 123,
      previewSize: 456,
      elementCount: 2,
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:00.000Z",
      source: "blank",
      visibility: "local",
      scenePath: `.tachyon/pins/blobs/${"b".repeat(64)}`,
      sceneAvailable: true,
      previewPath: `.tachyon/pins/blobs/${"c".repeat(64)}`,
      previewAvailable: true,
      previewUri: "vscode-webview://preview",
      sceneJson: "{\"type\":\"excalidraw\"}",
    };
    const stored = { type: "doc", content: [{ type: "tachyonSketch", attrs: { attachmentId: sketch.id, previewSrc: `tachyon-pin-sketch:${sketch.id}` } }] };
    expect(toEditorDoc(stored, [sketch]).content?.[0].attrs).toMatchObject({ attachmentId: sketch.id, previewSrc: sketch.previewUri });
    expect(toStoredDoc(toEditorDoc(stored, [sketch])).content?.[0].attrs).toMatchObject({ attachmentId: sketch.id, previewSrc: `tachyon-pin-sketch:${sketch.id}` });
    expect(attachmentFromVM(sketch)).not.toHaveProperty("previewUri");
    expect(attachmentFromVM(sketch)).not.toHaveProperty("sceneJson");
    expect(attachmentsUsedByDoc(stored, [attachment, sketch])).toEqual([sketch]);
  });

  it("keeps a sketch base image attachment for save without showing it as a separate direct visual", () => {
    const sketch: PinStudioAttachmentVM = {
      id: "att-sketch",
      kind: "excalidraw",
      name: "Annotation",
      sceneBlobRef: "b".repeat(64),
      previewBlobRef: "c".repeat(64),
      sceneMediaType: "application/vnd.tachyon.excalidraw+json",
      previewMediaType: "image/png",
      sceneSize: 123,
      previewSize: 456,
      elementCount: 2,
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:00.000Z",
      source: "annotate-image",
      baseImageAttachmentId: attachment.id,
      visibility: "local",
      scenePath: `.tachyon/pins/blobs/${"b".repeat(64)}`,
      sceneAvailable: true,
      previewPath: `.tachyon/pins/blobs/${"c".repeat(64)}`,
      previewAvailable: true,
      previewUri: "vscode-webview://preview",
    };
    const stored = { type: "doc", content: [{ type: "tachyonSketch", attrs: { attachmentId: sketch.id } }] };
    expect(attachmentsUsedByDoc(stored, [attachment, sketch])).toEqual([sketch]);
    expect(attachmentsForSave(stored, [attachment, sketch])).toEqual([attachment, sketch]);
  });

  it("replaces an edited sketch attachment with the latest preview uri", () => {
    const oldSketch: PinStudioAttachmentVM = {
      id: "att-sketch",
      kind: "excalidraw",
      name: "Sketch",
      sceneBlobRef: "b".repeat(64),
      previewBlobRef: "c".repeat(64),
      sceneMediaType: "application/vnd.tachyon.excalidraw+json",
      previewMediaType: "image/png",
      sceneSize: 123,
      previewSize: 456,
      elementCount: 2,
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:00.000Z",
      source: "blank",
      visibility: "local",
      scenePath: `.tachyon/pins/blobs/${"b".repeat(64)}`,
      sceneAvailable: true,
      previewPath: `.tachyon/pins/blobs/${"c".repeat(64)}`,
      previewAvailable: true,
      previewUri: "vscode-webview://old-preview",
      sceneJson: "{\"type\":\"excalidraw\"}",
    };
    const newSketch = {
      ...oldSketch,
      previewBlobRef: "d".repeat(64),
      previewPath: `.tachyon/pins/blobs/${"d".repeat(64)}`,
      previewUri: "vscode-webview://new-preview",
      previewSize: 789,
      updatedAt: "2026-06-24T00:01:00.000Z",
    } satisfies PinStudioAttachmentVM;
    const doc = { type: "doc", content: [{ type: "tachyonSketch", attrs: { attachmentId: oldSketch.id, previewSrc: oldSketch.previewUri } }] };
    const next = upsertAttachment([oldSketch], newSketch);

    expect(next).toEqual([newSketch]);
    expect(toEditorDoc(toStoredDoc(doc), next).content?.[0].attrs).toMatchObject({
      attachmentId: oldSketch.id,
      previewSrc: "vscode-webview://new-preview",
    });
  });

  it("rewrites fetched webview image data urls with the original attachment media type", () => {
    const unknown = `data:application/unknown;base64,${Buffer.from("image-bytes").toString("base64")}`;

    expect(dataURLWithMediaType(unknown, "image/png")).toBe(`data:image/png;base64,${Buffer.from("image-bytes").toString("base64")}`);
  });
});
