import { describe, expect, it, vi } from "vitest";
import { stopAgentSessionForDelete } from "@tachyon/engine/agents/agentRemovalCascade.js";
import type { AgentOccupancyVerdict } from "@tachyon/engine/agents/AgentManager.js";

function sessionManager(dead: boolean, removeOnKill = true) {
  const states = new Map<string, { dead: boolean; exitCode?: number }>([
    ["codex-canonico", dead ? { dead: true, exitCode: 0 } : { dead: false }],
  ]);
  return {
    states,
    manager: {
      probeAgentOccupancy: vi.fn(async (agent: string): Promise<AgentOccupancyVerdict> => {
        const state = states.get(agent);
        if (!state) return { state: "free" };
        return { state: "occupied", detail: state.dead ? "a stopped pane is still present in tmux" : "the session is running" };
      }),
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
    const { manager, states } = sessionManager(dead);

    await expect(stopAgentSessionForDelete(manager, "codex-canonico")).resolves.toBeUndefined();

    expect(manager.kill).toHaveBeenCalledWith("codex-canonico");
    expect(states.has("codex-canonico")).toBe(false);
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

  /**
   * t-4736b4 — the teardown gate must not confuse "I could not measure" with "it is still there".
   * The two refusals send the human to different places, so they are different messages.
   */
  it("t-4736b4 refuses an unmeasurable occupancy with the unverifiable message, not 'still running'", async () => {
    const manager = {
      probeAgentOccupancy: vi.fn(async (): Promise<AgentOccupancyVerdict> => ({
        state: "unknown",
        detail: "the tmux session inventory could not be read after 3 attempts",
      })),
      kill: vi.fn(async () => undefined),
    };

    const failure = await stopAgentSessionForDelete(manager, "codex-canonico").catch((error: Error) => error);

    expect((failure as Error).message).toContain("occupancy unverifiable");
    expect((failure as Error).message).not.toContain("it was not removed");
  });

  /**
   * t-4736b4 — and once tmux answers again, the same call goes through: the refusal is decided from a
   * fresh measurement every time, so it can never become a permanent state with no way out.
   */
  it("t-4736b4 succeeds on the retry after the inventory recovers", async () => {
    const verdicts: AgentOccupancyVerdict[] = [
      { state: "unknown", detail: "the tmux session inventory could not be read after 3 attempts" },
      { state: "unknown", detail: "the tmux session inventory could not be read after 3 attempts" },
      { state: "free" },
    ];
    let call = 0;
    const manager = {
      probeAgentOccupancy: vi.fn(async (): Promise<AgentOccupancyVerdict> => verdicts[Math.min(call++, verdicts.length - 1)]!),
      kill: vi.fn(async () => undefined),
    };

    await expect(stopAgentSessionForDelete(manager, "codex-canonico")).rejects.toThrow("occupancy unverifiable");
    await expect(stopAgentSessionForDelete(manager, "codex-canonico")).resolves.toBeUndefined();
  });
});
