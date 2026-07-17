import { describe, it, expect } from "vitest";
import { applyCompletionHint, CompletionHintStore } from "../../src/attention/completionHint.js";
import type { AgentAttention } from "../../src/attention/AttentionMonitor.js";

const base = (state: AgentAttention["state"], extra: Partial<AgentAttention> = {}): AgentAttention => ({
  state,
  since: 1,
  contentSince: 1,
  outputStableSince: 1,
  episodeKey: "e",
  stalled: false,
  awaitingHuman: false,
  composerOccupied: false,
  stale: false,
  ...extra,
});

describe("completionHint (t-9552f3)", () => {
  it("applyCompletionHint remaps working→idle when hinted and composer empty", () => {
    const out = applyCompletionHint(base("working"), true);
    expect(out?.state).toBe("idle");
  });

  it("does not remap needs-input, throttled, or composerOccupied", () => {
    expect(applyCompletionHint(base("needs-input"), true)?.state).toBe("needs-input");
    expect(applyCompletionHint(base("throttled"), true)?.state).toBe("throttled");
    expect(applyCompletionHint(base("working", { composerOccupied: true }), true)?.state).toBe("working");
  });

  it("clearIfNewOutput only clears when contentSince is after mark", () => {
    const s = new CompletionHintStore();
    s.mark("a", 1000);
    s.clearIfNewOutput("a", 1000);
    expect(s.has("a")).toBe(true);
    s.clearIfNewOutput("a", 1001);
    expect(s.has("a")).toBe(false);
  });
});
