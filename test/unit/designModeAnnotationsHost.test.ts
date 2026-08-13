import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { IdeBrowserBridgeManager } from "../../src/webview/ide-browser-bridge/manager.js";

// Exercise the production queue handler while replacing only its CDP delivery edge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ManagerHarness = any;

describe("Design Mode host annotation batch", () => {
  let root: string;
  let manager: ManagerHarness;
  let evaluateInPage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (vscode as unknown as { debug: unknown }).debug = {
      onDidTerminateDebugSession: () => ({ dispose() {} }),
      onDidStartDebugSession: () => ({ dispose() {} }),
      activeDebugSession: undefined,
      startDebugging: async () => false,
      stopDebugging: async () => {},
    };
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-annotations-host-"));
    manager = new IdeBrowserBridgeManager(root, { appendLine() {} } as unknown as vscode.OutputChannel);
    evaluateInPage = vi.fn(async () => undefined);
    manager.session.cdp.evaluateInPage = evaluateInPage;
  });

  afterEach(async () => {
    await manager.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("owns indexes, strips screenshots, syncs, and deletes", async () => {
    const capture = { target: { selector: "#cta", tag: "BUTTON" }, screenshot: "data:image/png;base64,large", screenshotPath: "/tmp/pick.png" };
    await manager.handleDesignPickRaw(JSON.stringify({ __annotation: "add", intent: "change", comment: "  Clarify this action  ", capture }));

    expect(manager.designAnnotations).toEqual([{ target: { selector: "#cta", tag: "BUTTON" }, index: 1, intent: "change", comment: "Clarify this action" }]);
    expect(evaluateInPage).toHaveBeenLastCalledWith(expect.stringContaining('"index":1'));
    expect(evaluateInPage).toHaveBeenLastCalledWith(expect.not.stringContaining("screenshot"));

    evaluateInPage.mockClear();
    await manager.handleDesignPickRaw(JSON.stringify({ __annotation: "sync" }));
    expect(evaluateInPage).toHaveBeenCalledOnce();

    await manager.handleDesignPickRaw(JSON.stringify({ __annotation: "delete", index: 1 }));
    expect(manager.designAnnotations).toEqual([]);
    expect(manager.nextDesignAnnotationIndex).toBe(2);
    expect(evaluateInPage).toHaveBeenLastCalledWith(expect.stringContaining("([])"));
  });
});
