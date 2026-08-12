import { describe, expect, it } from "vitest";
import { assertVerifiedTranscriptIsolation, isolationMechanismForCommand } from "../../src/runtime/runtimeProfile.js";

describe("container-generated delegation behavior", () => {
  it("opencode runtime profile permits ungated delegation (t-e2ebe3 private-home harness upgrade)", () => {
    expect(isolationMechanismForCommand("opencode")).toMatchObject({
      mechanism: "private-home",
      source: "measured",
      verified: true,
    });
    // The gated-only restriction is REMOVED: a parented opencode spawn delegates WITHOUT a separate worktree.
    expect(() => assertVerifiedTranscriptIsolation("opencode", { name: "helper" })).not.toThrow();
    expect(() => assertVerifiedTranscriptIsolation("opencode", { name: "helper", isolatedWorktree: true })).not.toThrow();
  });
});
