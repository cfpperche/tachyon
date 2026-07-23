import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import { __resetVscodeMock, __setOpenDialogResult } from "../mocks/vscode.js";
import { handlePinStudioDomainMessage } from "../../src/cockpit/pinStudioDomain.js";
import type { StudioDomainContext } from "../../src/cockpit/studioRegistry.js";
import type { WorkspacePinStudioTarget, PinStudioAttachmentResult } from "../../src/shell/PinStudioTarget.js";

/**
 * t-610705 (SDD 410 Phase D, D3) — the import/attach/sketch domain-message DISPATCH+error-mapping
 * logic ported from the retired PinStudioPanelManager.handleDomainMessage into pinStudioDomain.ts
 * (generic StudioRegistryEntry.handleDomainMessage extension point), same split
 * taskStudioDomain.test.ts (D2) established: the generic StudioPanelManagerBase-replacement
 * LIFECYCLE (load/save/cancel/persisted-cleanup) is covered generically by cockpitStudio.test.ts and
 * studioHostProvisionalCleanup.test.ts; this file covers the PIN-SPECIFIC domain dispatch directly,
 * calling the ported function in isolation rather than through the full Cockpit.ts/studioHost.ts
 * stack. Unlike taskStudioDomain.test.ts, there is no "no entityId" case for attachImage/storeSketch:
 * Pin images are workspace-scoped (not per-pin), and putPinStudioSketch's `pinId` is a genuine
 * `string | undefined` (a brand-new unsaved pin's sketch is a valid, real case) — the retired panel
 * never guarded on entityId for either, and this port doesn't add a guard that wasn't there.
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-studio-domain-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// t-610705 (Phase D, D3) — a default PARAMETER would silently ignore an explicit `fakeCtx(undefined)`
// call (JS applies defaults on an explicit `undefined` argument too) — matches taskStudioDomain.test.ts's
// own fix for the same footgun.
function fakeCtx(entityId: string | undefined): StudioDomainContext & { posted: unknown[] } {
  const posted: unknown[] = [];
  return { post: (m: unknown) => posted.push(m), entityId, posted };
}

function fakeImageResult(overSoftLimit = false): PinStudioAttachmentResult {
  return {
    attachment: {
      id: "att-1",
      kind: "image",
      blobRef: "blob-1",
      mediaType: "image/png",
      name: "shot.png",
      size: 1234,
      createdAt: "2026-07-22T00:00:00.000Z",
      source: "import",
      visibility: "local",
      path: "/tmp/att-1.png",
      available: true,
      uri: "data:image/png;base64,aGVsbG8=",
    },
    overSoftLimit,
  };
}

function target(overrides: Partial<WorkspacePinStudioTarget> = {}): WorkspacePinStudioTarget {
  return {
    workspaceRoot: "/ws/root",
    wsHash: "ws1",
    folderName: "root",
    loadPinStudio: async () => { throw new Error("not used"); },
    savePinStudio: async () => { throw new Error("not used"); },
    putPinStudioImage: async () => fakeImageResult(),
    putPinStudioSketch: async () => fakeImageResult(),
    attachmentBlobRoot: () => "/ws/root/.tachyon/pins/blobs",
    ...overrides,
  } as WorkspacePinStudioTarget;
}

function findType(posted: unknown[], type: string) {
  return posted.filter((m) => (m as { type?: string }).type === type);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// t-610705 (Phase D, D3) — handlePinStudioDomainMessage's `message` param is intentionally typed as
// the narrow `{ type: string }` — a generic pass-through avoids TS's excess-property check, which
// only fires for an object literal checked DIRECTLY against a narrower contextual type.
function msg<T extends { type: string }>(m: T): T {
  return m;
}

describe("Pin Studio domain dispatch (t-610705 Phase D, D3)", () => {
  it("attachImage posts attachmentStored on success", async () => {
    const ctx = fakeCtx("p-abc123");
    const t = target({ putPinStudioImage: async (input) => { expect(input.source).toBe("paste"); return fakeImageResult(); } });
    handlePinStudioDomainMessage(t, ctx, msg({ type: "attachImage", mediaType: "image/png", source: "paste", dataBase64: "aGVsbG8=" }));
    await flush();
    expect(findType(ctx.posted, "attachmentStored")).toHaveLength(1);
    expect(findType(ctx.posted, "error")).toHaveLength(0);
  });

  it("attachImage strips a data: URI prefix before decoding", async () => {
    const ctx = fakeCtx("p-abc123");
    let received = "";
    const t = target({ putPinStudioImage: async (input) => { received = input.data.toString("utf8"); return fakeImageResult(); } });
    handlePinStudioDomainMessage(t, ctx, msg({ type: "attachImage", mediaType: "image/png", source: "drop", dataBase64: `data:image/png;base64,${Buffer.from("hello").toString("base64")}` }));
    await flush();
    expect(received).toBe("hello");
  });

  it("attachImage rejects a payload over the 10 MB limit without calling the target", async () => {
    const ctx = fakeCtx("p-abc123");
    let called = false;
    const t = target({ putPinStudioImage: async () => { called = true; return fakeImageResult(); } });
    const huge = "A".repeat(15 * 1024 * 1024);
    handlePinStudioDomainMessage(t, ctx, msg({ type: "attachImage", mediaType: "image/png", source: "paste", dataBase64: huge }));
    await flush();
    expect(called).toBe(false);
    const errors = findType(ctx.posted, "error") as Array<{ message: string; blocking: boolean }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/10 MB/);
    expect(errors[0]!.blocking).toBe(true);
  });

  it("attachImage works with no current entityId (a brand-new unsaved pin — images are workspace-scoped, not per-pin)", async () => {
    const ctx = fakeCtx(undefined);
    let called = false;
    const t = target({ putPinStudioImage: async () => { called = true; return fakeImageResult(); } });
    handlePinStudioDomainMessage(t, ctx, msg({ type: "attachImage", mediaType: "image/png", source: "paste", dataBase64: "aGVsbG8=" }));
    await flush();
    expect(called).toBe(true);
    expect(findType(ctx.posted, "attachmentStored")).toHaveLength(1);
  });

  it("attachImage surfaces a persistence failure as a blocking error", async () => {
    const ctx = fakeCtx("p-abc123");
    const t = target({ putPinStudioImage: async () => { throw new Error("disk full"); } });
    handlePinStudioDomainMessage(t, ctx, msg({ type: "attachImage", mediaType: "image/png", source: "paste", dataBase64: "aGVsbG8=" }));
    await flush();
    const errors = findType(ctx.posted, "error") as Array<{ message: string; blocking: boolean }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("disk full");
    expect(errors[0]!.blocking).toBe(true);
  });

  it("storeSketch posts attachmentStored on success, forwarding the attachmentId/baseImage fields and the (possibly undefined) pinId", async () => {
    const ctx = fakeCtx("p-abc123");
    let received: unknown;
    const t = target({ putPinStudioSketch: async (pinId, input) => { received = { pinId, ...input }; return fakeImageResult(); } });
    handlePinStudioDomainMessage(t, ctx, msg({
      type: "storeSketch",
      attachmentId: "att-9",
      name: "Sketch",
      source: "blank",
      sceneJson: "{}",
      previewBase64: "aGVsbG8=",
    }));
    await flush();
    expect(findType(ctx.posted, "attachmentStored")).toHaveLength(1);
    expect(received).toMatchObject({ pinId: "p-abc123", attachmentId: "att-9", name: "Sketch", source: "blank" });
  });

  it("storeSketch works with no current entityId, passing pinId:undefined through", async () => {
    const ctx = fakeCtx(undefined);
    let receivedPinId: string | undefined = "unset";
    const t = target({ putPinStudioSketch: async (pinId) => { receivedPinId = pinId; return fakeImageResult(); } });
    handlePinStudioDomainMessage(t, ctx, msg({ type: "storeSketch", name: "Sketch", source: "blank", sceneJson: "{}", previewBase64: "aGVsbG8=" }));
    await flush();
    expect(receivedPinId).toBeUndefined();
    expect(findType(ctx.posted, "attachmentStored")).toHaveLength(1);
  });

  it("storeSketch surfaces a persistence failure as a blocking error", async () => {
    const ctx = fakeCtx("p-abc123");
    const t = target({ putPinStudioSketch: async () => { throw new Error("disk full"); } });
    handlePinStudioDomainMessage(t, ctx, msg({ type: "storeSketch", name: "Sketch", source: "blank", sceneJson: "{}", previewBase64: "aGVsbG8=" }));
    await flush();
    const errors = findType(ctx.posted, "error") as Array<{ message: string; blocking: boolean }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("disk full");
  });

  it("importImage no-ops when the user cancels the file picker", async () => {
    __setOpenDialogResult(undefined);
    const ctx = fakeCtx("p-abc123");
    let called = false;
    const t = target({ putPinStudioImage: async () => { called = true; return fakeImageResult(); } });
    handlePinStudioDomainMessage(t, ctx, { type: "importImage" });
    await flush();
    expect(called).toBe(false);
    expect(ctx.posted).toHaveLength(0);
  });

  it("importImage reads the picked file and posts attachmentStored", async () => {
    const root = mkroot();
    const file = path.join(root, "shot.png");
    fs.writeFileSync(file, "pretend-png-bytes");
    __setOpenDialogResult([Uri.file(file)]);
    const ctx = fakeCtx("p-abc123");
    let sourceSeen = "";
    const t = target({ putPinStudioImage: async (input) => { sourceSeen = input.source; return fakeImageResult(); } });
    handlePinStudioDomainMessage(t, ctx, { type: "importImage" });
    await flush();
    expect(sourceSeen).toBe("import");
    expect(findType(ctx.posted, "attachmentStored")).toHaveLength(1);
  });

  it("importImage rejects an unsupported file extension without calling the target", async () => {
    const root = mkroot();
    const file = path.join(root, "notes.txt");
    fs.writeFileSync(file, "not an image");
    __setOpenDialogResult([Uri.file(file)]);
    const ctx = fakeCtx("p-abc123");
    let called = false;
    const t = target({ putPinStudioImage: async () => { called = true; return fakeImageResult(); } });
    handlePinStudioDomainMessage(t, ctx, { type: "importImage" });
    await flush();
    expect(called).toBe(false);
    const errors = findType(ctx.posted, "error") as Array<{ message: string }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/Unsupported image type/);
  });

  it("ignores an unrecognized message type without throwing", () => {
    const ctx = fakeCtx("p-abc123");
    expect(() => handlePinStudioDomainMessage(target(), ctx, { type: "bogus" })).not.toThrow();
    expect(ctx.posted).toHaveLength(0);
  });
});
