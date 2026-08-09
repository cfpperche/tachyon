import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import { __resetVscodeMock, __setOpenDialogResult } from "../mocks/vscode.js";
import { handleTaskStudioDomainMessage } from "../../src/cockpit/taskStudioDomain.js";
import type { StudioDomainContext } from "../../src/webview/shared/studio/studioRegistry.js";
import type { WorkspaceTaskStudioTarget, TaskStudioAttachmentResult } from "../../src/shell/TaskStudioTarget.js";

/**
 * t-610705 (SDD 410 Phase D, D2) — the import/attach/sketch domain-message DISPATCH+error-mapping
 * logic ported from the retired TaskStudioPanelManager.handleDomainMessage into taskStudioDomain.ts
 * (generic StudioRegistryEntry.handleDomainMessage extension point), same split
 * agentStudioDomain.test.ts already established for D1b: the generic StudioPanelManagerBase-replacement
 * LIFECYCLE (load/save/cancel/persisted-cleanup) is covered generically elsewhere (panel-base /
 * cancel tests); this file covers the TASK-SPECIFIC domain dispatch directly, calling the ported
 * function in isolation rather than through the full Cockpit/panel stack.
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-studio-domain-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// t-610705 (Phase D, D2) — a default PARAMETER would silently ignore an explicit `fakeCtx(undefined)`
// call (JS applies defaults on an explicit `undefined` argument too) — every "no entityId" test below
// must actually get `entityId: undefined`, so this takes a plain required argument instead.
function fakeCtx(entityId: string | undefined): StudioDomainContext & { posted: unknown[] } {
  const posted: unknown[] = [];
  return { post: (m: unknown) => posted.push(m), entityId, posted };
}

function fakeImageResult(overSoftLimit = false): TaskStudioAttachmentResult {
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
      uri: "vscode-resource:/att-1.png",
    },
    overSoftLimit,
  };
}

function target(overrides: Partial<WorkspaceTaskStudioTarget> = {}): WorkspaceTaskStudioTarget {
  return {
    workspaceRoot: "/ws/root",
    wsHash: "ws1",
    folderName: "root",
    declaredAgentNames: () => [],
    loadTaskStudio: async () => { throw new Error("not used"); },
    saveTaskStudio: async () => { throw new Error("not used"); },
    cancelTaskStudio: async () => {},
    putTaskStudioImage: async () => fakeImageResult(),
    putTaskStudioSketch: async () => fakeImageResult(),
    importTaskStudioPrototype: async () => {},
    ...overrides,
  } as WorkspaceTaskStudioTarget;
}

function findType(posted: unknown[], type: string) {
  return posted.filter((m) => (m as { type?: string }).type === type);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// t-610705 (Phase D, D2) — handleTaskStudioDomainMessage's `message` param is intentionally typed as
// the narrow `{ type: string }` (the local TaskStudioDomainMessage union isn't exported — see the
// module's own doc comment on why). A generic pass-through avoids TS's excess-property check, which
// only fires for an object literal checked DIRECTLY against a narrower contextual type.
function msg<T extends { type: string }>(m: T): T {
  return m;
}

describe("Task Studio domain dispatch (t-610705 Phase D, D2)", () => {
  it("attachImage posts attachmentStored on success", async () => {
    const ctx = fakeCtx("t-abc123");
    const t = target({ putTaskStudioImage: async (id, input) => { expect(id).toBe("t-abc123"); expect(input.source).toBe("paste"); return fakeImageResult(); } });
    handleTaskStudioDomainMessage(t, ctx, msg({ type: "attachImage", mediaType: "image/png", source: "paste", dataBase64: "aGVsbG8=" }));
    await flush();
    expect(findType(ctx.posted, "attachmentStored")).toHaveLength(1);
    expect(findType(ctx.posted, "error")).toHaveLength(0);
  });

  it("attachImage strips a data: URI prefix before decoding", async () => {
    const ctx = fakeCtx("t-abc123");
    let received = "";
    const t = target({ putTaskStudioImage: async (_id, input) => { received = input.data.toString("utf8"); return fakeImageResult(); } });
    handleTaskStudioDomainMessage(t, ctx, msg({ type: "attachImage", mediaType: "image/png", source: "drop", dataBase64: `data:image/png;base64,${Buffer.from("hello").toString("base64")}` }));
    await flush();
    expect(received).toBe("hello");
  });

  it("attachImage rejects a payload over the 10 MB limit without calling the target", async () => {
    const ctx = fakeCtx("t-abc123");
    let called = false;
    const t = target({ putTaskStudioImage: async () => { called = true; return fakeImageResult(); } });
    const huge = "A".repeat(15 * 1024 * 1024);
    handleTaskStudioDomainMessage(t, ctx, msg({ type: "attachImage", mediaType: "image/png", source: "paste", dataBase64: huge }));
    await flush();
    expect(called).toBe(false);
    const errors = findType(ctx.posted, "error") as Array<{ message: string; blocking: boolean }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/10 MB/);
    expect(errors[0]!.blocking).toBe(true);
  });

  it("attachImage is a no-op when there is no current entityId (defensive — never reachable in practice, route.ts rejects studio-new for task)", async () => {
    const ctx = fakeCtx(undefined);
    let called = false;
    const t = target({ putTaskStudioImage: async () => { called = true; return fakeImageResult(); } });
    handleTaskStudioDomainMessage(t, ctx, msg({ type: "attachImage", mediaType: "image/png", source: "paste", dataBase64: "aGVsbG8=" }));
    await flush();
    expect(called).toBe(false);
    expect(ctx.posted).toHaveLength(0);
  });

  it("attachImage surfaces a persistence failure as a blocking error", async () => {
    const ctx = fakeCtx("t-abc123");
    const t = target({ putTaskStudioImage: async () => { throw new Error("disk full"); } });
    handleTaskStudioDomainMessage(t, ctx, msg({ type: "attachImage", mediaType: "image/png", source: "paste", dataBase64: "aGVsbG8=" }));
    await flush();
    const errors = findType(ctx.posted, "error") as Array<{ message: string; blocking: boolean }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("disk full");
    expect(errors[0]!.blocking).toBe(true);
  });

  it("storeSketch posts attachmentStored on success, forwarding the attachmentId/baseImage fields", async () => {
    const ctx = fakeCtx("t-abc123");
    let received: unknown;
    const t = target({ putTaskStudioSketch: async (id, input) => { received = { id, ...input }; return fakeImageResult(); } });
    handleTaskStudioDomainMessage(t, ctx, msg({
      type: "storeSketch",
      attachmentId: "att-9",
      name: "Sketch",
      source: "blank",
      sceneJson: "{}",
      previewBase64: "aGVsbG8=",
    }));
    await flush();
    expect(findType(ctx.posted, "attachmentStored")).toHaveLength(1);
    expect(received).toMatchObject({ id: "t-abc123", attachmentId: "att-9", name: "Sketch", source: "blank" });
  });

  it("storeSketch is a no-op when there is no current entityId", async () => {
    const ctx = fakeCtx(undefined);
    let called = false;
    const t = target({ putTaskStudioSketch: async () => { called = true; return fakeImageResult(); } });
    handleTaskStudioDomainMessage(t, ctx, msg({ type: "storeSketch", name: "Sketch", source: "blank", sceneJson: "{}", previewBase64: "aGVsbG8=" }));
    await flush();
    expect(called).toBe(false);
  });

  it("importPrototype no-ops when there is no current entityId", async () => {
    const root = mkroot();
    const file = path.join(root, "proto.html");
    fs.writeFileSync(file, "<html></html>");
    __setOpenDialogResult([Uri.file(file)]);
    const ctx = fakeCtx(undefined);
    let called = false;
    const t = target({ importTaskStudioPrototype: async () => { called = true; } });
    handleTaskStudioDomainMessage(t, ctx, { type: "importPrototype" });
    await flush();
    expect(called).toBe(false);
  });

  it("importPrototype reads the picked HTML file and calls the target with its title", async () => {
    const root = mkroot();
    const file = path.join(root, "prototype.html");
    fs.writeFileSync(file, "<html><body>hi</body></html>");
    __setOpenDialogResult([Uri.file(file)]);
    const ctx = fakeCtx("t-abc123");
    let received: { html: string; title: string } | undefined;
    const t = target({ importTaskStudioPrototype: async (id, input) => { expect(id).toBe("t-abc123"); received = input; } });
    handleTaskStudioDomainMessage(t, ctx, { type: "importPrototype" });
    await flush();
    expect(received?.title).toBe("prototype.html");
    expect(received?.html).toContain("hi");
    expect(ctx.posted).toHaveLength(0);
  });

  it("importPrototype rejects a file over the 512 KB limit without calling the target", async () => {
    const root = mkroot();
    const file = path.join(root, "big.html");
    fs.writeFileSync(file, "A".repeat(600 * 1024));
    __setOpenDialogResult([Uri.file(file)]);
    const ctx = fakeCtx("t-abc123");
    let called = false;
    const t = target({ importTaskStudioPrototype: async () => { called = true; } });
    handleTaskStudioDomainMessage(t, ctx, { type: "importPrototype" });
    await flush();
    expect(called).toBe(false);
    const errors = findType(ctx.posted, "error") as Array<{ message: string }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/524288 bytes/);
  });

  it("ignores an unrecognized message type without throwing", () => {
    const ctx = fakeCtx("t-abc123");
    expect(() => handleTaskStudioDomainMessage(target(), ctx, { type: "bogus" })).not.toThrow();
    expect(ctx.posted).toHaveLength(0);
  });
});
