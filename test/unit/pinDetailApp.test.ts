import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { PinDetailPanelManager } from "../../apps/vscode-extension/src/webview/PinDetailPanel.js";
import type { WorkspaceSidebarTarget } from "../../apps/vscode-extension/src/shell/SidebarTarget.js";
import type { WorkspacePinStudioTarget } from "../../apps/vscode-extension/src/shell/PinStudioTarget.js";

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
  it("stages creation in one document: cancel closes without saving, save keeps the same panel identity", async () => {
    const saves: Array<[string | undefined, unknown]> = [];
    const createStudio = {
      ...studio,
      loadPinStudio: async (pinId: string | undefined) => ({
        workspaceHash: "ws-a", folder: "A", pinId, title: "", tags: [], doc: null, attachments: [],
      }),
      savePinStudio: async (pinId: string | undefined, patch: unknown) => { saves.push([pinId, patch]); return { status: "ok" as const }; },
    } as unknown as WorkspacePinStudioTarget;
    const manager = new PinDetailPanelManager(Uri.file("/ext"), () => [reader], () => [createStudio], () => undefined);

    manager.openCreate("ws-a", "p-new001");
    expect(__createdPanels).toHaveLength(1);
    expect(manager.openKeys).toEqual(["tachyonPinPreview|ws-a|p-new001"]);
    __createdPanels[0].webview.__receive({ studioProtocolVersion: 1, type: "cancel" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saves).toHaveLength(0);
    expect(__createdPanels[0].disposed).toBe(true);

    manager.openCreate("ws-a", "p-new002");
    const panel = __createdPanels[1];
    panel.webview.__receive({ studioProtocolVersion: 1, type: "patch", patch: { title: "New pin", tags: [], doc: { type: "doc", content: [] }, attachments: [] } });
    panel.webview.__receive({ studioProtocolVersion: 1, type: "save" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saves[0]?.[0]).toBe("p-new002");
    expect(panel.disposed).toBe(false);
    expect(manager.openKeys).toEqual(["tachyonPinPreview|ws-a|p-new002"]);
  });

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

describe("Add pin lands in edit mode without racing the client (t-883386)", () => {
  /**
   * The defect: `openCreate` posted the edit-mode message on the line after `manager.open()`, so it
   * fired before the webview bundle had mounted and reached no listener. The client stayed in read
   * mode over a pin with nothing on disk — the tab rendered blank. The maintainer found it by
   * clicking Add pin in 0.56.169.
   *
   * The mode is derived from `provisional` now and announced on the client's own READY, so these
   * assert the ORDER as much as the value: nothing that matters may be posted before READY arrives.
   */
  const modesPostedTo = (panel: typeof __createdPanels[number]) =>
    panel.webview.posted.filter((m) => (m as { type?: string }).type === "pinDocumentMode");

  it("posts no mode before the client says READY — the post that used to be lost", () => {
    const manager = make();
    manager.openCreate("ws-a", "p-race01");

    expect(
      modesPostedTo(__createdPanels[0]),
      "a mode posted before READY reaches no listener; that is the whole defect",
    ).toEqual([]);
  });

  it("announces EDIT once the client is listening, so a brand-new pin shows its form", async () => {
    const manager = make();
    manager.openCreate("ws-a", "p-race02");
    const panel = __createdPanels[0];

    panel.webview.__receive({ type: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(modesPostedTo(panel).at(-1)).toMatchObject({ mode: "edit" });
  });

  it("announces READ for a pin that exists — the mode follows the entity, not the door", async () => {
    const manager = make();
    manager.open("ws-a", "p-existing");
    const panel = __createdPanels[0];

    panel.webview.__receive({ type: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(modesPostedTo(panel).at(-1)).toMatchObject({ mode: "read" });
  });
});
