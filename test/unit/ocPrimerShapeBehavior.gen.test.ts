import { describe, expect, it } from "vitest";
import { renderPrimer, type PrimerInput } from "../../src/bridge/primer.js";

const sample: PrimerInput = {
  agentName: "primerShape",
  delegator: "claude",
  gate: { behaviorTest: "primer teaches the classifier-approved commit command shape", owns: ["src/bridge/", "test/unit/"] },
  freshWorktree: true,
  verify: { full: "npm test", typecheck: "npm run typecheck" },
};

describe("container-generated delegation behavior", () => {
  it("primer teaches the classifier-approved commit command shape", () => {
    const { primer, beforeFinishing } = renderPrimer(sample);

    // The approved shape: ONE plain `git commit -m …` command per change.
    expect(primer).toMatch(/git commit -m/);
    expect(primer).toMatch(/ONE plain|one plain|one plain/i);

    // The rejected shape: a compound `cd <dir> && git commit …` (auto-mode classifiers block it).
    expect(primer).toMatch(/cd .*&&.*git commit/);
    expect(primer).toMatch(/never/i);
    expect(primer).toMatch(/cd-then-commit/);

    // The repo-discipline guidance still keeps add/commit as separate pathspec steps.
    expect(primer).toMatch(/BY PATHSPEC/);

    // The before-finishing block reinforces the same single-plain-command discipline.
    expect(beforeFinishing).toMatch(/single plain/);
    expect(beforeFinishing).toMatch(/cd .*&&.*git commit/);
    expect(beforeFinishing).toMatch(/never/);
  });
});