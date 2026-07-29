import { describe, expect, it } from "vitest";
import {
  hasLifecycleHooks,
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
const SAVED = { declared: true, instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: true } } as const;
const TEMPORARY = { declared: false, instance: { lifetime: "temporary", resumePolicy: "collected", lifecycleHooks: false } } as const;
const FORK = { declared: false, instance: { lifetime: "temporary", resumePolicy: "restartable", lifecycleHooks: false } } as const;
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
    const contradictory = { declared: true, instance: { lifetime: "temporary", resumePolicy: "collected" } } as const;
    expect(isTemporaryInstance(contradictory)).toBe(true);
    expect(mayRestartInstance(contradictory)).toBe(false);
  });

  /**
   * Lifecycle hooks are a CAPABILITY, read rather than derived. The promoted agent is the case that
   * makes it matter: the human ruled that promotion does not mutate a live instance, so it holds a
   * Saved Profile while still running with the ownership-only hooks it launched with. Deriving from
   * identity would answer that case wrong the moment identity is allowed to change.
   */
  it("reads lifecycle hooks as a capability, not as a consequence of identity", () => {
    expect(hasLifecycleHooks(SAVED)).toBe(true);
    expect(hasLifecycleHooks(TEMPORARY)).toBe(false);
    // A fork is temporary AND explicitly ownership-only — commitFork says so; the row records it.
    expect(hasLifecycleHooks(FORK)).toBe(false);

    // The separable case: identity says saved, the instance still launched without the hooks.
    const promotedButRunning = {
      declared: true,
      instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: false },
    } as const;
    expect(isTemporaryInstance(promotedButRunning)).toBe(false);
    expect(hasLifecycleHooks(promotedButRunning)).toBe(false); // derivation would have said true
  });

  it("falls back to declared when the capability was never recorded", () => {
    expect(hasLifecycleHooks(LEGACY_DECLARED)).toBe(true);
    expect(hasLifecycleHooks(LEGACY_ADHOC)).toBe(false);
    // A policy written before the capability existed also has no answer, and does not invent one.
    const prePolicy = { declared: true, instance: { lifetime: "saved", resumePolicy: "restartable" } } as const;
    expect(hasLifecycleHooks(prePolicy)).toBe(true); // from `declared`, exactly as the reader did before
  });
});
