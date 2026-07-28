import { describe, expect, it } from "vitest";
import {
  BEHAVIORAL_MEMORY_EVIDENCE,
  MEMORY_EVIDENCE_AXES,
  MEMORY_LIFECYCLE_OPERATIONS,
  RUNTIME_NATIVE_MEMORY_REGISTRY,
  assertRefutationsAreExplained,
  canExportMemory,
  isBehavioralEvidence,
  nativeMemoryCapability,
  resolveMemoryPolicy,
  type RuntimeNativeMemoryCapabilityV1,
} from "../../src/runtime/nativeMemory.js";

/**
 * t-56daa1 — the typed capability and its fail-closed resolution.
 *
 * The research (`docs/research/runtime-native-memory-parity-t-d4c42e.md`) measured six runtimes and
 * concluded that one three-value enum loses the facts that matter. What is asserted here is the
 * consequence of that: each axis is independent, `verified` never comes from configuration, and every
 * "we could not prove it" renders as BLOCKED rather than as silence.
 *
 * The registry is authored entirely at `declared`/`unsupported`, which is the honest state of the
 * product as measured — so these tests double as the proof that nothing was quietly upgraded while
 * being typed.
 */
const claude = () => nativeMemoryCapability("claude")!;

/** A capability with every axis verified — what a runtime looks like AFTER the per-runtime tasks. */
function fullyVerified(over: Partial<RuntimeNativeMemoryCapabilityV1> = {}): RuntimeNativeMemoryCapabilityV1 {
  return {
    schemaVersion: 1,
    adapter: "example",
    runtimeVersion: "1.0.0",
    mechanism: "native",
    defaultState: "enabled",
    evidence: {
      inventory: "verified",
      disable: "verified",
      enable: "verified",
      injection: "verified",
      mutation: "verified",
      isolation: "verified",
    },
    control: { detect: "config", disable: "config", enable: "config", purge: "native-command", export: "files" },
    injection: { mode: "startup-bounded", bound: { kind: "lines", value: 200 } },
    mutation: { modes: ["agent-tool"] },
    storage: { owner: "runtime", scope: "repository", privateHomeBound: true, aliasesWorktrees: false },
    lifecycle: { fresh: "retain", restart: "retain", resume: "retain", fork: "reset" },
    sources: [{ kind: "behavioral-test", ref: "test/unit/runtimeNativeMemoryVerifier.test.ts" }],
    ...over,
  };
}

