import { describe, expect, it } from "vitest";
import { BridgeSlowRequestToastPolicy, bridgeSlowRequestMessage } from "../../src/workspace/bridgeSlowRequestPolicy.js";

describe("BridgeSlowRequestToastPolicy", () => {
  it("keeps normal 10s slow completions metric-only", () => {
    const policy = new BridgeSlowRequestToastPolicy({ now: 1_000, extremeSlowMs: 60_000 });

    expect(policy.decide({ slow: true, durationMs: 10_500, requestKind: "mcp-tool", tool: "append_task_note", claimedIdentity: "codex" })).toBeUndefined();
  });

  it("does not toast known long-running tools", () => {
    const policy = new BridgeSlowRequestToastPolicy({ now: 1_000, extremeSlowMs: 60_000 });

    expect(policy.decide({ slow: true, durationMs: 974_000, requestKind: "mcp-tool", tool: "wait_for_agent", claimedIdentity: "grok" })).toBeUndefined();
  });

  it("includes tool and caller context for extreme slow requests", () => {
    const policy = new BridgeSlowRequestToastPolicy({ now: 1_000, extremeSlowMs: 60_000 });

    expect(policy.decide({ slow: true, durationMs: 120_000, requestKind: "mcp-tool", tool: "append_task_note", caller: { kind: "agent", name: "cxSlowBridge" } })?.message).toBe(
      "Bridge request completed very slowly (tool append_task_note, caller cxSlowBridge, 120000ms)",
    );
  });

  it("rate-limits identical extreme slow toasts", () => {
    const policy = new BridgeSlowRequestToastPolicy({ now: 1_000, extremeSlowMs: 60_000, dedupeMs: 10_000 });
    const info = { slow: true, durationMs: 120_000, requestKind: "mcp-tool" as const, tool: "append_task_note", caller: { kind: "agent" as const, name: "cxSlowBridge" } };

    expect(policy.decide(info)).toBeDefined();
    expect(policy.decide(info)).toBeUndefined();
  });

  it("falls back to claimed identity when the resolved caller is legacy", () => {
    expect(bridgeSlowRequestMessage({ slow: true, durationMs: 90_000, requestKind: "mcp-tool", tool: "notify_agent", claimedIdentity: "codex", caller: { kind: "legacy" } })).toBe(
      "Bridge request completed very slowly (tool notify_agent, claimed codex, 90000ms)",
    );
  });

  it("keeps idle streams, session operations and unknown traffic metric-only at any duration", () => {
    const policy = new BridgeSlowRequestToastPolicy({ now: 1_000, extremeSlowMs: 60_000 });
    for (const requestKind of ["mcp-stream", "mcp-session", "mcp-protocol", "other"] as const) {
      expect(policy.decide({
        slow: true,
        durationMs: 300_250,
        requestKind,
        caller: { kind: "agent", name: "claude" },
      })).toBeUndefined();
    }
  });
});
