import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { registerTools, type BridgeDeps } from "../../src/bridge/tools.js";
import { readDoorbellEvents } from "../../src/bridge/doorbell.js";

/** A fake MCP server that just captures tool handlers (mirrors test/unit/probeBridge.test.ts). */
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

function wireNotifyAgent(deps: Partial<BridgeDeps> & { workspaceRoot: string }) {
  const mcp = new FakeMcp();
  registerTools(mcp as never, deps as BridgeDeps);
  const handler = mcp.handlers.get("notify_agent");
  if (!handler) throw new Error("notify_agent not registered");
  return handler;
}

function tmpRoot(): string {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), "snbell-notify-behavior-"));
}

describe("container-generated delegation behavior", () => {
  it("notify_agent fails fast with a clear error when a preflight await hangs instead of hanging until the client timeout", async () => {
    vi.useFakeTimers();
    try {
      const workspaceRoot = tmpRoot();
      // deps.tmux.hasSession never resolves — the live repro (t-5f80c6): a preflight await hanging
      // upstream of appendDoorbellEvent, under host load, with no bound of its own (see
      // TmuxService.defaultExecutor, which passes execFile no timeout).
      const hasSession = () => new Promise<boolean>(() => {});
      const notifyAgent = wireNotifyAgent({
        workspaceRoot,
        manager: {
          kindOf: () => "agent",
          session: (name: string) => `session-${name}`,
        } as unknown as BridgeDeps["manager"],
        tmux: { hasSession } as unknown as BridgeDeps["tmux"],
      });

      const callPromise = notifyAgent({ to: "recipient", summary: "done", agent: "claude" });
      // Let the handler run up to the bounded timeout instead of hanging to the client's ~300s ceiling.
      await vi.advanceTimersByTimeAsync(5000);
      const result = await callPromise;

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/preflight timed out/);

      // Durability half: the doorbell was witnessed on disk despite the preflight failure — a child that
      // DID call notify_agent must never be penalized (protocol_doorbell_missed) just because tmux hung.
      const events = readDoorbellEvents(workspaceRoot);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ from: "claude", to: "recipient" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("notify_agent: the normal fast path is unchanged — delivered/queued as before, with a single doorbell entry", async () => {
    const workspaceRoot = tmpRoot();
    const delivered: Array<{ to: string; line: string }> = [];
    const notifyAgent = wireNotifyAgent({
      workspaceRoot,
      manager: {
        kindOf: () => "agent",
        session: (name: string) => `session-${name}`,
      } as unknown as BridgeDeps["manager"],
      tmux: { hasSession: async () => true } as unknown as BridgeDeps["tmux"],
      deliverNotice: async (to: string, line: string) => {
        delivered.push({ to, line });
        return { status: "queued" as const };
      },
    });

    const result = await notifyAgent({ to: "recipient", summary: "done", agent: "claude" });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("queued 'recipient' for idle delivery");
    expect(delivered).toHaveLength(1);

    const events = readDoorbellEvents(workspaceRoot);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from: "claude", to: "recipient" });
  });
});
