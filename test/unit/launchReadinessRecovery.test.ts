import { describe, expect, it } from "vitest";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { CodexLaunchReadiness } from "../../src/runtime/adapters/codexLaunchReadiness.js";

describe("CodexLaunchReadiness", () => {
  it("t-40a28c: recognizes the rotating composer plus stable footer used by Codex 0.144.1", () => {
    const adapter = new CodexLaunchReadiness();
    const pane = [
      "• Working (1m 11s • esc to interrupt)",
      "",
      "› Implement {feature}",
      "",
      "  gpt-5.6-sol xhigh · ~/tachyon · main · Full Access · Context 61% used · weekly 71% left",
    ].join("\n");

    expect(adapter.classify(pane)).toEqual({ state: "ready" });
  });

  it("does not accept a transcript prompt or footer alone, and rejection still wins", () => {
    const adapter = new CodexLaunchReadiness();
    expect(adapter.classify("› Implement {feature}\n• Booting MCP server")).toBeUndefined();
    expect(adapter.classify("gpt-5.6-sol · Context 0% used")).toBeUndefined();
    expect(adapter.classify("› Implement {feature}\nContext 0% used\nAuthentication failed")).toEqual({
      state: "rejected",
      code: "runtime_auth_rejected",
    });
  });
});

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
    pane = "› Implement {feature}\n\n  gpt-5.6-sol xhigh · Context 61% used";
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
