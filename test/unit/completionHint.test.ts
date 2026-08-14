import { describe, it, expect } from "vitest";
import { applyCompletionHint, CompletionHintStore } from "@tachyon/engine/attention/completionHint.js";
import type { AgentAttention } from "@tachyon/shared/attention/AttentionMonitor.js";

const base = (state: AgentAttention["state"], extra: Partial<AgentAttention> = {}): AgentAttention => ({
  state,
  since: 1,
  contentSince: 1,
  outputStableSince: 1,
  episodeKey: "e",
  stalled: false,
  awaitingHuman: false,
  unseen: false,
  composerOccupied: false,
  stale: false,
  ...extra,
});

describe("completionHint (t-9552f3 / t-a39c7d)", () => {
  it("applyCompletionHint remaps working→idle+unseen when hinted and composer empty", () => {
    const out = applyCompletionHint(base("working"), true);
    expect(out?.state).toBe("idle");
    expect(out?.unseen).toBe(true);
  });

  it("does not remap needs-input, throttled, or composerOccupied", () => {
    expect(applyCompletionHint(base("needs-input"), true)?.state).toBe("needs-input");
    expect(applyCompletionHint(base("throttled"), true)?.state).toBe("throttled");
    expect(applyCompletionHint(base("working", { composerOccupied: true }), true)?.state).toBe("working");
  });

  it("seenAfterHint keeps idle without unseen (markSeen)", () => {
    const out = applyCompletionHint(base("working"), true, true);
    expect(out?.state).toBe("idle");
    expect(out?.unseen).toBe(false);
  });

  it("clearIfNewOutput only clears when contentSince is after mark", () => {
    const s = new CompletionHintStore();
    s.mark("a", 1000);
    s.clearIfNewOutput("a", 1000);
    expect(s.has("a")).toBe(true);
    s.clearIfNewOutput("a", 1001);
    expect(s.has("a")).toBe(false);
  });

  it("markSeen latches until next mark / clear", () => {
    const s = new CompletionHintStore();
    s.mark("a", 1000);
    s.markSeen("a");
    expect(s.isSeen("a")).toBe(true);
    s.mark("a", 2000);
    expect(s.isSeen("a")).toBe(false);
  });
});
