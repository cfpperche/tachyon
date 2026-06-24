import { describe, it, expect } from "vitest";
import { attachmentFromVM, toEditorDoc, toStoredDoc } from "../../src/webview/pin-studio/document.js";
import type { PinStudioAttachmentVM } from "../../src/webview/pin-studio/types.js";
import type { TiptapJSON } from "../../src/pins/types.js";

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
});
