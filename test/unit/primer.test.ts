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

const fullCheck = "./scripts/verify --scope='all modules'";
const typecheck = "./scripts/typecheck --no-emit";

const gatedAdhoc: PrimerInput = {
  agentName: "primerT3",
  delegator: "claude",
  gate: {
    behaviorTest: "renders the primer for a gated delegation",
    owns: ["src/bridge/primer.ts", "test/unit/primer.test.ts"],
    stubPath: "test/unit/primerT3Behavior.gen.test.ts",
  },
  verify: { full: fullCheck, typecheck },
};

const plainAdhoc: PrimerInput = {
  agentName: "helper",
  parent: "claude",
};

const declared: PrimerInput = {
  agentName: "reviewer",
};

const removedProjectPolicies = [
  "npm ci",
  "node_modules",
  "npm test",
  "Repo discipline",
  "git add",
  "git commit",
  "pathspec",
  "task id",
  "vscode.l10n",
  "`orient`",
];

describe("renderPrimer (spec 363 T3, ownership boundary from spec 383)", () => {
  it("gated ad-hoc preserves identity, gate facts, real-target doorbell and sourced configured checks", () => {
    const { primer, beforeFinishing } = renderPrimer(gatedAdhoc);
    expect(primer.startsWith(PRIMER_OPEN)).toBe(true);
    expect(primer.endsWith(PRIMER_CLOSE)).toBe(true);
    expect(primer).toContain('spawned by "claude"');
    expect(primer).toContain('"renders the primer for a gated delegation"');
    expect(primer).toContain("test/unit/primerT3Behavior.gen.test.ts");
    expect(primer).toMatch(/PROTOCOL IDENTIFIER/);
    expect(primer).toContain('notify_agent(to: "claude"');
    expect(primer).toContain("Configured verification (source: workspace config settings.verify):");
    expect(primer.split("\n")).toContain(`  - full: ${fullCheck}`);
    expect(primer.split("\n")).toContain(`  - typecheck: ${typecheck}`);

    expect(beforeFinishing.startsWith(BEFORE_FINISHING_OPEN)).toBe(true);
    expect(beforeFinishing.endsWith(BEFORE_FINISHING_CLOSE)).toBe(true);
    expect(beforeFinishing.split("\n")).toContain(
      `Run configured check (workspace config settings.verify.full): ${fullCheck}`,
    );
    expect(beforeFinishing.split("\n")).toContain(
      `Run configured check (workspace config settings.verify.typecheck): ${typecheck}`,
    );
    expect(beforeFinishing).toContain('Make "renders the primer for a gated delegation" pass WITHOUT renaming');
    expect(beforeFinishing).toContain('notify_agent(to: "claude"');
    expect(beforeFinishing).not.toMatch(/green|tree clean|full verify/i);
  });

  it("unconfigured onboarding contains protocol only and invents no project policy or verification", () => {
    const rendered = renderPrimer(declared);
    const combined = `${rendered.primer}\n${rendered.beforeFinishing}`;

    for (const policy of removedProjectPolicies) expect(combined).not.toContain(policy);
    expect(combined).not.toContain("workspace config settings.verify");
  });

  it("plain ad-hoc identifies its parent as the doorbell target without gate text", () => {
    const { primer, beforeFinishing } = renderPrimer(plainAdhoc);
    expect(primer).toContain('spawned by "claude"');
    expect(primer).not.toContain("PROTOCOL IDENTIFIER");
    expect(beforeFinishing).not.toMatch(/Make ".*" pass WITHOUT renaming/);
    expect(primer).toContain('notify_agent(to: "claude"');
    expect(beforeFinishing).toContain('notify_agent(to: "claude"');
  });

  it("does not invent a language-specific stub path when the gate did not provide one", () => {
    const { primer } = renderPrimer({
      agentName: "language-neutral",
      parent: "parent",
      gate: { behaviorTest: "preserves a configured invariant" },
    });
    expect(primer).toContain('canonical behavior test: "preserves a configured invariant".');
    expect(primer).not.toContain("test/unit/");
    expect(primer).not.toContain(".ts");
  });

  it("declared agent without lineage receives no placeholder or doorbell instruction", () => {
    const { primer, beforeFinishing } = renderPrimer(declared);
    expect(primer).toContain("no delegator/parent on record");
    expect(primer).not.toContain("<your spawner>");
    expect(beforeFinishing).not.toContain("<your spawner>");
    expect(primer).not.toContain("notify_agent");
    expect(beforeFinishing).not.toContain("notify_agent");
  });

  it("uses a non-empty parent when the delegator is not a real target", () => {
    const { primer, beforeFinishing } = renderPrimer({ agentName: "x", delegator: "   ", parent: "parent" });
    expect(primer).toContain('spawned by "parent"');
    expect(beforeFinishing).toContain('notify_agent(to: "parent"');
  });

  it("renders only explicitly configured verification keys without a fallback", () => {
    const fullOnly = renderPrimer({ agentName: "full", verify: { full: fullCheck } });
    expect(fullOnly.primer.split("\n")).toContain(`  - full: ${fullCheck}`);
    expect(fullOnly.primer).not.toContain("typecheck:");
    expect(fullOnly.beforeFinishing).toContain(`workspace config settings.verify.full): ${fullCheck}`);
    expect(fullOnly.beforeFinishing).not.toContain("settings.verify.typecheck");

    const typecheckOnly = renderPrimer({ agentName: "types", verify: { typecheck } });
    expect(typecheckOnly.primer.split("\n")).toContain(`  - typecheck: ${typecheck}`);
    expect(typecheckOnly.primer).not.toContain("  - full:");
    expect(typecheckOnly.beforeFinishing).toContain(`workspace config settings.verify.typecheck): ${typecheck}`);
    expect(typecheckOnly.beforeFinishing).not.toContain("settings.verify.full");
    expect(typecheckOnly.beforeFinishing).not.toContain("npm test");
  });

  it("renders byte-identical output for the same facts", () => {
    expect(renderPrimer({ ...gatedAdhoc })).toEqual(renderPrimer({ ...gatedAdhoc }));
  });

  it("budget guard: the maximal-content primer stays within the hard line budgets", () => {
    const { primer, beforeFinishing } = renderPrimer(gatedAdhoc);
    expect(primer.split("\n").length).toBeLessThanOrEqual(PRIMER_LINE_BUDGET);
    expect(beforeFinishing.split("\n").length).toBeLessThanOrEqual(BEFORE_FINISHING_LINE_BUDGET);
  });

  it("single source: both sections agree on the real doorbell target and canonical test name", () => {
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

  it("states separate precedence for task contract, Tachyon protocol and project-owned guidance", () => {
    const { primer } = renderPrimer(declared);
    expect(primer).toMatch(/active task contract governs task-specific work/);
    expect(primer).toMatch(/Tachyon primer governs orchestration protocol/);
    expect(primer).toMatch(/project-owned guidance governs repository conventions/);
    expect(primer).toMatch(/cannot override either contract or protocol/);
    expect(primer).not.toContain("orient");
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

  it("degrades gracefully with empty instructions", () => {
    const wrapped = wrapWithPrimer("", declared);
    const { primer, beforeFinishing } = renderPrimer(declared);
    expect(wrapped).toBe(`${primer}\n\n${beforeFinishing}`);
  });
});
