import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { IdeBrowserBridgeManager } from "../../apps/vscode-extension/src/webview/ide-browser-bridge/manager.js";

// Private production collaborators are replaced deliberately so this test enters through
// the same page-overlay binding door as production.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ManagerHarness = any;

describe("Design Mode responsive webview presets (t-0807b2)", () => {
  let root: string;
  let manager: ManagerHarness;

  beforeEach(() => {
    (vscode as unknown as { debug: unknown }).debug = {
      onDidTerminateDebugSession: () => ({ dispose() {} }),
      onDidStartDebugSession: () => ({ dispose() {} }),
      activeDebugSession: undefined,
      startDebugging: async () => false,
      stopDebugging: async () => {},
    };
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-responsive-webview-"));
    manager = new IdeBrowserBridgeManager(root, {
      appendLine() {},
    } as unknown as vscode.OutputChannel);
  });

  afterEach(async () => {
    await manager.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(["phone", "tablet", "desktop", "reset"] as const)(
    "routes the %s webview control through the responsive layout handler",
    async (preset) => {
      const setResponsivePreset = vi.fn(async () => undefined);
      manager.session.cdp.setResponsivePreset = setResponsivePreset;

      await manager.handleDesignPickRaw(JSON.stringify({ action: "viewport.set", preset }));

      expect(setResponsivePreset).toHaveBeenCalledOnce();
      expect(setResponsivePreset).toHaveBeenCalledWith(
        preset,
        expect.any(Function),
      );
    },
  );
});
