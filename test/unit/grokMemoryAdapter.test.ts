import { describe, expect, it } from "vitest";
import {
  GROK_CANONICAL_MEMORY_POLICY,
  GROK_MEMORY_DISABLED_VALUE,
  GROK_MEMORY_DOCUMENTED_PRECEDENCE,
  GROK_MEMORY_ENV_VAR,
  GROK_MEMORY_MEASURED_VERSION,
  GROK_MEMORY_PRECEDENCE,
  GROK_NO_MEMORY_FLAG,
  grokMemoryArgs,
  grokMemoryCapability,
  grokMemoryEnv,
  grokMemoryVerificationPlan,
} from "@tachyon/engine/runtime/adapters/grokMemory.js";
import { nativeMemoryCapability, resolveMemoryPolicy } from "@tachyon/engine/runtime/nativeMemory.js";

/**
 * t-0e88f3 — the task that withdrew t-c46c35's guarantee.
 *
 * t-c46c35 pinned `--no-memory` and asserted immunity to a hostile environment, on the strength of the
 * shipped guide's precedence table. Measurement on 2026-07-28 (approval a-b4b050, Grok 0.2.112,
 * effective model grok-4.5-build) contradicted the table: with `--no-memory` AND `GROK_MEMORY=1`,
 * memory initialized, injected a planted marker into the first turn, and wrote to the store. A default
 * arm on a clean environment showed none of it, which is what separates "the flag is inert" from "the
 * env var outranks it".
 *
 * These tests pin the CORRECTION, so the false claim cannot quietly return.
 */

describe("the precedence, as measured rather than as documented", () => {
  it("leads with the mode dependence, because that is the finding", () => {
    // Neither ordering is THE ordering: headless ranks the env var first, the TUI ranks the flag
    // first. A reader who takes away only the first line must still take away the right thing.
    expect(GROK_MEMORY_PRECEDENCE[0]).toContain("MODE DECIDES");
    expect(GROK_MEMORY_PRECEDENCE[0]).toContain("headless");
    expect(GROK_MEMORY_PRECEDENCE[0]).toContain("TUI");
  });

  it("records both directions of the inversion, not just the convenient one", () => {
    const envRule = GROK_MEMORY_PRECEDENCE.find((rule) => rule.startsWith("GROK_MEMORY"))!;
    const flagRule = GROK_MEMORY_PRECEDENCE.find((rule) => rule.startsWith("--no-memory"))!;
    expect(envRule).toContain("HEADLESS");
    // The flag rule has to carry the fact that it HOLDS somewhere, or the record over-corrects into
    // "the flag is inert" — which the TUI arms disproved.
    expect(flagRule).toContain("hold in the TUI");
    expect(flagRule).toContain("outranked by GROK_MEMORY=1 headless");
    expect(flagRule, "an 'always' claim dies to one counterexample").toContain("'always' is false");
  });

  it("marks each rule as MEASURED or merely documented, so the two never blur again", () => {
    const measured = GROK_MEMORY_PRECEDENCE.filter((rule) => rule.includes("MEASURED"));
    // Everything except the config.toml section was observed in at least one mode.
    expect(measured).toHaveLength(5);
    expect(GROK_MEMORY_PRECEDENCE.find((rule) => rule.startsWith("[memory]")))
      .toContain("documented");
  });

  it("keeps the documented table verbatim, so the contradiction stays legible", () => {
    // Deleting the claim would hide the lesson. Keeping it beside the measurement is the lesson.
    expect(GROK_MEMORY_DOCUMENTED_PRECEDENCE[0]).toBe("--no-memory CLI flag (always disables)");
    expect(GROK_MEMORY_DOCUMENTED_PRECEDENCE[2]).toContain("GROK_MEMORY");
    const docFlagRank = 0;
    const docEnvRank = 2;
    expect(docFlagRank, "the guide's order is the OPPOSITE of the measured one").toBeLessThan(docEnvRank);
  });

  it("no longer claims the flag has absolute precedence anywhere", () => {
    expect(GROK_MEMORY_PRECEDENCE.find((rule) => rule.startsWith("--no-memory")))
      .toContain("MEASURED to hold in the TUI and to be outranked");
  });
});

