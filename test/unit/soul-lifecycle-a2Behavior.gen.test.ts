import { describe, expect, it } from "vitest";

describe("agent soul lifecycle composition closure", () => {
  it("agent soul lifecycle composition closure", async () => {
    const layers = await import("../../src/agents/promptLayers.js");
    const rendered = layers.renderPromptLayers({
      soul: "Steady identity.",
      role: "Reusable role.",
      instructions: "Persistent specialization.",
      bridgeGuidance: "Bridge guidance.",
      taskBrief: "Current execution task.",
    });

    expect(rendered).toBe([
      "Steady identity.",
      "Reusable role.",
      "Persistent specialization.",
      "Bridge guidance.",
      "Current execution task.",
    ].join("\n\n"));
  });
});