describe("the registry records what was measured, at the version it was measured", () => {
  it("covers the runtimes the research measured, each pinned to an exact version", () => {
    // A capability is a statement about ONE version — a floor or a range would be the drift the
    // research called out by name for Codex.
    for (const [adapter, capability] of Object.entries(RUNTIME_NATIVE_MEMORY_REGISTRY)) {
      expect(capability.adapter, `${adapter} keys its own name`).toBe(adapter);
      expect(capability.schemaVersion).toBe(1);
      expect(capability.runtimeVersion, `${adapter} pins a version`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(capability.sources.length, `${adapter} cites evidence`).toBeGreaterThan(0);
    }
    // The three the product canonicalizes with native memory, which this contract exists to serve.
    for (const adapter of ["claude", "codex", "grok"]) {
      expect(nativeMemoryCapability(adapter)?.mechanism).toBe("native");
    }
  });

  it("claims NOTHING as verified — that is the measured state, not an omission", () => {
    // The research says it for each runtime: "disable declared; enable/injection behavior not
    // verified by Tachyon". If this ever fails, someone hand-edited evidence instead of running the
    // verifier, which is exactly the shortcut the whole design exists to prevent.
    for (const [adapter, capability] of Object.entries(RUNTIME_NATIVE_MEMORY_REGISTRY)) {
      for (const axis of MEMORY_EVIDENCE_AXES) {
        expect(capability.evidence[axis], `${adapter}.${axis} was upgraded without a behavioral test`).not.toBe("verified");
      }
    }
  });

  it("gives every lifecycle operation an explicit answer", () => {
    // Rule 7: fresh/restart/resume/fork never INFER copy semantics, so every operation must be stated
    // — including as `unknown`, which fails closed rather than being filled in at fork time.
    for (const [adapter, capability] of Object.entries(RUNTIME_NATIVE_MEMORY_REGISTRY)) {
      for (const operation of MEMORY_LIFECYCLE_OPERATIONS) {
        expect(capability.lifecycle[operation], `${adapter} has no answer for ${operation}`).toBeTruthy();
      }
    }
  });

  it("keeps the measured asymmetries the enum would have flattened", () => {
    // Each of these is a fact the research separated on purpose; a single enum could not hold them.
    expect(claude().defaultState).toBe("enabled");            // memory is ON out of the box
    expect(claude().storage.aliasesWorktrees).toBe(true);      // clones/worktrees share a store
    expect(nativeMemoryCapability("codex")?.defaultState).toBe("disabled");
    expect(nativeMemoryCapability("codex")?.lifecycle.fork).toBe("unavailable");
    // t-0e88f3 — was `argv` on the strength of the guide's precedence table; measurement refuted it,
    // so the control moved to the channel Tachyon owns and the runtime honors.
    expect(nativeMemoryCapability("grok")?.control.disable).toBe("environment");
    // A runtime with no built-in memory can still inject persistent context through a plugin.
    expect(nativeMemoryCapability("opencode")?.mechanism).toBe("none");
    expect(nativeMemoryCapability("opencode")?.extensionBoundary?.present).toBe(true);
  });
});

describe("t-0e88f3 — the vocabulary can say 'tested and failed'", () => {
  it("treats verified and refuted as the two behavioral values", () => {
    // Both are claims about what a runtime DID, and neither may be authored from documentation. The
    // symmetry is the point: a claim cannot be talked into either one.
    expect(BEHAVIORAL_MEMORY_EVIDENCE).toEqual(["verified", "refuted"]);
    expect(isBehavioralEvidence("verified")).toBe(true);
    expect(isBehavioralEvidence("refuted")).toBe(true);
    expect(isBehavioralEvidence("declared")).toBe(false);
    expect(isBehavioralEvidence("unsupported")).toBe(false);
  });

  it("refuses a refuted axis with no refutation behind it", () => {
    // A bare verdict is only marginally better than the `declared` it replaced: it says a measurement
    // happened without saying what failed, so nobody can check it or avoid repeating it.
    const bare = {
      ...nativeMemoryCapability("grok")!,
      evidence: { ...nativeMemoryCapability("grok")!.evidence, injection: "refuted" as const },
    };
    expect(() => assertRefutationsAreExplained({ grok: bare }))
      .toThrow(/evidence\.injection is 'refuted' with no matching refutations entry/);
  });

  it("refuses a refutation the axis does not reflect", () => {
    // The other direction: a recorded contradiction that the axis still reports as `declared` would
    // leave the finding invisible to every reader who looks at the axis, which is most of them.
    const mismatched = {
      ...nativeMemoryCapability("grok")!,
      evidence: { ...nativeMemoryCapability("grok")!.evidence, disable: "declared" as const },
    };
    expect(() => assertRefutationsAreExplained({ grok: mismatched }))
      .toThrow(/refutations names 'disable' but evidence\.disable is 'declared'/);
  });

  it("holds for the shipped registry, checked at module load rather than only here", () => {
    expect(() => assertRefutationsAreExplained(RUNTIME_NATIVE_MEMORY_REGISTRY)).not.toThrow();
  });

  it("records exactly one refutation today, and it is Grok's disable axis", () => {
    const refuted = Object.entries(RUNTIME_NATIVE_MEMORY_REGISTRY)
      .flatMap(([adapter, capability]) => (capability.refutations ?? []).map((r) => `${adapter}.${r.axis}`));
    expect(refuted).toEqual(["grok.disable"]);
  });
});

describe("resolution fails closed", () => {
  it("blocks an unregistered runtime rather than assuming it has no memory", () => {
    const outcome = resolveMemoryPolicy({ adapter: "mystery", requested: "disabled", observedVersion: "1.0.0" });
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasons[0]).toContain("no measured native-memory capability");
  });

  it("blocks when the installed version is unknown or different", () => {
    expect(resolveMemoryPolicy({ adapter: "claude", requested: "disabled" }).status).toBe("blocked");
    const drifted = resolveMemoryPolicy({ adapter: "claude", requested: "disabled", observedVersion: "2.2.0" });
    expect(drifted.status).toBe("blocked");
    expect(drifted.reasons[0]).toContain("measured on 2.1.220");
  });

  it("rule 1: `disabled` needs VERIFIED disable — authored bytes are not evidence", () => {
    const outcome = resolveMemoryPolicy({ adapter: "claude", requested: "disabled", observedVersion: "2.1.220" });
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasons[0]).toContain("only proves Tachyon authored bytes");
  });

  it("rule 4: memory ON by default plus unverifiable disable blocks readiness, loudly", () => {
    // The failure this prevents: rendering as `Ready` while nobody can say whether memory is off.
    const outcome = resolveMemoryPolicy({ adapter: "claude", requested: "disabled", observedVersion: "2.1.220" });
    expect(outcome.reasons.join(" ")).toContain("blocked rather than Ready");
    // Codex measured OFF by default, so it blocks WITHOUT that second sentence — the distinction is
    // the point: both are unverified, only one is dangerous today.
    const codex = resolveMemoryPolicy({ adapter: "codex", requested: "disabled", observedVersion: "0.145.0" });
    expect(codex.status).toBe("blocked");
    expect(codex.reasons.join(" ")).not.toContain("blocked rather than Ready");
  });

  it("allows `disabled` once disable is verified — and says the bytes are still there", () => {
    const outcome = resolveMemoryPolicy({
      adapter: "example",
      requested: "disabled",
      observedVersion: "1.0.0",
      capability: fullyVerified(),
    });
    expect(outcome.status).toBe("allowed");
    // Rule 5: disabling is not deleting, and a caller must not read it as such.
    expect(outcome.reasons.join(" ")).toContain("NOT deleted");
  });

  it("rule 2: `runtime-managed` needs every axis, a complete lifecycle and a purge path", () => {
    const missingAxis = resolveMemoryPolicy({
      adapter: "example",
      requested: "runtime-managed",
      observedVersion: "1.0.0",
      capability: fullyVerified({
        evidence: { ...fullyVerified().evidence, injection: "declared", isolation: "declared" },
      }),
    });
    expect(missingAxis.status).toBe("blocked");
    expect(missingAxis.reasons.join(" ")).toContain("injection=declared");
    expect(missingAxis.reasons.join(" ")).toContain("isolation=declared");

    const noPurge = resolveMemoryPolicy({
      adapter: "example",
      requested: "runtime-managed",
      observedVersion: "1.0.0",
      capability: fullyVerified({ control: { ...fullyVerified().control, purge: "none" } }),
    });
    expect(noPurge.reasons.join(" ")).toContain("never removed on request");
  });

  it("rule 7: an unknown lifecycle operation blocks runtime-managed", () => {
    const outcome = resolveMemoryPolicy({
      adapter: "example",
      requested: "runtime-managed",
      observedVersion: "1.0.0",
      capability: fullyVerified({ lifecycle: { fresh: "retain", restart: "retain", resume: "retain", fork: "unknown" } }),
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasons.join(" ")).toContain("never infer copy semantics");
  });

  it("rule 4: an uncontrolled extension boundary blocks runtime-managed even when every axis is verified", () => {
    const outcome = resolveMemoryPolicy({
      adapter: "example",
      requested: "runtime-managed",
      observedVersion: "1.0.0",
      capability: fullyVerified({ extensionBoundary: { present: true, why: "a plugin can inject before dispatch" } }),
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasons.join(" ")).toContain("uncontrolled extension boundary");
  });

  it("blocks runtime-managed when the store is not proven bound to the private home", () => {
    const outcome = resolveMemoryPolicy({
      adapter: "example",
      requested: "runtime-managed",
      observedVersion: "1.0.0",
      capability: fullyVerified({ storage: { ...fullyVerified().storage, privateHomeBound: "unknown" } }),
    });
    expect(outcome.reasons.join(" ")).toContain("not proven bound to the private home");
  });

  it("allows runtime-managed only when everything holds at once", () => {
    const outcome = resolveMemoryPolicy({
      adapter: "example",
      requested: "runtime-managed",
      observedVersion: "1.0.0",
      capability: fullyVerified(),
    });
    expect(outcome.status).toBe("allowed");
    expect(outcome).toMatchObject({ policy: "runtime-managed" });
  });

  it("rule 3: `unsupported` is about the BUILT-IN runtime, and still reports the extension", () => {
    const outcome = resolveMemoryPolicy({ adapter: "opencode", requested: "disabled", observedVersion: "1.18.4" });
    expect(outcome.status).toBe("unsupported");
    // Reporting it is the whole point: "no built-in memory" must not read as "nothing can inject".
    expect(outcome.reasons.join(" ")).toContain("extension boundary remains uncontrolled");

    // And a runtime with nothing to manage cannot be asked to manage it.
    const managed = resolveMemoryPolicy({ adapter: "opencode", requested: "runtime-managed", observedVersion: "1.18.4" });
    expect(managed.status).toBe("blocked");
  });

  it("blocks every native runtime in the registry today — the honest state, stated", () => {
    // If this ever passes for a runtime, it is because someone ran the verifier and promoted evidence,
    // which is exactly the intended path. Until then, nothing is quietly allowed.
    for (const adapter of ["claude", "codex", "grok", "hermes"]) {
      const capability = nativeMemoryCapability(adapter)!;
      const outcome = resolveMemoryPolicy({ adapter, requested: "disabled", observedVersion: capability.runtimeVersion });
      expect(outcome.status, `${adapter} should still be blocked`).toBe("blocked");
    }
  });
});

describe("rule 6: export is narrow and explicit", () => {
  it("refuses when the runtime exposes no export path", () => {
    const outcome = canExportMemory(nativeMemoryCapability("codex")!);
    expect(outcome.allowed).toBe(false);
    // Copying the directory would sweep in indexes and state DBs, which rule 6 keeps out.
    expect(outcome.reason).toContain("indexes and state");
  });

  it("allows selected runtime-owned text through a real export path", () => {
    const outcome = canExportMemory(nativeMemoryCapability("claude")!);
    expect(outcome.allowed).toBe(true);
    expect(outcome.reason).toContain("credentials stay out");
  });

  it("has nothing to export where there is no built-in memory", () => {
    expect(canExportMemory(nativeMemoryCapability("pi")!).allowed).toBe(false);
  });
});