describe("the control that carries the guarantee is now the env var", () => {
  it("pins GROK_MEMORY=0 for the disabled policy", () => {
    expect(grokMemoryEnv("disabled")).toEqual({ [GROK_MEMORY_ENV_VAR]: GROK_MEMORY_DISABLED_VALUE });
    expect(GROK_MEMORY_ENV_VAR).toBe("GROK_MEMORY");
    expect(GROK_MEMORY_DISABLED_VALUE).toBe("0");
  });

  it("emits nothing for runtime-managed, so the pin follows the POLICY", () => {
    // Same discipline as the argv pin: when evidence eventually admits runtime-managed, the launch
    // path must stop pinning because the policy changed, not because someone edited three call sites.
    expect(grokMemoryEnv("runtime-managed")).toEqual({});
  });

  it("hands back a fresh object, so a caller cannot mutate one launch into another", () => {
    const first = grokMemoryEnv("disabled");
    first[GROK_MEMORY_ENV_VAR] = "1";
    expect(grokMemoryEnv("disabled")).toEqual({ [GROK_MEMORY_ENV_VAR]: GROK_MEMORY_DISABLED_VALUE });
  });

  it("still emits the flag, which is now belt rather than braces", () => {
    // Kept because it is free and documented; no longer described as immunity.
    expect(grokMemoryArgs("disabled")).toEqual([GROK_NO_MEMORY_FLAG]);
    expect(grokMemoryArgs("runtime-managed")).toEqual([]);
  });

  it("keeps the canonical policy disabled, in both channels at once", () => {
    expect(GROK_CANONICAL_MEMORY_POLICY).toBe("disabled");
    expect(grokMemoryArgs(GROK_CANONICAL_MEMORY_POLICY)).toEqual([GROK_NO_MEMORY_FLAG]);
    expect(grokMemoryEnv(GROK_CANONICAL_MEMORY_POLICY)).toEqual({ GROK_MEMORY: "0" });
  });
});

