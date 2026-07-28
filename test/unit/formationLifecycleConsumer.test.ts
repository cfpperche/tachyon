/**
 * t-50bbd4 — the formation lanes finally have a consumer, and Soul reaches a canonical agent.
 *
 * The measured gap: SDD 427 shipped `src/agents/formation/` and SDD 429 shipped lifecycle/Studio, and
 * NOTHING in `src/` outside the formation directory imported it. So a canonical agent's Soul could be
 * authored, transacted and authority-checked, and still never reach a spawn, because
 * `resolveSoulForLifecycle` read `def.soul` and nothing else. Both umbrellas closed without writing
 * the caller. These tests pin the caller.
 *
 * The precedence and the refusal semantics get the most attention, because they are what a later
 * change is most likely to get subtly wrong:
 *  - a declared Soul must WIN, or a profile silently overrides the file the operator is reading;
 *  - a refusal must NOT read as absence, or an operator believes a profile is live when it is not.
 */
import { describe, it, expect } from "vitest";
import { chooseLifecycleSoul, type FormationSoulOutcome } from "../../src/agents/formation/lifecycleConsumer.js";
import type { ResolvedSoul } from "../../src/agents/soul.js";

const declaredSoul = { text: "declared soul", sha256: "d".repeat(64) } as unknown as ResolvedSoul;
const laneSoul = { text: "lane soul", sha256: "1".repeat(64) } as unknown as ResolvedSoul;

describe("t-50bbd4 — the lane fills the gap the declared path leaves", () => {
  it("uses the formation lane when nothing was declared — the case that was unreachable", () => {
    // Before this consumer existed, a canonical agent with a fully authorized Soul lane got
    // `undefined` here, and the identity never reached the spawn.
    const chosen = chooseLifecycleSoul({ declared: undefined, formation: { state: "resolved", soul: laneSoul } });
    expect(chosen.source).toBe("formation");
    expect(chosen.soul).toBe(laneSoul);
  });

  it("lets a DECLARED soul win over the lane", () => {
    // Not an accident of ordering: an inline soul is an explicit statement in the config the operator
    // is looking at, and a profile silently overriding the file in front of them is exactly the
    // confusion this area already suffers from.
    const chosen = chooseLifecycleSoul({ declared: declaredSoul, formation: { state: "resolved", soul: laneSoul } });
    expect(chosen.source).toBe("declared");
    expect(chosen.soul).toBe(declaredSoul);
  });

  it("returns nothing, without complaint, for an agent that simply has no formation authority", () => {
    // `absent` is not an error: most agents are not canonical profile agents, and treating that as a
    // failure would make the normal case noisy.
    const chosen = chooseLifecycleSoul({ declared: undefined, formation: { state: "absent" } });
    expect(chosen).toEqual({ soul: undefined, source: "none" });
  });

  it("respects an operator who turned the lane off", () => {
    const chosen = chooseLifecycleSoul({ declared: undefined, formation: { state: "lane-disabled" } });
    expect(chosen.soul).toBeUndefined();
    expect(chosen.refusal).toBeUndefined();
  });
});

describe("t-50bbd4 — a refusal is not an absence", () => {
  it("surfaces the reason instead of quietly yielding no soul", () => {
    // The distinction that matters operationally: "this agent has no Soul" and "the Soul lane refused"
    // look identical if the refusal is swallowed, and only one of them means the profile is not live.
    const refused: FormationSoulOutcome = { state: "refused", reason: "Soul reference does not match active lane authority" };
    const chosen = chooseLifecycleSoul({ declared: undefined, formation: refused });
    expect(chosen.soul).toBeUndefined();
    expect(chosen.refusal).toBe("Soul reference does not match active lane authority");
  });

  it("never falls back to another soul after a refusal", () => {
    // Identity is never guessed. A refusal must not become "use whatever else we can find".
    const chosen = chooseLifecycleSoul({ declared: undefined, formation: { state: "refused", reason: "retired authority" } });
    expect(chosen.source).toBe("none");
    expect(chosen.soul).toBeUndefined();
  });

  it("does not report a refusal when a declared soul satisfied the lifecycle", () => {
    // The lane is not consulted at all in that case, so there is nothing to report and reporting one
    // would be noise about a path that never ran.
    const chosen = chooseLifecycleSoul({ declared: declaredSoul, formation: { state: "refused", reason: "would not have been used" } });
    expect(chosen.source).toBe("declared");
    expect(chosen.refusal).toBeUndefined();
  });
});
