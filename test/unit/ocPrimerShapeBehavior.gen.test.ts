import { describe, expect, it } from "vitest";
import { renderPrimer, type PrimerInput } from "@tachyon/engine/agents/primer.js";

// t-8b8315 — the `gate` this sample carried was the retired gated-delegation shape; the assertion
// below never depended on it. The file's own provenance is now stale in a way this edit does not
// fix: it is a {agent}Behavior.gen.test.ts oracle from the retired behavior adapter, one of 64.
const sample: PrimerInput = {
  agentName: "primerShape",
  delegator: "claude",
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
