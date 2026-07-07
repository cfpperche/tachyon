import { describe, it, expect } from "vitest";
import {
  renderPrimer,
  wrapWithPrimer,
  PRIMER_OPEN,
  PRIMER_CLOSE,
  BEFORE_FINISHING_OPEN,
  BEFORE_FINISHING_CLOSE,
  PRIMER_LINE_BUDGET,
  BEFORE_FINISHING_LINE_BUDGET,
  type PrimerInput,
} from "../../src/bridge/primer.js";

const gatedAdhoc: PrimerInput = {
  agentName: "primerT3",
  delegator: "claude",
  gate: { behaviorTest: "renders the primer for a gated delegation", owns: ["src/bridge/primer.ts", "test/unit/primer.test.ts"], stubPath: "test/unit/primerT3Behavior.gen.test.ts" },
  freshWorktree: true,
  verify: { full: "npm test", typecheck: "tsc --noEmit" },
};

const plainAdhoc: PrimerInput = {
  agentName: "helper",
  parent: "claude",
};

const declared: PrimerInput = {
  agentName: "reviewer",
};

describe("renderPrimer (spec 363 T3)", () => {
  it("gated ad-hoc: identity, canonical stub + PROTOCOL IDENTIFIER warning, npm ci, doorbell target", () => {
    const { primer, beforeFinishing } = renderPrimer(gatedAdhoc);
    expect(primer.startsWith(PRIMER_OPEN)).toBe(true);
    expect(primer.endsWith(PRIMER_CLOSE)).toBe(true);
    expect(primer).toContain('spawned by "claude"');
    expect(primer).toContain('"renders the primer for a gated delegation"');
    expect(primer).toContain("test/unit/primerT3Behavior.gen.test.ts");
    expect(primer).toMatch(/PROTOCOL IDENTIFIER/);
    expect(primer).toContain("npm ci");
    expect(primer).toContain('notify_agent(to: "claude"');
    expect(primer).toContain("npm test");
    expect(primer).toContain("tsc --noEmit");

    expect(beforeFinishing.startsWith(BEFORE_FINISHING_OPEN)).toBe(true);
    expect(beforeFinishing.endsWith(BEFORE_FINISHING_CLOSE)).toBe(true);
    expect(beforeFinishing).toContain('Make "renders the primer for a gated delegation" pass WITHOUT renaming');
    expect(beforeFinishing).toContain('notify_agent(to: "claude"');
  });

  it("plain ad-hoc (no gate): still identifies the parent as the doorbell target, no gate/stub text", () => {
    const { primer, beforeFinishing } = renderPrimer(plainAdhoc);
    expect(primer).toContain('spawned by "claude"');
    expect(primer).not.toContain("PROTOCOL IDENTIFIER");
    expect(primer).not.toContain("npm ci");
    expect(beforeFinishing).not.toMatch(/Make ".*" pass WITHOUT renaming/);
    expect(beforeFinishing).toContain('notify_agent(to: "claude"');
  });

  it("declared / no lineage: falls back to a placeholder doorbell target, never crashes on missing spawner", () => {
    const { primer, beforeFinishing } = renderPrimer(declared);
    expect(primer).toContain("no delegator/parent on record");
    expect(primer).toContain("<your spawner>");
    expect(beforeFinishing).toContain("<your spawner>");
  });

  it("falls back to the default full-verify command when settings.verify is unconfigured", () => {
    const { primer, beforeFinishing } = renderPrimer({ agentName: "x" });
    expect(primer).toContain("npm test");
    expect(beforeFinishing).toContain("npm test");
  });

  it("spawn vs resume moments render byte-identical content for the same facts (spec.md: no delta dosing)", () => {
    const atSpawn = renderPrimer({ ...gatedAdhoc, freshWorktree: true });
    const atResume = renderPrimer({ ...gatedAdhoc, freshWorktree: false });
    // only the fresh-worktree bootstrap line differs; everything else — identity, protocol,
    // repo discipline, precedence, doorbell target — is the SAME full primer at every moment.
    expect(atSpawn.primer.replace(/\nFresh worktree:.*npm ci\` before anything else\.\n/, "\n")).toBe(atResume.primer);
    expect(atSpawn.beforeFinishing).toBe(atResume.beforeFinishing);
  });

  it("budget guard: the maximal-content primer stays within the hard line budgets", () => {
    const { primer, beforeFinishing } = renderPrimer(gatedAdhoc);
    expect(primer.split("\n").length).toBeLessThanOrEqual(PRIMER_LINE_BUDGET);
    expect(beforeFinishing.split("\n").length).toBeLessThanOrEqual(BEFORE_FINISHING_LINE_BUDGET);
  });

  it("single source: primer and before-finishing agree on the doorbell target and canonical test name from ONE render pass", () => {
    const rendered = renderPrimer(gatedAdhoc);
    const doorbellInPrimer = rendered.primer.match(/notify_agent\(to: "([^"]+)"/)?.[1];
    const doorbellInBeforeFinishing = rendered.beforeFinishing.match(/notify_agent\(to: "([^"]+)"/)?.[1];
    expect(doorbellInPrimer).toBe("claude");
    expect(doorbellInPrimer).toBe(doorbellInBeforeFinishing);

    const testInPrimer = rendered.primer.match(/canonical behavior test: "([^"]+)"/)?.[1];
    const testInBeforeFinishing = rendered.beforeFinishing.match(/Make "([^"]+)" pass/)?.[1];
    expect(testInPrimer).toBe(gatedAdhoc.gate!.behaviorTest);
    expect(testInPrimer).toBe(testInBeforeFinishing);
  });

  it("precedence note + orient pointer are always present (advisory pull, phase 2)", () => {
    const { primer } = renderPrimer(declared);
    expect(primer).toMatch(/task contract wins on task-specifics/);
    expect(primer).toMatch(/primer wins on global protocol/);
    expect(primer).toMatch(/call `orient`/);
  });
});

describe("wrapWithPrimer", () => {
  it("spawn brief carries the generated primer and before-finishing block", () => {
    const wrapped = wrapWithPrimer("TASK: do the thing", gatedAdhoc);
    const { primer, beforeFinishing } = renderPrimer(gatedAdhoc);
    expect(wrapped).toBe(`${primer}\n\nTASK: do the thing\n\n${beforeFinishing}`);
    expect(wrapped.indexOf(PRIMER_OPEN)).toBeLessThan(wrapped.indexOf("TASK: do the thing"));
    expect(wrapped.indexOf("TASK: do the thing")).toBeLessThan(wrapped.indexOf(BEFORE_FINISHING_OPEN));
  });

  it("degrades gracefully with empty instructions (declared agent with nothing configured)", () => {
    const wrapped = wrapWithPrimer("", declared);
    const { primer, beforeFinishing } = renderPrimer(declared);
    expect(wrapped).toBe(`${primer}\n\n${beforeFinishing}`);
  });
});
