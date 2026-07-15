import { describe, expect, it } from "vitest";
import { renderPrimer, type PrimerInput } from "../../src/bridge/primer.js";

const sample: PrimerInput = {
  agentName: "primerShape",
  delegator: "claude",
  gate: { behaviorTest: "primer keeps project Git workflow outside the global protocol", owns: ["src/bridge/", "test/unit/"] },
};

describe("container-generated delegation behavior", () => {
  it("primer keeps project Git workflow outside the global protocol", () => {
    const { primer, beforeFinishing } = renderPrimer(sample);
    const combined = `${primer}\n${beforeFinishing}`;

    expect(combined).not.toMatch(/git add|git commit|pathspec|cd-then-commit/i);
    expect(primer).toMatch(/Tachyon primer governs orchestration protocol/);
    expect(primer).toMatch(/project-owned guidance governs repository conventions/);
  });
});
