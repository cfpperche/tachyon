import { describe, expect, it, vi } from "vitest";
import { sendManagedAgentInput } from "../../src/agents/agentInputService.js";
import type { ManagedEntryInfo } from "../../src/agents/AgentManager.js";

describe("managed agent input service", () => {
  it("revalidates one live AI agent and sends the exact submit intent", async () => {
    const sendSubmittedLine = vi.fn(async () => ({ status: "submitted" as const, reason: "composer-cleared" as const, attempts: 1 }));
    const source = sourceWith([row("reviewer", { running: true })], sendSubmittedLine);

    await expect(sendManagedAgentInput(source, "reviewer", "review this", true)).resolves.toMatchObject({ status: "submitted" });
    expect(sendSubmittedLine).toHaveBeenCalledWith("tachyon-reviewer", "review this", { composer: undefined });
  });

  it("refuses terminal, stopped and stopping targets without touching tmux", async () => {
    for (const target of [
      row("terminal", { kind: "terminal", running: true }),
      row("stopped"),
      row("stopping", { running: true, stopping: true }),
    ]) {
      const sendSubmittedLine = vi.fn(async () => ({ status: "submitted" as const, reason: "no-stranded-line" as const, attempts: 1 }));
      const source = sourceWith([target], sendSubmittedLine);
      await expect(sendManagedAgentInput(source, target.name, "context", true)).rejects.toThrow(/not (a managed AI agent|available for input)/);
      expect(sendSubmittedLine).not.toHaveBeenCalled();
    }
  });
});

function sourceWith(rows: ManagedEntryInfo[], sendSubmittedLine: (session: string, text: string, options: { composer?: unknown }) => Promise<{ status: "submitted"; reason: "composer-cleared" | "no-stranded-line"; attempts: number }>) {
  return {
    manager: {
      list: async () => rows,
      session: (agent: string) => `tachyon-${agent}`,
    },
    tmux: { sendKeys: async () => undefined, sendSubmittedLine },
  };
}

function row(name: string, overrides: Partial<ManagedEntryInfo> = {}): ManagedEntryInfo {
  return {
    name,
    session: `tachyon-${name}`,
    running: false,
    stopping: false,
    stopFailed: false,
    lifetime: "saved", resumePolicy: "restartable",
    dead: false,
    crashed: false,
    kind: "agent",
    ...overrides,
  };
}
