import { describe, expect, it, vi } from "vitest";
import { stopAgentSessionForDelete } from "../../src/engine-service/extensionOperationService.js";

function sessionManager(dead: boolean, removeOnKill = true) {
  const states = new Map<string, { dead: boolean; exitCode?: number }>([
    ["codex-canonico", dead ? { dead: true, exitCode: 0 } : { dead: false }],
  ]);
  return {
    states,
    manager: {
      agentStates: vi.fn(async () => new Map(states)),
      kill: vi.fn(async (agent: string) => {
        if (removeOnKill) states.delete(agent);
      }),
    },
  };
}

describe("Fleet agent deletion session teardown", () => {
  it.each([
    ["running", false],
    ["stopped remain-on-exit", true],
  ])("removes a %s canonical-agent pane before forget", async (_label, dead) => {
    const { manager } = sessionManager(dead);

    await expect(stopAgentSessionForDelete(manager, "codex-canonico")).resolves.toBeUndefined();

    expect(manager.kill).toHaveBeenCalledWith("codex-canonico");
    expect((await manager.agentStates()).has("codex-canonico")).toBe(false);
  });

  it("does nothing when the agent has no tmux session", async () => {
    const { manager, states } = sessionManager(false);
    states.clear();

    await expect(stopAgentSessionForDelete(manager, "codex-canonico")).resolves.toBeUndefined();

    expect(manager.kill).not.toHaveBeenCalled();
  });

  it("fails closed when session teardown does not remove the pane", async () => {
    const { manager } = sessionManager(true, false);

    await expect(stopAgentSessionForDelete(manager, "codex-canonico"))
      .rejects.toThrow("could not stop 'codex-canonico' — it was not removed");
  });
});
