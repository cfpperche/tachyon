import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PinAttachmentStore, PIN_IMAGE_MAX_BYTES } from "../../src/pins/PinAttachmentStore.js";

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
});
