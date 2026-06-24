import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock, __setOpenDialogResult } from "../mocks/vscode.js";
import { PinStore } from "../../src/pins/PinStore.js";
import { PinStudioPanelManager } from "../../src/webview/PinStudioPanel.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import type { PinStudioAttachmentVM } from "../../src/webview/pin-studio/types.js";

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-studio-panel-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeWorkspace(root = mkroot()) {
  return {
    wsHash: "abc123",
    folderName: "Project",
    workspaceRoot: root,
    pinStore: new PinStore(root),
  } as unknown as Workspace;
}

describe("PinStudioPanelManager", () => {
  it("reveals an existing editor for the same rich pin instead of opening a second panel", () => {
    const ws = fakeWorkspace();
    const pin = ws.pinStore.create("reuse me", "human");
    const manager = new PinStudioPanelManager(Uri.file("/ext"), () => {});

    manager.openExisting(ws, pin.id);
    manager.openExisting(ws, pin.id);

    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
  });

  it("saves a new text-only pin without creating a rich detail file", () => {
    let refreshed = 0;
    const ws = fakeWorkspace();
    const manager = new PinStudioPanelManager(Uri.file("/ext"), () => { refreshed += 1; });

    manager.openNew(ws);
    __createdPanels[0].webview.__receive({ type: "save", title: "just text", doc: { type: "doc", content: [{ type: "paragraph" }] }, attachments: [] });

    const [pin] = ws.pinStore.list();
    expect(pin.text).toBe("just text");
    expect("detail" in pin).toBe(false);
    expect("attachmentCount" in pin).toBe(false);
    expect(fs.existsSync(ws.pinStore.detailPath(pin.id))).toBe(false);
    expect(refreshed).toBe(1);
    expect(__createdPanels[0].disposed).toBe(true);
  });

  it("stores pasted image bytes transiently and saves a rich pin without base64 payloads", () => {
    const ws = fakeWorkspace();
    const manager = new PinStudioPanelManager(Uri.file("/ext"), () => {});
    manager.openNew(ws);

    __createdPanels[0].webview.__receive({
      type: "attachImage",
      mediaType: "image/png",
      name: "paste.png",
      source: "paste",
      dataBase64: Buffer.from("paste-image").toString("base64"),
    });

    const storedMsg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "attachmentStored") as { attachment: PinStudioAttachmentVM };
    expect(JSON.stringify(storedMsg)).not.toMatch(/base64|data:image/);
    const { path: _path, available: _available, uri: _uri, ...storedAttachment } = storedMsg.attachment;
    __createdPanels[0].webview.__receive({
      type: "save",
      title: "with image",
      doc: { type: "doc", content: [{ type: "image", attrs: { src: `tachyon-pin-attachment:${storedAttachment.id}`, attachmentId: storedAttachment.id, blobRef: storedAttachment.blobRef } }] },
      attachments: [storedAttachment],
    });

    const [pin] = ws.pinStore.list();
    expect(pin).toMatchObject({ text: "with image", detail: true, attachmentCount: 1 });
    expect(ws.pinStore.readDetail(pin.id).attachments[0]).toMatchObject({ available: true, path: `.tachyon/pins/blobs/${storedAttachment.blobRef}` });
  });

  it("imports a local image through the host file picker path", async () => {
    const root = mkroot();
    const img = path.join(root, "import.png");
    fs.writeFileSync(img, "import-image");
    const ws = fakeWorkspace(root);
    const manager = new PinStudioPanelManager(Uri.file("/ext"), () => {});
    __setOpenDialogResult([Uri.file(img)]);

    manager.openNew(ws);
    __createdPanels[0].webview.__receive({ type: "importImage" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const storedMsg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "attachmentStored") as { attachment: PinStudioAttachmentVM };
    expect(storedMsg.attachment).toMatchObject({ mediaType: "image/png", name: "import.png", source: "import", available: true });
  });
});
