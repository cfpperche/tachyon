import { describe, expect, it } from "vitest";
import { registerTools, type BridgeDeps } from "@tachyon/engine/bridge/tools.js";
import { makeTempDir } from "../helpers/tempDir.js";

/**
 * t-44ae02 — the only cheap place that reaches a still-working sender is the notify_agent
 * receipt. Measured on t-747369: grokdedup sent four follow-ups in 4.5 min while the first
 * was already queued, because the receipt said only `queued for idle delivery`.
 */
class FakeMcp {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>>();
  registerTool(
    name: string,
    _def: unknown,
    handler: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>,
  ) {
    this.handlers.set(name, handler);
  }
}

function wireNotifyAgent(
  deliverNotice: NonNullable<BridgeDeps["deliverNotice"]>,
) {
  const mcp = new FakeMcp();
  registerTools(mcp as never, {
    workspaceRoot: makeTempDir("notify-queued-receipt-"),
    manager: {
      kindOf: () => "agent",
      session: (name: string) => `session-${name}`,
      isReady: async () => true,
    } as unknown as BridgeDeps["manager"],
    tmux: { hasSession: async () => true } as unknown as BridgeDeps["tmux"],
    deliverNotice,
  } as BridgeDeps);
  const handler = mcp.handlers.get("notify_agent");
  if (!handler) throw new Error("notify_agent not registered");
  return handler;
}

function receiptText(result: { content: { type: string; text: string }[] }): string {
  return JSON.stringify(result.content);
}

describe("t-44ae02 — queued notify_agent receipt names depth and oldest age", () => {
  it("idle-queued receipt names queue depth and oldest age", async () => {
    const notifyAgent = wireNotifyAgent(async () => ({
      status: "queued",
      queued: 4,
      oldestCreatedAt: Date.now() - 8 * 60_000,
    }));

    const result = await notifyAgent({ to: "recipient", summary: "done", agent: "claude" });

    expect(result.isError).toBeFalsy();
    const text = receiptText(result);
    expect(text).toContain("queued 'recipient' for idle delivery");
    expect(text).toContain("depth 4");
    expect(text).toContain("oldest 8m");
  });

  it("held-human-draft receipt also names queue depth and oldest age", async () => {
    const notifyAgent = wireNotifyAgent(async () => ({
      status: "queued",
      queued: 2,
      oldestCreatedAt: Date.now() - 3 * 60_000,
      heldFor: "human-draft",
    }));

    const result = await notifyAgent({ to: "recipient", summary: "done", agent: "claude" });

    expect(result.isError).toBeFalsy();
    const text = receiptText(result);
    expect(text).toContain("receipt: held-human-draft");
    expect(text).toContain("depth 2");
    expect(text).toContain("oldest 3m");
  });
});
