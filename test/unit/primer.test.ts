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
  "Product Invariant",
  "Affected Product Invariants",
  "PI-",
];

describe("renderPrimer (spec 363 T3, ownership boundary from spec 383)", () => {
  it("gated ad-hoc preserves identity, gate facts, real-target doorbell and sourced configured checks", () => {
    const { primer, beforeFinishing } = renderPrimer(gatedAdhoc);
    expect(primer.startsWith(PRIMER_OPEN)).toBe(true);
    expect(primer.endsWith(PRIMER_CLOSE)).toBe(true);
    expect(primer).toContain('spawned by "claude"');
    expect(primer).toContain('canonical behavior verifier: "renders the primer for a gated delegation"');
    expect(primer).toContain("test/unit/primerT3Behavior.gen.test.ts");
    expect(primer).toMatch(/FIXED PROJECT ORACLE/);
    expect(primer).not.toContain("notify_agent");
    expect(primer).toContain("Configured verification (source: workspace config settings.verify):");
    expect(primer.split("\n")).toContain(`  - full: ${fullCheck}`);
    expect(primer.split("\n")).toContain(`  - typecheck: ${typecheck}`);

    expect(beforeFinishing.startsWith(BEFORE_FINISHING_OPEN)).toBe(true);
    expect(beforeFinishing.endsWith(BEFORE_FINISHING_CLOSE)).toBe(true);
    expect(beforeFinishing).toContain(
      "Verification applies only when delivering repository changes; skip it for read-only investigation, reporting, and task authoring.",
    );
    expect(beforeFinishing.split("\n")).toContain(
      `Run configured check (workspace config settings.verify.full): ${fullCheck}`,
    );
    expect(beforeFinishing).not.toContain("workspace config settings.verify.typecheck");
    expect(beforeFinishing).toContain('Make "renders the primer for a gated delegation" pass by changing implementation; do NOT edit its fixed oracle.');
    expect(beforeFinishing).toContain('notify_agent(to: "claude"');
    expect(beforeFinishing).not.toMatch(/green|tree clean|full verify/i);
  });

  it("unconfigured onboarding contains protocol only and invents no project policy or verification", () => {
    const rendered = renderPrimer(declared);
    const combined = `${rendered.primer}\n${rendered.beforeFinishing}`;

    for (const policy of removedProjectPolicies) expect(combined).not.toContain(policy);
    expect(combined).not.toContain("workspace config settings.verify");
  });

  /**
   * `t-21bcb7` — the two lines that carry the lean-verification guidance into every brief.
   *
   * Both are cheap to delete and expensive to lose: without them an agent runs the full suite after
   * each step (the suite holds a machine-wide lock every other agent queues behind) and pastes long
   * findings into a notify (best-effort pane input, so the findings do not survive).
   *
   * The load-bearing half is the NEGATIVE one. Verification economy is Tachyon's policy about
   * Tachyon's suite; a consumer that configured no checks must not be told how often to run a suite
   * it never declared. That is the same ownership boundary the primer already keeps for the checks
   * themselves — so the advice has to be bound to the check, not merely near it.
   */
  const FOCUSED = "Use focused tests while implementing; run this on the tree you deliver.";

  it("prices verification per delivery, and only where a check was actually configured", () => {
    const configured = renderPrimer(gatedAdhoc).beforeFinishing.split("\n");
    expect(configured).toContain(FOCUSED);
    // Ordering is the meaning: the advice qualifies the check below it. Above the check it reads as
    // a rule about the whole section; below it, as an afterthought about something already run.
    expect(configured.indexOf(FOCUSED)).toBeLessThan(
      configured.indexOf(`Run configured check (workspace config settings.verify.full): ${fullCheck}`),
    );

    for (const input of [declared, plainAdhoc]) {
      const { primer, beforeFinishing } = renderPrimer(input);
      expect(`${primer}\n${beforeFinishing}`).not.toContain(FOCUSED);
    }
  });

  it("points the doorbell at durable detail instead of carrying it", () => {
    const line = renderPrimer(gatedAdhoc).beforeFinishing
      .split("\n")
      .find((candidate) => candidate.includes("notify_agent"));
    expect(line).toBeDefined();
    // A notify is not history. It says what happened, which tree it happened on, and where to read
    // the rest — naming the tree is what lets a reader check the claim against § Landing order.
    expect(line).toContain("commit/tree");
    expect(line).toMatch(/where the detail lives/);
    // Still one instruction on one line: the summary has a one-line cap, and advice that does not
    // fit the thing it describes teaches the agent to overflow it.
    expect(renderPrimer(gatedAdhoc).beforeFinishing.split("\n").filter((l) => l.includes("notify_agent"))).toHaveLength(1);
  });

  it("plain ad-hoc identifies its parent as the doorbell target without gate text", () => {
    const { primer, beforeFinishing } = renderPrimer(plainAdhoc);
    expect(primer).toContain('spawned by "claude"');
    expect(primer).not.toContain("PROTOCOL IDENTIFIER");
    expect(beforeFinishing).not.toMatch(/Make ".*" pass WITHOUT renaming/);
    expect(primer).not.toContain("notify_agent");
    expect(beforeFinishing).toContain('notify_agent(to: "claude"');
  });

  it("keeps a runner-neutral verifier free of stub and rename instructions", () => {
    const { primer, beforeFinishing } = renderPrimer({
      agentName: "language-neutral",
      parent: "parent",
      gate: { behaviorTest: "cmd:node scripts/check-behavior.mjs" },
    });
    const combined = `${primer}\n${beforeFinishing}`;
    expect(primer).toContain('canonical behavior verifier: "cmd:node scripts/check-behavior.mjs".');
    expect(combined).not.toContain("test/unit/");
    expect(combined).not.toContain(".ts");
    expect(combined).not.toMatch(/renam/i);
    expect(beforeFinishing).toContain(
      'Make canonical verifier "cmd:node scripts/check-behavior.mjs" fail at BASE_SHA and pass at delivered HEAD.',
    );
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
    expect(fullOnly.beforeFinishing).toContain("skip it for read-only investigation, reporting, and task authoring");
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

  it.each([
    { label: "agent name", input: { agentName: "worker\u001b[2J" } },
    { label: "behavior identifier", input: { agentName: "worker", gate: { behaviorTest: "promise\u001b]8;;https://example.test\u0007" } } },
    { label: "owned path", input: { agentName: "worker", gate: { behaviorTest: "promise", owns: ["src\u001b[2J"] } } },
    { label: "configured check", input: { agentName: "worker", verify: { full: "npm test\u007f" } } },
    { label: "C1 behavior identifier", input: { agentName: "worker", gate: { behaviorTest: "promise\u009b2J" } } },
    { label: "Unicode line separator", input: { agentName: "worker", verify: { full: "npm test\u2028spoof" } } },
    { label: "bidi isolate", input: { agentName: "worker", gate: { behaviorTest: "promise", owns: ["src\u2066spoof"] } } },
  ])("rejects control characters in interpolated $label facts", ({ input }) => {
    expect(() => renderPrimer(input)).toThrow(/control characters/);
  });

  it("budget guard: the maximal-content primer stays within the hard line budgets", () => {
    const { primer, beforeFinishing } = renderPrimer(gatedAdhoc);
    expect(primer.split("\n").length).toBeLessThanOrEqual(PRIMER_LINE_BUDGET);
    expect(beforeFinishing.split("\n").length).toBeLessThanOrEqual(BEFORE_FINISHING_LINE_BUDGET);
  });

  it("single source: both sections agree on the real doorbell target and canonical verifier name", () => {
    const rendered = renderPrimer(gatedAdhoc);
    const doorbellInBeforeFinishing = rendered.beforeFinishing.match(/notify_agent\(to: "([^"]+)"/)?.[1];
    expect(rendered.primer).not.toContain("notify_agent");
    expect(doorbellInBeforeFinishing).toBe("claude");

    const testInPrimer = rendered.primer.match(/canonical behavior verifier: "([^"]+)"/)?.[1];
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
