import { describe, expect, it } from "vitest";
import {
  hasLifecycleHooks,
  isTemporaryInstance,
  legacyFallbackUsed,
  mayRestartInstance,
} from "@tachyon/engine/agents/agentInstancePolicy.js";

/**
 * t-04052d — the reader contract AFTER `declared` is gone.
 *
 * This file used to be an EQUIVALENCE PROOF: for every row shape, the policy answer had to equal the
 * `declared` answer, except at the one deliberate divergence. That proof did its job — it is what made
 * removing the field defensible — and it cannot be restated now, because the thing it compared against
 * no longer exists. What replaces it is the property that has to hold from here on: the declared policy
 * is the ONLY source, and a row that declares nothing yields no capability rather than a guess.
 */
const SAVED = { instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: true } } as const;
const TEMPORARY = { instance: { lifetime: "temporary", resumePolicy: "collected", lifecycleHooks: false } } as const;
const FORK = { instance: { lifetime: "temporary", resumePolicy: "restartable", lifecycleHooks: false } } as const;
/** A row written before the cut. It declares no policy at all — the shape the activation gate refuses. */
const PRE_CUT = {} as const;

describe("instance policy readers (t-04052d)", () => {
  it("answers the identity question from the declared policy", () => {
    expect(isTemporaryInstance(SAVED)).toBe(false);
    expect(isTemporaryInstance(TEMPORARY)).toBe(true);
    expect(isTemporaryInstance(FORK)).toBe(true);
  });

  /**
   * THE TWO AXES DO NOT COLLAPSE, asserted rather than asserted-about. A fork is `temporary` — no
   * durable Profile — AND `restartable`, because it owns its own resume block. Any single saved/
   * temporary value would have to lie about one of them, and the one it would most likely lie about is
   * whether the fork survives a reload.
   */
  it("keeps lifetime and resume policy independent — the fork is the proof", () => {
    expect(isTemporaryInstance(FORK)).toBe(true);
    expect(mayRestartInstance(FORK)).toBe(true);

    expect(mayRestartInstance(SAVED)).toBe(true);
    expect(mayRestartInstance(TEMPORARY)).toBe(false);
  });

  /**
   * The removed fallback, pinned as a refusal. Every one of these used to have an answer sourced from
   * `declared`; with the field gone the honest answer is the one that withholds capability, so being
   * wrong costs a refusal an operator can see rather than a restart of something undescribable.
   */
  it("fails closed on a pre-cut row instead of inventing a policy", () => {
    expect(isTemporaryInstance(PRE_CUT)).toBe(true);
    expect(mayRestartInstance(PRE_CUT)).toBe(false);
    expect(hasLifecycleHooks(PRE_CUT)).toBe(false);
  });

  it("keeps the pre-cut row observable, which is what the activation gate refuses on", () => {
    expect(legacyFallbackUsed(PRE_CUT)).toBe(true);
    expect(legacyFallbackUsed(SAVED)).toBe(false);
    expect(legacyFallbackUsed(FORK)).toBe(false);
  });

  /**
   * Lifecycle hooks are a CAPABILITY, read rather than derived. The promoted agent is the case that
   * makes it matter: the human ruled that promotion does not mutate a live instance, so it holds a
   * Saved Profile while still running with the ownership-only hooks it launched with. Deriving from
   * lifetime would answer that case wrong the moment lifetime is allowed to change — which promotion
   * now does.
   */
  it("reads lifecycle hooks as a capability, not as a consequence of lifetime", () => {
    expect(hasLifecycleHooks(SAVED)).toBe(true);
    expect(hasLifecycleHooks(TEMPORARY)).toBe(false);
    // A fork is temporary AND explicitly ownership-only — commitFork says so; the row records it.
    expect(hasLifecycleHooks(FORK)).toBe(false);

    const promotedButRunning = {
      instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: false },
    } as const;
    expect(isTemporaryInstance(promotedButRunning)).toBe(false);
    expect(hasLifecycleHooks(promotedButRunning)).toBe(false); // derivation would have said true
  });

  it("does not invent a capability for a policy written before the field existed", () => {
    const prePolicy = { instance: { lifetime: "saved", resumePolicy: "restartable" } } as const;
    expect(isTemporaryInstance(prePolicy)).toBe(false);
    expect(mayRestartInstance(prePolicy)).toBe(true);
    expect(hasLifecycleHooks(prePolicy)).toBe(false); // unrecorded is not "yes"
  });
});
