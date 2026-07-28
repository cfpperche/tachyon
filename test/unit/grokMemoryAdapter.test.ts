import { describe, expect, it } from "vitest";
import {
  GROK_CANONICAL_MEMORY_POLICY,
  GROK_MEMORY_MEASURED_VERSION,
  GROK_MEMORY_PRECEDENCE,
  GROK_NO_MEMORY_FLAG,
  grokMemoryArgs,
  grokMemoryCapability,
  grokMemoryVerificationPlan,
} from "../../src/runtime/adapters/grokMemory.js";
import { nativeMemoryCapability, resolveMemoryPolicy } from "../../src/runtime/nativeMemory.js";

/**
 * t-c46c35 — the one task in this lane where measurement produces a product change.
 *
 * Measured against Grok 0.2.112 (installed CLI `grok --help` and the shipped user guide
 * `~/.grok/docs/user-guide/13-memory.md`) on 2026-07-28. No model call was made, and no memory store
 * was read — only shipped documentation and flag help.
 */

describe("why the flag is pinned rather than trusted to the default", () => {
  it("records the documented precedence, highest first", () => {
    // The reason for the whole change: canonical Grok was relying on rule 5, while rules 3 and 4 sit
    // ABOVE it and are writable by anyone with an environment or a config file.
    expect(GROK_MEMORY_PRECEDENCE[0]).toContain("--no-memory");
    expect(GROK_MEMORY_PRECEDENCE[0]).toContain("always disables");
    expect(GROK_MEMORY_PRECEDENCE[2]).toContain("GROK_MEMORY");
    expect(GROK_MEMORY_PRECEDENCE[3]).toContain("config.toml");
    expect(GROK_MEMORY_PRECEDENCE[4]).toContain("default: disabled");
    // GROK_MEMORY outranks config, and both outrank the default — which is what made inheriting the
    // default insufficient.
    expect(GROK_MEMORY_PRECEDENCE.indexOf("GROK_MEMORY env var: 1/true enables, 0/false disables"))
      .toBeLessThan(GROK_MEMORY_PRECEDENCE.indexOf("default: disabled"));
  });

  it("emits the flag for the disabled policy", () => {
    expect(grokMemoryArgs("disabled")).toEqual([GROK_NO_MEMORY_FLAG]);
  });

  it("emits nothing for runtime-managed, so the pin follows the POLICY", () => {
    // Keyed on policy rather than hardcoded: when evidence eventually admits runtime-managed, the
    // launch path should stop pinning because the policy changed — not because someone edited a
    // harness branch and hoped it was the only one.
    expect(grokMemoryArgs("runtime-managed")).toEqual([]);
  });

  it("hands back a fresh array, so a caller cannot mutate one launch into another", () => {
    const first = grokMemoryArgs("disabled");
    first.push("--experimental-memory");
    expect(grokMemoryArgs("disabled")).toEqual([GROK_NO_MEMORY_FLAG]);
  });

  it("keeps the canonical policy disabled", () => {
    expect(GROK_CANONICAL_MEMORY_POLICY).toBe("disabled");
    expect(grokMemoryArgs(GROK_CANONICAL_MEMORY_POLICY)).toEqual([GROK_NO_MEMORY_FLAG]);
  });
});

describe("what the pin does and does NOT promote", () => {
  const capability = grokMemoryCapability(nativeMemoryCapability("grok")!);

  it("promotes NO evidence axis, because pinning a flag is not an observation", () => {
    // The lane's whole value is that control and evidence never get conflated. `--no-memory` having
    // absolute precedence is a strong guarantee; it is still not a measurement of what Grok did.
    for (const axis of ["inventory", "disable", "enable", "injection", "mutation", "isolation"] as const) {
      expect(capability.evidence[axis], `${axis} still needs a session`).toBe("declared");
    }
  });

  it("keeps disable as an argv control — the property the pin relies on", () => {
    expect(capability.control.disable).toBe("argv");
  });

  it("pins the exact version the evidence describes", () => {
    expect(capability.runtimeVersion).toBe(GROK_MEMORY_MEASURED_VERSION);
    expect(GROK_MEMORY_MEASURED_VERSION).toBe("0.2.112");
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

  it("makes the fresh case test the DRIFT the pin exists for", () => {
    // Proving absence in a clean environment would prove the weaker thing. The case that matters is a
    // hostile one: GROK_MEMORY=1 set, and the marker still not reaching the model.
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
