import { describe, it, expect, beforeEach, vi } from "vitest";
import { window } from "vscode";
import type { ExtensionContext } from "vscode";
import { __createdPanels, __registeredWebviewPanelSerializers, __resetVscodeMock } from "../mocks/vscode.js";
import { registerTrustedPanelSerializer } from "../../src/webview/shared/panelSerializer.js";

beforeEach(() => __resetVscodeMock());

describe("registerTrustedPanelSerializer", () => {
  it("disposes stale panels and swallows revive failures during reload", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as ExtensionContext;
    registerTrustedPanelSerializer(context, "tachyonPlugins", async () => {
      throw new Error("workspace missing for wsHash");
    });
    window.createWebviewPanel("tachyonPlugins", "ws-1", undefined as never);
    const panel = __createdPanels[0];

    await expect(__registeredWebviewPanelSerializers[0].serializer.deserializeWebviewPanel(panel, {
      schemaVersion: 1,
      view: "tachyonPlugins",
    })).resolves.toBeUndefined();

    expect(panel.disposed).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "[tachyon] failed to revive webview panel 'tachyonPlugins'; disposing stale panel",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("disposes panels with untrusted serialized state without calling revive", async () => {
    const revive = vi.fn();
    const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as ExtensionContext;
    registerTrustedPanelSerializer(context, "tachyonPlugins", revive);
    window.createWebviewPanel("tachyonPlugins", "ws-1", undefined as never);
    const panel = __createdPanels[0];

    await __registeredWebviewPanelSerializers[0].serializer.deserializeWebviewPanel(panel, {
      schemaVersion: 1,
      view: "otherView",
    });

    expect(panel.disposed).toBe(true);
    expect(revive).not.toHaveBeenCalled();
  });
});
