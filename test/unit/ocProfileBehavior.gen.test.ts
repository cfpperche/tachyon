import { describe, expect, it } from "vitest";
import { assertVerifiedTranscriptIsolation, isolationMechanismForCommand } from "../../src/runtime/runtimeProfile.js";

describe("container-generated delegation behavior", () => {
  it("opencode runtime profile permits gated delegation", () => {
    expect(isolationMechanismForCommand("opencode")).toMatchObject({
      mechanism: "project-scoped",
      source: "measured",
      verified: true,
    });
    expect(() => assertVerifiedTranscriptIsolation("opencode", { name: "helper" })).toThrow(/requires an isolated worktree for this spawn/);
    expect(() => assertVerifiedTranscriptIsolation("opencode", { name: "helper", isolatedWorktree: true })).not.toThrow();
  });
});