describe("what the correction does to the evidence record", () => {
  const capability = grokMemoryCapability(nativeMemoryCapability("grok")!);

  it("t-325794: marks disable VERIFIED, after isolating the env pin from the flag", () => {
    // t-0e88f3 left this `refuted` because only the FLAG had been measured, and it failed. The
    // canonical launch could not promote it either: in the TUI the flag alone already suffices, so
    // that arm cannot separate the pin's contribution. The isolating arm ran headless — where the
    // flag is known to LOSE — with a config enabler and no flag, and only GROK_MEMORY differed.
    expect(capability.evidence.disable).toBe("verified");
  });

  it("t-325794: keeps the refutation on record after the promotion", () => {
    // The guide's claim about `--no-memory` is still false. A record of a false claim does not expire
    // because a DIFFERENT control was later proven to work.
    const refutation = capability.refutations?.find((entry) => entry.axis === "disable");
    expect(refutation, "the refutation must survive the promotion").toBeDefined();
    expect(refutation!.claim).toContain("ALWAYS");
  });

  it("leaves every other axis declared, because nothing else was observed", () => {
    for (const axis of ["inventory", "enable", "injection", "mutation", "isolation"] as const) {
      expect(capability.evidence[axis], `${axis} still needs a session`).toBe("declared");
    }
  });

  it("moves the disable control from argv to environment", () => {
    // argv was the control that failed; the environment is the one Tachyon owns and the runtime honors.
    expect(capability.control.disable).toBe("environment");
  });

  it("carries the refutation itself, not just the verdict", () => {
    const refutation = capability.refutations?.find((entry) => entry.axis === "disable");
    expect(refutation, "a refuted axis without its finding is a summary with nothing behind it").toBeDefined();
    expect(refutation!.claim).toContain("--no-memory");
    expect(refutation!.claim, "the word that makes it refutable").toContain("ALWAYS");
    expect(refutation!.measured).toContain("MEMORY_INJECT_SEARCH");
    expect(refutation!.at).toContain("0.2.112");
    expect(refutation!.evidence).toContain("j-b02184d17f19");
  });

  it("records the TUI counter-observation too, not only the failure", () => {
    // A refutation that reported only the headless arm would read as "the flag does nothing", and the
    // TUI arms disproved that. Recording both is what keeps the entry honest in BOTH directions.
    const refutation = capability.refutations!.find((entry) => entry.axis === "disable")!;
    expect(refutation.measured).toContain("HEADLESS");
    expect(refutation.measured).toContain("interactive TUI");
    expect(refutation.measured, "the positive control that made the null arms readable").toContain("--experimental-memory");
    expect(refutation.measured).toContain("depends on the launch mode");
    // Every authorization that paid for a fact is named, so the spend is auditable against the claim.
    expect(refutation.evidence).toContain("a-b4b050");
    expect(refutation.evidence).toContain("a-c1a580");
    expect(refutation.evidence).toContain("a-a3db98");
  });

  it("pins the exact version the evidence describes", () => {
    expect(capability.runtimeVersion).toBe(GROK_MEMORY_MEASURED_VERSION);
    expect(GROK_MEMORY_MEASURED_VERSION).toBe("0.2.112");
  });

  it("t-325794: ALLOWS a disabled request now that the control itself was observed", () => {
    // Before the promotion this was blocked, and the reason string named a control that had FAILED.
    // A request may only be allowed on an observation of the control being asked for.
    const outcome = resolveMemoryPolicy({
      adapter: "grok",
      requested: "disabled",
      observedVersion: GROK_MEMORY_MEASURED_VERSION,
      capability,
    });
    expect(outcome.status).toBe("allowed");
    if (outcome.status !== "allowed") throw new Error("unreachable");
    expect(outcome.policy).toBe("disabled");
    // Rule 5 — disabling is not deleting, and the caller is told so rather than left to assume.
    expect(outcome.reasons.join(" ")).toContain("existing bytes are NOT deleted");
  });

  it("t-325794: a request against another installed version is still blocked", () => {
    // The promotion is bound to 0.2.112. Evidence measured for one build is not evidence about another.
    const outcome = resolveMemoryPolicy({
      adapter: "grok",
      requested: "disabled",
      observedVersion: "0.2.113",
      capability,
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasons.join(" ")).toContain("re-verify before trusting it");
  });

  it("still BLOCKS runtime-managed", () => {
    const outcome = resolveMemoryPolicy({
      adapter: "grok",
      requested: "runtime-managed",
      observedVersion: GROK_MEMORY_MEASURED_VERSION,
      capability,
    });
    expect(outcome.status).toBe("blocked");
  });
});

describe("the plan states its own cost before anyone authorizes it", () => {
  const plan = grokMemoryVerificationPlan();

  it("separates what is free from what must be authorized", () => {
    expect(plan.withoutModelCall.length).toBeGreaterThan(0);
    expect(plan.needsAuthorization.map((entry) => entry.axis)).toEqual([
      "disable",
      "enable",
      "injection",
      "mutation",
    ]);
    for (const entry of plan.needsAuthorization) expect(entry.proves.length).toBeGreaterThan(20);
  });

  it("describes the precedence line as the measured fact, not the documented one", () => {
    expect(plan.withoutModelCall[0]).toContain("MEASURED");
    expect(plan.withoutModelCall[0]).toContain("outranks");
  });

  it("keeps the disable axis pointed at the control that is still unproven", () => {
    // Arm A passed, but it does not isolate the env pin: the flag alone already suffices in the TUI.
    // What remains unmeasured is GROK_MEMORY=0 with NO flag, headless — and the plan must say so,
    // or the next reader will think the question was already settled.
    expect(plan.needsAuthorization.find((entry) => entry.axis === "disable")?.proves)
      .toContain("hostile GROK_MEMORY=1");
  });

  it("makes the fresh case test the DRIFT the pin exists for", () => {
    // Proving absence in a clean environment proves the weaker thing. The case that matters is hostile:
    // GROK_MEMORY=1 in the ambient env, and the marker still not reaching the model.
    expect(plan.lifecycle.find((entry) => entry.operation === "fresh")?.method).toContain("GROK_MEMORY=1");
  });

  it("says what fork would settle, since the registry calls it unknown", () => {
    expect(nativeMemoryCapability("grok")!.lifecycle.fork).toBe("unknown");
    expect(plan.lifecycle.find((entry) => entry.operation === "fork")?.method).toContain("shares memory");
  });

  it("records that the installed CLI exposes only `clear`", () => {
    // The research lists browse/edit/stats/clear; `grok memory --help` at 0.2.112 lists only `clear`,
    // so there is no non-billable status readout the way Codex has one.
    expect(plan.withoutModelCall.join(" ")).toContain("ONLY clear");
  });
});
