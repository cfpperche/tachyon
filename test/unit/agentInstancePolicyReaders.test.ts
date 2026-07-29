import { describe, expect, it } from "vitest";
import {
  isTemporaryInstance,
  legacyFallbackUsed,
  mayRestartInstance,
} from "../../src/agents/agentInstancePolicy.js";

/**
 * SDD 482 phase 3 (`t-5e1113`) — EQUIVALENCE PROOF for moving readers off `declared`.
 *
 * The rule the migration has to satisfy: for every row shape that exists today, the policy answer
 * must equal the `declared` answer — except where `declared` was WRONG, and there the difference has
 * to be deliberate and named. This enumerates the shapes rather than sampling them.
 */
const SAVED = { declared: true, instance: { identity: "saved", lifetime: "restartable" } } as const;
const TEMPORARY = { declared: false, instance: { identity: "temporary", lifetime: "collected" } } as const;
const FORK = { declared: false, instance: { identity: "temporary", lifetime: "restartable" } } as const;
const LEGACY_DECLARED = { declared: true } as const;
const LEGACY_ADHOC = { declared: false } as const;

describe("instance policy readers (SDD 482 phase 3)", () => {
  it("agrees with `declared` on every shape this build writes, for the identity question", () => {
    expect(isTemporaryInstance(SAVED)).toBe(!SAVED.declared);
    expect(isTemporaryInstance(TEMPORARY)).toBe(!TEMPORARY.declared);
    expect(isTemporaryInstance(FORK)).toBe(!FORK.declared);
  });

  /**
   * The ONE deliberate divergence, and the reason the split was worth doing. A fork is not
   * `declared`, so the old answer said it could not be started again — while it owns a resume block
   * and always could be. The policy says `restartable`, which is what it has always been.
   */
  it("diverges from `declared` exactly once, and in the direction that was wrong before", () => {
    expect(mayRestartInstance(SAVED)).toBe(SAVED.declared);
    expect(mayRestartInstance(TEMPORARY)).toBe(TEMPORARY.declared);

    expect(FORK.declared).toBe(false);          // the old answer: not restartable
    expect(mayRestartInstance(FORK)).toBe(true); // the true answer
  });

  it("answers a legacy row exactly as the reader did before — no invented policy", () => {
    expect(isTemporaryInstance(LEGACY_DECLARED)).toBe(false);
    expect(mayRestartInstance(LEGACY_DECLARED)).toBe(true);
    expect(isTemporaryInstance(LEGACY_ADHOC)).toBe(true);
    expect(mayRestartInstance(LEGACY_ADHOC)).toBe(false);
  });

  it("makes the legacy path observable, so its removal can be evidence-based", () => {
    expect(legacyFallbackUsed(LEGACY_DECLARED)).toBe(true);
    expect(legacyFallbackUsed(LEGACY_ADHOC)).toBe(true);
    expect(legacyFallbackUsed(SAVED)).toBe(false);
    expect(legacyFallbackUsed(FORK)).toBe(false);
  });

  it("declared alone never decides when a policy is present", () => {
    // A row whose storage fact and declared policy disagree must follow the POLICY. This shape is not
    // written today, and that is the point: the reader must not depend on them agreeing.
    const contradictory = { declared: true, instance: { identity: "temporary", lifetime: "collected" } } as const;
    expect(isTemporaryInstance(contradictory)).toBe(true);
    expect(mayRestartInstance(contradictory)).toBe(false);
  });
});
