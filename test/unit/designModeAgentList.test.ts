import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { IdeBrowserBridgeManager } from "../../src/webview/ide-browser-bridge/manager.js";

// Private production doors reached deliberately: the injected page calls pushAgentsToPage.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ManagerHarness = any;

describe("Design Mode agent-list honesty (t-a4060b)", () => {
  let root: string;
  let manager: ManagerHarness;
  let pushed: Array<Record<string, unknown>>;
  let logLines: string[];

  beforeEach(() => {
    (vscode as unknown as { debug: unknown }).debug = {
      onDidTerminateDebugSession: () => ({ dispose() {} }),
      onDidStartDebugSession: () => ({ dispose() {} }),
      activeDebugSession: undefined,
      startDebugging: async () => false,
      stopDebugging: async () => {},
    };
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-agent-list-"));
    pushed = [];
    logLines = [];
    manager = new IdeBrowserBridgeManager(root, {
      appendLine: (line: string) => { logLines.push(line); },
    } as unknown as vscode.OutputChannel);
    manager.session.cdp.pushDesignModeChat = async (payload: Record<string, unknown>) => {
      pushed.push(payload);
    };
  });

  afterEach(async () => {
    await manager.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("labels a disconnected page instead of claiming the roster is empty", async () => {
    await manager.pushAgentsToPage();

    expect(pushed).toEqual([expect.objectContaining({
      type: "agents",
      agents: [],
      emptyReason: "Design Mode is disconnected from this page — reopen the IDE Browser.",
    })]);
  });

  it("labels a failed query and records its cause", async () => {
    manager.session.cdp.state = "connected";
    manager.getWorkspace = () => ({
      extension: { query: async () => { throw new Error("engine unavailable"); } },
    });

    await manager.pushAgentsToPage();

    expect(pushed).toEqual([expect.objectContaining({
      agents: [],
      emptyReason: "Could not load running agents: engine unavailable",
    })]);
    expect(logLines).toContain("[design-mode] agent list failed: engine unavailable");
  });

  it("labels a legitimate empty result", async () => {
    manager.session.cdp.state = "connected";
    manager.getWorkspace = () => ({
      extension: { query: async () => [
        { name: "saved-stopped", kind: "agent", lifetime: "saved", running: false, dead: false },
        { name: "temporary-stopped", kind: "agent", lifetime: "temporary", running: false, dead: false },
      ] },
    });

    await manager.pushAgentsToPage();

    expect(pushed).toEqual([expect.objectContaining({
      agents: [],
      emptyReason: "No agents are running.",
    })]);
  });

  it("offers live Saved and Temporary agents and excludes terminals", async () => {
    manager.session.cdp.state = "connected";
    manager.getWorkspace = () => ({
      extension: { query: async () => [
        { name: "claude", kind: "agent", lifetime: "saved", running: true, dead: false },
        { name: "fork", kind: "agent", lifetime: "temporary", running: true, dead: false },
        { name: "shell", kind: "terminal", lifetime: "temporary", running: true, dead: false },
      ] },
    });

    await manager.pushAgentsToPage();

    expect(pushed).toEqual([{ type: "agents", agents: ["claude", "fork"], active: "claude" }]);
  });
});
