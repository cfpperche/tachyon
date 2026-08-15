import { describe, expect, it } from "vitest";
import { AttentionMonitor, type AttentionSettings } from "@tachyon/shared/attention/AttentionMonitor.js";
import { registerTools, type BridgeDeps } from "@tachyon/bridge/tools.js";

/**
 * t-35d95a — "request_human_attention": an AUTHORED (never derived) in-app human-attention signal for
 * the LIVE conversation, distinct from flag_for_human (t-1339a8, a Task-board flag). A coordinator that
 * ends a turn with a genuine prose question goes plain "idle" — indistinguishable from "done" — because
 * needs-input is PATTERN-driven (patterns.ts) and a prose question matches nothing. Covers:
 *   (1) BRIDGE TOOL — request_human_attention, agent-caller-gated (mirrors flag_for_human/
 *       request_human_approval): rejects a non-agent caller, and marks the CALLER's own agent.
 *   (2) LATCH — AttentionMonitor.flagAwaitingHuman: an independent boolean latch on AgentAttention
 *       (mirrors the `stalled` latch from t-47bfe8), NOT a new AttentionState.
 *   (3) CLEAR — same-turn pane output does NOT clear it; it clears only on the next idle -> working
 *       edge, the monitor boundary that represents the human having responded. Composer-only changes
 *       do NOT clear it.
 *   (4) NOTIFY — the toast/notify callback fires exactly once per awaiting-human episode (one-shot,
 *       like stallNotified), not on every subsequent flagAwaitingHuman call before it clears.
 */

/** A fake MCP server that just captures tool handlers (mirrors verifyTask.test.ts's FakeMcp). */
class FakeMcp {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>>();
  registerTool(name: string, _def: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>) {
    this.handlers.set(name, handler);
  }
}

function wireTools(deps: Partial<BridgeDeps>): FakeMcp {
  const mcp = new FakeMcp();
  registerTools(mcp as never, deps as unknown as BridgeDeps);
  return mcp;
}

async function callTool(mcp: FakeMcp, name: string, args: Record<string, unknown>) {
  const handler = mcp.handlers.get(name);
  if (!handler) throw new Error(`${name} not registered`);
  return handler(args);
}

describe("container-generated delegation behavior", () => {
  it("request_human_attention latches an awaiting-human signal that clears when the agent next produces output", async () => {
    let now = 1_000_000;
    const pane = { content: "done\n\n❯ ", cmd: "codex" };
    const events: Array<{ agent: string; notify: boolean; awaitingHuman: boolean }> = [];
    const settings: AttentionSettings = { enabled: true, silenceSec: 8, patterns: [] };

    const monitor = new AttentionMonitor(
      {
        runningAgents: async () => ["claude"],
        capturePane: async () => pane.content,
        cpuTicks: async () => null,
        settingsOf: () => settings,
        cmdOf: () => pane.cmd,
        now: () => now,
      },
      (agent, attention, notify) => events.push({ agent, notify, awaitingHuman: attention.awaitingHuman }),
    );
    const tick = async (ms: number) => {
      now += ms;
      await monitor.tick();
    };

    await tick(0); // baseline snapshot
    expect(monitor.stateOf("claude")?.state).toBe("working");

    // (1a) rejects a non-agent (legacy) caller — never latches, never mutates the monitor.
    const legacyMcp = wireTools({ caller: { kind: "legacy" }, flagAwaitingHuman: (a, r) => monitor.flagAwaitingHuman(a, r) });
    const rejected = await callTool(legacyMcp, "request_human_attention", { reason: "ou queres ajustar o design antes?" });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("agent-authenticated caller");
    expect(monitor.stateOf("claude")?.awaitingHuman).toBe(false);

    // (1b) an agent-authenticated caller latches ITSELF (no `agent` param — the caller IS the target).
    const agentMcp = wireTools({ caller: { kind: "agent", name: "claude" }, flagAwaitingHuman: (a, r) => monitor.flagAwaitingHuman(a, r) });
    const res = await callTool(agentMcp, "request_human_attention", { reason: "ou queres ajustar o design antes?" });
    expect(res.isError).toBeUndefined();

    // (2) the latch is set with the reason, alongside the untouched state machine (still "working").
    const latched = monitor.stateOf("claude");
    expect(latched?.awaitingHuman).toBe(true);
    expect(latched?.awaitingHumanReason).toBe("ou queres ajustar o design antes?");
    expect(latched?.state).toBe("working");

    // (4) fires exactly once — a second call before it clears does not re-notify.
    expect(events.filter((e) => e.notify && e.awaitingHuman)).toHaveLength(1);
    monitor.flagAwaitingHuman("claude", "ainda aguardando");
    expect(events.filter((e) => e.notify && e.awaitingHuman)).toHaveLength(1);
    expect(monitor.stateOf("claude")?.awaitingHumanReason).toBe("ainda aguardando");

    // (3a) adversarial: more pane output in the SAME turn after the tool call is still the agent
    // talking, not the human having responded. The awaiting-human latch must stay held.
    pane.content = "done\ntool result still rendering in the same turn\n\n❯ ";
    await tick(1000);
    expect(monitor.stateOf("claude")?.awaitingHuman).toBe(true);
    expect(monitor.stateOf("claude")?.state).toBe("working");

    await tick(9000); // stable past silenceSec, no cpu -> idle; the ask is still pending.
    expect(monitor.stateOf("claude")?.state).toBe("idle");
    expect(monitor.stateOf("claude")?.awaitingHuman).toBe(true);

    // (3b) a composer-only change (human typing, not an accepted turn yet) does NOT clear the latch.
    pane.content = "done\ntool result still rendering in the same turn\n\n❯ h";
    await tick(1000);
    expect(monitor.stateOf("claude")?.awaitingHuman).toBe(true);

    // (3c) the next idle -> working edge clears the latch: the human answered and the agent started
    // acting on that new turn.
    pane.content = "done\ntool result still rendering in the same turn\nnew agent output after the human answered\n\n❯ h";
    await tick(1000);
    expect(monitor.stateOf("claude")?.awaitingHuman).toBe(false);
    expect(monitor.stateOf("claude")?.awaitingHumanReason).toBeUndefined();
    expect(events.at(-1)).toEqual({ agent: "claude", notify: false, awaitingHuman: false });

    // the one-shot re-arms for a fresh episode after the clear.
    await tick(9000); // settle back to idle
    monitor.flagAwaitingHuman("claude", "again");
    expect(events.filter((e) => e.notify && e.awaitingHuman)).toHaveLength(2);
  });
});
