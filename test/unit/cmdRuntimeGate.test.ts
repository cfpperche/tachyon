import { describe, expect, it } from "vitest";
import {
  cmdRuntimeChanged,
  cmdRuntimeIdentity,
  gateCmdRuntimeChange,
} from "@tachyon/engine/agents/cmdRuntimeGate.js";

describe("cmdRuntimeGate (t-6d09e6)", () => {
  it("identity uses runtime family when known", () => {
    expect(cmdRuntimeIdentity("claude --dangerously-skip-permissions")).toBe("claude");
    expect(cmdRuntimeIdentity("codex")).toBe("codex");
    expect(cmdRuntimeIdentity("grok -m x")).toBe("grok");
  });

  it("detects identity change across families", () => {
    expect(cmdRuntimeChanged("claude", "codex")).toBe(true);
    expect(cmdRuntimeChanged("claude -p", "claude --verbose")).toBe(false);
  });

  it("refuses change while running", () => {
    const g = gateCmdRuntimeChange({
      agent: "worker",
      prevCmd: "claude",
      nextCmd: "codex",
      running: true,
    });
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.code).toBe("agent_running");
    expect(g.message).toMatch(/Stop the agent first/i);
  });

  it("allows change when stopped and requests clearResume", () => {
    const g = gateCmdRuntimeChange({
      agent: "worker",
      prevCmd: "claude",
      nextCmd: "codex",
      running: false,
    });
    expect(g).toEqual({ ok: true, clearResume: true });
  });

  it("no-op when identity unchanged", () => {
    expect(
      gateCmdRuntimeChange({
        agent: "worker",
        prevCmd: "claude",
        nextCmd: "claude --foo",
        running: true,
      }),
    ).toEqual({ ok: true, clearResume: false });
  });
});
