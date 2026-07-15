import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import { MISSION_CONTROL_AGENT_LIST_TIMEOUT_MS, MissionControlPanelManager } from "../../src/webview/MissionControlPanel.js";
import { legacyMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

describe("container-generated delegation behavior", () => {
  it("Mission Control renders tasks when agent listing never resolves", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-control-fallback-"));
    vi.useFakeTimers();
    __resetVscodeMock();
    try {
      const ws = {
        wsHash: "ws-fallback",
        folderName: "Fallback project",
        workspaceRoot: root,
        taskStore: new TaskStore(root),
        validationStore: new ValidationStore(root),
        config: { agents: { codex: {} } },
        manager: { list: () => new Promise<never>(() => {}) },
      } as unknown as Workspace;
      const task = await ws.taskStore.create({ title: "Task data wins", author: "human" });
      const manager = new MissionControlPanelManager(Uri.file("/ext"), () => [legacyMissionControlTarget(ws)], () => {}, () => {}, () => {});

      manager.open(ws.wsHash);
      await vi.advanceTimersByTimeAsync(MISSION_CONTROL_AGENT_LIST_TIMEOUT_MS - 1);
      expect(__createdPanels[0].webview.posted).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      const message = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "snapshot");
      expect(message).toMatchObject({
        vm: {
          agentLiveness: { status: "unavailable" },
          snapshot: {
            views: [{ task: { id: task.id, title: "Task data wins" } }],
            chips: [{ agent: "codex" }, { agent: "human" }],
          },
        },
      });
      expect(vi.getTimerCount()).toBe(0);
      manager.dispose();
    } finally {
      vi.useRealTimers();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
