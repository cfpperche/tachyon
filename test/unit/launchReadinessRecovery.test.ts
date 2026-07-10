import { describe, expect, it } from "vitest";
import { AgentManager } from "../../src/agents/AgentManager.js";

describe("Codex readiness recovery", () => {
  it("re-observes a declared live Codex session after manager memory is lost", async () => {
    const sessions = new Set(["tachyon-test-codex"]);
    let pane = "Starting Codex";
    let killed = false;
    const tmux = {
      hasSession: async (name: string) => sessions.has(name),
      capturePane: async () => pane,
      killSession: async (name: string) => { killed = sessions.delete(name); },
    };
    const manager = new AgentManager({
      tmux: tmux as never,
      workspaceRoot: "/workspace",
      wsHash: "test",
      getConfig: () => ({
        agents: { codex: { cmd: "codex", kind: "agent" } },
        settings: { maxAgents: 4 },
        declaredOwner: {},
      }) as never,
      getMaxAgents: () => 4,
    });

    await expect(manager.isReady("codex")).resolves.toBe(false);
    pane = "› Ask anything";
    await expect(manager.isReady("codex")).resolves.toBe(true);
    pane = "Authentication failed";
    const restartedManager = new AgentManager({
      tmux: tmux as never,
      workspaceRoot: "/workspace",
      wsHash: "test",
      getConfig: () => ({ agents: { codex: { cmd: "codex", kind: "agent" } }, settings: { maxAgents: 4 }, declaredOwner: {} }) as never,
      getMaxAgents: () => 4,
    });
    await expect(restartedManager.isReady("codex")).resolves.toBe(false);
    expect(killed).toBe(true);
  });

  it("does not gate unknown, non-Codex, or non-running declared agents", async () => {
    const manager = new AgentManager({
      tmux: { hasSession: async () => false } as never,
      workspaceRoot: "/workspace",
      wsHash: "test",
      getConfig: () => ({
        agents: {
          claude: { cmd: "claude", kind: "agent" },
          stoppedCodex: { cmd: "codex", kind: "agent" },
        },
        settings: { maxAgents: 4 },
        declaredOwner: {},
      }) as never,
      getMaxAgents: () => 4,
    });

    await expect(manager.isReady("unknown")).resolves.toBe(true);
    await expect(manager.isReady("claude")).resolves.toBe(true);
    await expect(manager.isReady("stoppedCodex")).resolves.toBe(true);
  });
});
