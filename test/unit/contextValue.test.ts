import { describe, it, expect } from "vitest";
import { agentContextValue, isTemporaryItem, type AgentContextParts, type AgentItemStateName } from "../../src/presentation/contextValue.js";

/** Every combination the builder can emit (3 states × 2^6 boolean segments = 192). */
function allParts(): AgentContextParts[] {
  const states: AgentItemStateName[] = ["running", "stopped", "crashed"];
  const out: AgentContextParts[] = [];
  for (const state of states)
    for (const ai of [false, true])
      for (const temporary of [false, true])
        for (const worktree of [false, true])
          for (const verifiable of [false, true])
            for (const forkable of [false, true])
              for (const harness of [false, true]) out.push({ state, ai, temporary, worktree, verifiable, forkable, harness });
  return out;
}

describe("agentContextValue / isTemporaryItem", () => {
  it("isTemporaryItem round-trips the builder for EVERY combination (no segment-position drift)", () => {
    for (const p of allParts()) {
      const cv = agentContextValue(p);
      expect(isTemporaryItem(cv)).toBe(p.temporary); // the exact bug: -temporary mid-string (e.g. with -worktree) still detected
    }
  });

  it("emits the expected segments in a fixed order", () => {
    expect(agentContextValue({ state: "stopped", ai: true, temporary: true, worktree: true, verifiable: false, forkable: false, harness: false })).toBe("agent-stopped-ai-temporary-worktree");
    expect(agentContextValue({ state: "running", ai: true, temporary: false, worktree: false, verifiable: false, forkable: true, harness: false })).toBe("agent-running-ai-forkable");
    expect(agentContextValue({ state: "running", ai: true, temporary: false, worktree: false, verifiable: false, forkable: true, harness: true })).toBe("agent-running-ai-forkable-harness");
    expect(agentContextValue({ state: "crashed", ai: false, temporary: false, worktree: false, verifiable: false, forkable: false, harness: false })).toBe("agent-crashed");
  });

  it("does NOT match a declared agent (no -temporary segment)", () => {
    expect(isTemporaryItem("agent-stopped-ai")).toBe(false);
    expect(isTemporaryItem("agent-running-ai-worktree-forkable")).toBe(false);
    expect(isTemporaryItem(undefined)).toBe(false);
    expect(isTemporaryItem("")).toBe(false);
  });
});
