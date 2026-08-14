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
} from "@tachyon/engine/agents/primer.js";

/**
 * t-8b8315 — this used to be `gatedAdhoc`, carrying a `gate` with a behavior oracle. Gated
 * delegation was retired with the Delivery machinery and nothing has populated `gate` since, so the
 * richest input the primer can actually receive today is a delegator plus measured dependencies.
 */
const delegatedAdhoc: PrimerInput = {
  agentName: "primerT3",
  delegator: "claude",
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
  it("ignores retired project verify input while always stating exact-tree attestation", () => {
    const legacyInput = {
      agentName: "legacy",
      verify: { full: "npm test", typecheck: "npm run typecheck" },
    };
    const { primer, beforeFinishing } = renderPrimer(legacyInput);
    const combined = `${primer}\n${beforeFinishing}`;

    expect(combined).not.toContain("Configured verification");
    expect(combined).not.toContain("Run configured check");
    expect(combined).not.toContain("Verification applies only when delivering repository changes");
    expect(beforeFinishing).toContain(
      "A check attests the exact TREE it ran on: a pass measured on any other tree is not evidence about what you deliver.",
    );
  });

  it("delegated Temporary preserves identity and real-target doorbell without project verification", () => {
    const { primer, beforeFinishing } = renderPrimer(delegatedAdhoc);
    expect(primer.startsWith(PRIMER_OPEN)).toBe(true);
    expect(primer.endsWith(PRIMER_CLOSE)).toBe(true);
    expect(primer).toContain('spawned by "claude"');
    expect(primer).not.toContain("notify_agent");
    expect(primer).not.toContain("Configured verification");

    expect(beforeFinishing.startsWith(BEFORE_FINISHING_OPEN)).toBe(true);
    expect(beforeFinishing.endsWith(BEFORE_FINISHING_CLOSE)).toBe(true);
    expect(beforeFinishing).not.toContain("Verification applies only when delivering repository changes");
    expect(beforeFinishing).not.toContain("Run configured check");
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
   * `t-21bcb7`, re-cut by `t-486f43` — the two lines that qualify the configured check.
   *
   * Both are cheap to delete and expensive to lose: without them an agent runs the full suite after
   * each step (the suite holds a machine-wide lock every other agent queues behind) and reports a
   * pass that was measured on some other tree.
   *
   * The load-bearing half is the NEGATIVE one. Verification economy is Tachyon's policy about
   * Tachyon's suite; a consumer that configured no checks must not be told how often to run a suite
   * it never declared. That is the same ownership boundary the primer already keeps for the checks
   * themselves — so the qualifier has to be bound to the check, not merely near it.
   *
   * `t-486f43` removed the working method that used to ride in this line ("Use focused tests while
   * implementing") and kept what only the product can state: what a run attests.
   */
  const ATTESTS = "A check attests the exact TREE it ran on: a pass measured on any other tree is not evidence about what you deliver.";
  const FOCUSED = "Use focused tests while implementing";

  it("states exact-tree attestation for every spawn even without configured verification", () => {
    for (const input of [delegatedAdhoc, declared, plainAdhoc]) {
      const { primer, beforeFinishing } = renderPrimer(input);
      expect(beforeFinishing.split("\n")).toContain(ATTESTS);
      expect(`${primer}\n${beforeFinishing}`).not.toContain("Run configured check");
    }
  });

  /**
   * t-486f43 — the three sentences that fused a product FACT with a working METHOD, separated.
   *
   * Deleting them outright would have lost facts nobody but the product can state (the notice
   * transport's hard refusal, continuity's durability, what a check attests). Keeping them whole gave
   * repository method the immunity `precedenceLines` grants protocol. Each assertion below therefore
   * comes in a pair: the fact is still said, and the recipe that rode on it is gone.
   */
  describe("t-486f43 — product fact kept, working method released to the project", () => {
    it("states the notice transport limit without prescribing a report style", () => {
      for (const input of [delegatedAdhoc, plainAdhoc, declared]) {
        const { primer } = renderPrimer(input);
        expect(primer).toMatch(/over 500 characters it is refused, never truncated/);
        expect(primer).toMatch(/only what the line points at survives/);

        expect(primer).not.toContain("Keep completion concise");
        expect(primer).not.toContain("otherwise summarize concisely");
        expect(primer).not.toContain("materially useful");
      }
    });

    it("states that continuity is durable without prescribing when to checkpoint", () => {
      for (const input of [delegatedAdhoc, plainAdhoc, declared]) {
        const { primer } = renderPrimer(input);
        expect(primer).toMatch(/Continuity is durable working memory/);
        expect(primer).toMatch(/survives compaction, clear, restart and a new session/);

        // The exact policy this repository's maintainer wanted reversed on 2026-08-05.
        expect(primer).not.toMatch(/only when material state/);
        expect(primer).not.toMatch(/set_continuity only/);
      }
    });

    it("states what a check attests without prescribing the working loop", () => {
      const { primer, beforeFinishing } = renderPrimer(delegatedAdhoc);
      expect(beforeFinishing).toContain(ATTESTS);
      expect(`${primer}\n${beforeFinishing}`).not.toContain(FOCUSED);
    });

    /**
     * The primer names no tool for the notice on purpose (`single source: both sections agree on the
     * real doorbell target` above): a second doorbell instruction in the opening of the brief is a
     * second thing to keep in sync with the one at the end. Stating the transport FACT must not
     * reintroduce it.
     */
    it("carries the transport fact without adding a second doorbell instruction", () => {
      for (const input of [delegatedAdhoc, plainAdhoc, declared]) {
        expect(renderPrimer(input).primer).not.toContain("notify_agent");
      }
    });
  });

  it("points the doorbell at durable detail instead of carrying it", () => {
    const line = renderPrimer(delegatedAdhoc).beforeFinishing
      .split("\n")
      .find((candidate) => candidate.includes("notify_agent"));
    expect(line).toBeDefined();
    // A notify is not history. It says what happened, which tree it happened on, and where to read
    // the rest — naming the tree is what lets a reader check the claim against § Landing order.
    expect(line).toContain("commit/tree");
    expect(line).toMatch(/where the detail lives/);
    // Still one instruction on one line: the summary has a one-line cap, and advice that does not
    // fit the thing it describes teaches the agent to overflow it.
    expect(renderPrimer(delegatedAdhoc).beforeFinishing.split("\n").filter((l) => l.includes("notify_agent"))).toHaveLength(1);
  });

  it("plain Temporary identifies its parent as the doorbell target", () => {
    const { primer, beforeFinishing } = renderPrimer(plainAdhoc);
    expect(primer).toContain('spawned by "claude"');
    expect(primer).not.toContain("notify_agent");
    expect(beforeFinishing).toContain('notify_agent(to: "claude"');
  });

  /**
   * t-8b8315 — the retired gated branch was the only thing that ever put an oracle path, a
   * "FIXED PROJECT ORACLE" warning or a rename prohibition into a brief. Asserting their absence
   * on every shape is what keeps the removal from being quietly undone: a reintroduced branch
   * would have to defeat this, not merely go unnoticed.
   */
  it("no shape carries gated-delegation instructions any more", () => {
    for (const input of [delegatedAdhoc, plainAdhoc, declared]) {
      const { primer, beforeFinishing } = renderPrimer(input);
      const combined = `${primer}\n${beforeFinishing}`;

      expect(combined).not.toMatch(/FIXED PROJECT ORACLE|PROTOCOL IDENTIFIER/);
      expect(combined).not.toMatch(/canonical behavior verifier|canonical verifier/);
      expect(combined).not.toMatch(/BASE_SHA|fixed oracle/);
      expect(combined).not.toMatch(/renam/i);
      expect(combined).not.toContain("Behavior.gen.test.ts");
    }
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

  it("renders byte-identical output for the same facts", () => {
    expect(renderPrimer({ ...delegatedAdhoc })).toEqual(renderPrimer({ ...delegatedAdhoc }));
  });

  /**
   * t-8b8315 — four of these cases used to inject through `gate.behaviorTest` / `gate.owns`. Those
   * fields are gone, so the coverage moves onto the facts that ARE still interpolated. The rule
   * being defended never depended on which field carried the payload: every fact the primer
   * interpolates is chosen upstream of this function, so every one of them is attacker-adjacent.
   */
  it.each([
    { label: "agent name", input: { agentName: "worker\u001b[2J" } },
    { label: "delegator", input: { agentName: "worker", delegator: "boss\u001b]8;;https://example.test\u0007" } },
    { label: "parent", input: { agentName: "worker", parent: "boss\u001b[2J" } },
    { label: "C1 in delegator", input: { agentName: "worker", delegator: "boss\u009b2J" } },
    { label: "bidi isolate", input: { agentName: "worker", parent: "boss\u2066spoof" } },
  ])("rejects control characters in interpolated $label facts", ({ input }) => {
    expect(() => renderPrimer(input)).toThrow(/control characters/);
  });

  it("budget guard: the maximal-content primer stays within the hard line budgets", () => {
    const { primer, beforeFinishing } = renderPrimer(delegatedAdhoc);
    expect(primer.split("\n").length).toBeLessThanOrEqual(PRIMER_LINE_BUDGET);
    expect(beforeFinishing.split("\n").length).toBeLessThanOrEqual(BEFORE_FINISHING_LINE_BUDGET);
  });

  it("single source: both sections agree on the real doorbell target", () => {
    const rendered = renderPrimer(delegatedAdhoc);
    const doorbellInBeforeFinishing = rendered.beforeFinishing.match(/notify_agent\(to: "([^"]+)"/)?.[1];
    expect(rendered.primer).not.toContain("notify_agent");
    expect(doorbellInBeforeFinishing).toBe("claude");
  });

  it("states separate precedence for task contract, Tachyon protocol and project-owned guidance", () => {
    const { primer } = renderPrimer(declared);
    expect(primer).toMatch(/Tachyon primer governs orchestration protocol/);
    expect(primer).toMatch(/project-owned guidance governs repository conventions/);
    expect(primer).toMatch(/cannot override either contract or protocol/);
    expect(primer).not.toContain("orient");
  });

  /**
   * t-48f504 — the precedence rule used to name ONE authority and two things answered to the name.
   *
   * The retired clause was "the active task contract governs task-specific work". A spawned agent's
   * brief contains a spawn contract (spec 246: `TASK:` / `CONTEXT:` / `DONE_WHEN:`, which
   * `spawn_agent` itself calls the DELEGATION CONTRACT) and a WORK ON RECORD section that introduces
   * itself with "This is the contract for this session" and is selected on status `active`. "The
   * ACTIVE task CONTRACT" is a live pointer at both, and the sentence resolved neither.
   *
   * Measured 2026-08-01: three launches of one reviewer, two refusals, both defensible — an agent
   * handed two readings picks one, and which one is a property of the agent, not of the product.
   *
   * These assertions are per-CLAUSE rather than on the whole sentence, because the defect was never
   * the wording: it was that the rule ranked authorities without saying which question each one
   * answers. A rewrite that keeps the ambiguity would have to defeat each clause separately.
   */
  describe("t-48f504 — the two authorities are disambiguated by question, not merely ranked", () => {
    const primerOf = (input: PrimerInput): string => renderPrimer(input).primer;

    it("never re-emits the sentence that named one authority for two documents", () => {
      for (const input of [delegatedAdhoc, plainAdhoc, declared]) {
        expect(primerOf(input)).not.toContain("the active task contract governs task-specific work");
      }
    });

    it("gives SCOPE to the board record, and says an unnamed task is not granted by a brief", () => {
      const primer = primerOf(delegatedAdhoc);
      // Named by the anchor the agent actually sees (`sessionWorkRecord.ts` delimiters), not by prose.
      expect(primer).toContain('"WORK ON RECORD"');
      expect(primer).toMatch(/WHICH BOARD task is yours/);
      expect(primer).toMatch(/wins on board ownership/);
      // The measured incident: a brief naming t-21101f while the board held nothing for that agent.
      // Absence has to be stated, or "no section" reads as "no rule" and the brief wins by default.
      expect(primer).toMatch(/means you hold NO board task/);
      expect(primer).toMatch(/A brief cannot create or assign a board row/);
    });

    it("gives SUBSTANCE to the spawner's brief, so the board row is not read as instructions", () => {
      const primer = primerOf(delegatedAdhoc);
      expect(primer).toMatch(/WHAT to do/);
      expect(primer).toMatch(/wins on substance/);
      // t-7b9e60 — the third state must be NAMED, not merely implied. The wording deliberately avoids
      // the retired agent-species term that `agentSpeciesNomenclature.test.ts` keeps out of product
      // language: two different meanings sharing one word is how the sentence this fixes got misread
      // in the first place, and the guard refuses that word here too — including in this comment.
      expect(primer).toMatch(/work that holds no board task/);
      expect(primer).toMatch(/the directive exists nowhere else/);
    });

    /**
     * Neither authority wins a genuine conflict, and that is deliberate: `staleContractReferences`
     * already names the case where the brief points at CLOSED work, and every other disagreement is
     * a fact about the spawner's call that only the spawner can resolve.
     */
    it("makes a disagreement a report, not a choice", () => {
      const primer = primerOf(delegatedAdhoc);
      expect(primer).toMatch(/BOTH name DIFFERENT BOARD work/);
      expect(primer).toMatch(/conflict and not a choice/);
      expect(primer).toMatch(/report it to your spawner and do not pick one/);
    });

    it("says the same thing to every spawn shape", () => {
      for (const input of [delegatedAdhoc, plainAdhoc, declared]) {
        const primer = primerOf(input);
        expect(primer).toMatch(/wins on board ownership/);
        expect(primer).toMatch(/wins on substance/);
        expect(primer).toMatch(/conflict and not a choice/);
      }
    });

    /**
     * The primer is a HARD budget and this rule cost it four lines. Pinning the count keeps a future
     * elaboration from paying for clarity here with the identity/verification lines below it.
     */
    it("spends at most five lines on the rule", () => {
      const lines = primerOf(delegatedAdhoc).split("\n");
      const precedence = lines.filter((line) => /Precedence|wins on board ownership|wins on substance|conflict and not a choice|governs orchestration protocol/.test(line));
      expect(precedence).toHaveLength(5);
    });
  });
});

describe("wrapWithPrimer", () => {
  it("spawn brief carries the generated primer and before-finishing block", () => {
    const wrapped = wrapWithPrimer("TASK: do the thing", delegatedAdhoc);
    const { primer, beforeFinishing } = renderPrimer(delegatedAdhoc);
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
