import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { PinDetailPanelManager } from "../../src/webview/PinDetailPanel.js";
import type { WorkspaceSidebarTarget } from "../../src/shell/SidebarTarget.js";
import type { WorkspacePinStudioTarget } from "../../src/shell/PinStudioTarget.js";

const reader = {
  wsHash: "ws-a",
  folderName: "A",
  workspaceRoot: "/a",
  loadPinPreview: async (id: string) => ({ id, title: "Pin", done: false, tags: [], doc: null, attachments: [] }),
} as unknown as WorkspaceSidebarTarget;

const studio = {
  wsHash: "ws-a",
  folderName: "A",
  workspaceRoot: "/a",
  loadPinStudio: async (pinId: string) => ({
    workspaceHash: "ws-a", folder: "A", pinId, title: "Pin", tags: [], doc: null, attachments: [], expectUpdatedAt: "rev-1",
  }),
  savePinStudio: async () => ({ status: "ok" as const }),
} as unknown as WorkspacePinStudioTarget;

const make = () => new PinDetailPanelManager(Uri.file("/ext"), () => [reader], () => [studio], () => undefined);

beforeEach(() => __resetVscodeMock());
afterEach(() => { for (const panel of __createdPanels) if (!panel.disposed) panel.dispose(); });

describe("SDD 485 D14 — one Pins document app", () => {
  it("keys read and edit by the same pin identity and reveals instead of duplicating", () => {
    const manager = make();
    manager.openEdit("ws-a", "p-abc123");
    manager.open("ws-a", "p-abc123");

    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
    expect(manager.openKeys).toEqual(["tachyonPinPreview|ws-a|p-abc123"]);
  });

  it("keeps different pin identities in different panels", () => {
    const manager = make();
    manager.open("ws-a", "p-abc123");
    manager.open("ws-a", "p-def456");
    expect(__createdPanels).toHaveLength(2);
  });
});
