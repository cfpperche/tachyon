import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { registerTools, type BridgeDeps } from "@tachyon/engine/bridge/tools.js";
import { readDoorbellEvents } from "@tachyon/engine/bridge/doorbell.js";
import { createTmuxExecutor, TMUX_CONTROL_TIMEOUT_MS, TmuxService } from "@tachyon/engine/tmux/TmuxService.js";
import { makeTempDir } from "../helpers/tempDir.js";

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
  return makeTempDir("snbell-notify-behavior-");
}

describe("container-generated delegation behavior", () => {
  it("notify_agent fails fast with a clear error when a preflight await hangs instead of hanging until the client timeout", async () => {
    vi.useFakeTimers();
    try {
      const workspaceRoot = tmpRoot();
      const kill = vi.fn();
      const fakeChild = Object.assign(new EventEmitter(), {
        stdout: { resume: vi.fn() },
        stderr: { resume: vi.fn() },
        kill,
      });
      const execFile = vi.fn((_file, _args, _opts, _cb) => fakeChild);
      const tmux = new TmuxService(createTmuxExecutor(execFile as never), "notify-hang");
      const notifyAgent = wireNotifyAgent({
        workspaceRoot,
        manager: {
          kindOf: () => "agent",
          session: (name: string) => `session-${name}`,
          isReady: async () => true,
        } as unknown as BridgeDeps["manager"],
        tmux,
      });

      const callPromise = notifyAgent({ to: "recipient", summary: "done", agent: "claude" });
      // Let the tmux executor hit its process-level timeout instead of hanging to the client's ~300s ceiling.
      await vi.advanceTimersByTimeAsync(TMUX_CONTROL_TIMEOUT_MS);
      const result = await callPromise;

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/has-session timed out/);
      expect(kill).toHaveBeenCalledWith("SIGTERM");

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
        isReady: async () => true,
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

  it("notify_agent retry identity acknowledges the first durable append without ringing or delivering twice", async () => {
    const workspaceRoot = tmpRoot();
    const delivered: Array<{ to: string; line: string }> = [];
    const notifyAgent = wireNotifyAgent({
      workspaceRoot,
      manager: {
        kindOf: () => "agent",
        session: (name: string) => `session-${name}`,
        isReady: async () => true,
      } as unknown as BridgeDeps["manager"],
      tmux: { hasSession: async () => true } as unknown as BridgeDeps["tmux"],
      deliverNotice: async (to: string, line: string) => {
        delivered.push({ to, line });
        return { status: "queued" as const };
      },
    });

    const args = { to: "recipient", summary: "done", pointer: "t-3cccef", agent: "claude", deliveryId: "call-7" };
    const first = await notifyAgent(args);
    const retry = await notifyAgent(args);

    expect(first.isError).toBeFalsy();
    expect(retry.isError).toBeFalsy();
    expect(JSON.stringify(retry.content)).toContain("receipt: already-accepted");
    expect(delivered).toHaveLength(1);
    expect(readDoorbellEvents(workspaceRoot)).toEqual([
      expect.objectContaining({ from: "claude", to: "recipient", deliveryId: "call-7" }),
    ]);

    const conflictingRetry = await notifyAgent({ ...args, summary: "different effect" });
    expect(conflictingRetry.isError).toBe(true);
    expect(JSON.stringify(conflictingRetry.content)).toContain("already used for different");
    expect(delivered).toHaveLength(1);
    expect(readDoorbellEvents(workspaceRoot)).toHaveLength(1);
  });
});
