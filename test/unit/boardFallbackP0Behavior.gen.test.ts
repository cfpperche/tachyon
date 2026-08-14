import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TaskStore } from "@tachyon/engine/tasks/TaskStore.js";
import { ValidationStore } from "@tachyon/engine/validations/ValidationStore.js";
import { BOARD_AGENT_LIST_TIMEOUT_MS, BoardAgentLists, buildBoardVm } from "../../apps/vscode-extension/src/webview/board/boardVm.js";
import { legacyBoardTarget } from "../../apps/vscode-extension/src/shell/BoardTarget.js";
import type { Workspace } from "@tachyon/engine/workspace/Workspace.js";

// t-610705 Phase B #6 — retargeted from the retired BoardPanelManager to the ported
// bounded-liveness pass in src/webview/board/boardVm.ts (Control → Mission is the one board now).
// Same P0 behavior pinned: the board renders its task data even when agent listing never resolves.

describe("container-generated delegation behavior", () => {
  it("Mission board renders tasks when agent listing never resolves", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "board-fallback-"));
    vi.useFakeTimers();
    try {
      const ws = {
        wsHash: "ws-fallback",
        folderName: "Fallback project",
        workspaceRoot: root,
        taskStore: new TaskStore(root),
        validationStore: new ValidationStore(root),
        config: { agents: { codex: {} } },
        manager: { list: () => new Promise<never>(() => {}), listAgents: () => new Promise<never>(() => {}) },
      } as unknown as Workspace;
      const task = await ws.taskStore.create({ title: "Task data wins", author: "human" });
      const targetWs = legacyBoardTarget(ws);

      const vmPromise = buildBoardVm(targetWs, new BoardAgentLists(), () => {});
      let settled = false;
      void vmPromise.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(BOARD_AGENT_LIST_TIMEOUT_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const vm = await vmPromise;
      expect(vm).toMatchObject({
        agentLiveness: { status: "unavailable" },
        snapshot: {
          views: [{ task: { id: task.id, title: "Task data wins" } }],
          chips: [{ agent: "codex" }, { agent: "human" }],
        },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
