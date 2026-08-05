import { describe, expect, it } from "vitest";
import { applyNativeLaneSuppressionCommand } from "../../src/agents/AgentManager.js";

describe("t-e3d14c — measured native-lane launch controls", () => {
  it("applies Claude's measured project-instruction suppression", () => {
    expect(applyNativeLaneSuppressionCommand("claude")).toEqual({
      cmd: "claude --setting-sources user",
      applied: true,
    });
  });

  it("applies both measured Codex controls", () => {
    const result = applyNativeLaneSuppressionCommand("codex");
    expect(result.applied).toBe(true);
    expect(result.cmd).toContain("project_doc_max_bytes=0");
    expect(result.cmd).toContain("--disable memories");
  });

  it("does not claim suppression for Grok", () => {
    expect(applyNativeLaneSuppressionCommand("grok")).toEqual({ cmd: "grok", applied: false });
  });
});
