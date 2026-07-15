import { describe, expect, it, vi } from "vitest";
import { sendManagedAgentInput } from "../../src/agents/agentInputService.js";
import type { ManagedEntryInfo } from "../../src/agents/AgentManager.js";

describe("managed agent input service", () => {
  it("revalidates one live AI agent and sends the exact submit intent", async () => {
    const sendKeys = vi.fn(async () => undefined);
    const source = sourceWith([row("reviewer", { running: true })], sendKeys);

    await expect(sendManagedAgentInput(source, "reviewer", "review this", false)).resolves.toBeUndefined();
    expect(sendKeys).toHaveBeenCalledWith("tachyon-reviewer", "review this", false);
  });

  it("refuses terminal, stopped and stopping targets without touching tmux", async () => {
    for (const target of [
      row("terminal", { kind: "terminal", running: true }),
      row("stopped"),
      row("stopping", { running: true, stopping: true }),
    ]) {
      const sendKeys = vi.fn(async () => undefined);
      const source = sourceWith([target], sendKeys);
      await expect(sendManagedAgentInput(source, target.name, "context", true)).rejects.toThrow(/not (a managed AI agent|available for input)/);
      expect(sendKeys).not.toHaveBeenCalled();
    }
  });
});

function sourceWith(rows: ManagedEntryInfo[], sendKeys: (session: string, text: string, submit: boolean) => Promise<void>) {
  return {
    manager: {
      list: async () => rows,
      session: (agent: string) => `tachyon-${agent}`,
    },
    tmux: { sendKeys },
  };
}

function row(name: string, overrides: Partial<ManagedEntryInfo> = {}): ManagedEntryInfo {
  return {
    name,
    session: `tachyon-${name}`,
    running: false,
    stopping: false,
    stopFailed: false,
    declared: true,
    dead: false,
    crashed: false,
    kind: "agent",
    ...overrides,
  };
}
