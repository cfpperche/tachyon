import { describe, expect, it } from "vitest";
import { PROBE_RUNTIME_SCHEMA } from "@tachyon/bridge/tools/fleet-probes.js";
import { isSupportedAgentRuntime } from "@tachyon/shared/agents/agentRuntimeAdmission.js";
import { activityNormalizerForRuntime } from "@tachyon/engine/activity/logWriter.js";
import { instructionsDeliverable } from "@tachyon/engine/config/loadConfig.js";
import { headlessProbeAdapters } from "@tachyon/engine/probe/adapters/registry.js";
import { runtimeProjectsPersistentInstructions } from "@tachyon/engine/agents/persistentInstructionsLaunch.js";
import {
  PARITY_DIMENSIONS,
  PARITY_RUNTIMES,
  RUNTIME_PARITY,
  parityDeclarationErrors,
  runtimeUsesSilentPersistenceHooks,
  type ParityCell,
} from "@tachyon/engine/runtime/parity.js";

function declaredWired(cell: ParityCell): boolean {
  return cell.projection.verdict === "wired";
}

describe("SDD 508 runtime parity declaration", () => {
  it("has every runtime × dimension cell and valid evidence metadata", () => {
    expect(parityDeclarationErrors(RUNTIME_PARITY)).toEqual([]);
  });

  it("refuses a missing cell", () => {
    const malformed = structuredClone(RUNTIME_PARITY) as unknown as Record<string, Record<string, unknown>>;
    delete malformed["session-hooks"]!.grok;
    expect(parityDeclarationErrors(malformed)).toContain("session-hooks/grok: missing parity cell");
  });

  it("refuses a missing projection or runtime half", () => {
    const withoutRuntime = structuredClone(RUNTIME_PARITY) as unknown as Record<string, Record<string, unknown>>;
    delete (withoutRuntime["session-hooks"]!.grok as Record<string, unknown>).runtime;
    expect(parityDeclarationErrors(withoutRuntime)).toContain("session-hooks/grok/runtime: missing parity fact");

    const withoutProjection = structuredClone(RUNTIME_PARITY) as unknown as Record<string, Record<string, unknown>>;
    delete (withoutProjection["session-hooks"]!.grok as Record<string, unknown>).projection;
    expect(parityDeclarationErrors(withoutProjection)).toContain("session-hooks/grok/projection: missing parity fact");
  });

  it("refuses cannot without a written reason in either half", () => {
    const malformed = structuredClone(RUNTIME_PARITY) as unknown as Record<string, Record<string, unknown>>;
    malformed["session-hooks"]!.grok = {
      projection: { verdict: "cannot" },
      runtime: { verdict: "cannot" },
    };
    expect(parityDeclarationErrors(malformed)).toEqual(expect.arrayContaining([
      "session-hooks/grok/projection: cannot requires a written reason",
      "session-hooks/grok/runtime: cannot requires a written reason",
    ]));
  });

  it("refuses measured runtime behavior without version and date", () => {
    const malformed = structuredClone(RUNTIME_PARITY) as unknown as Record<string, Record<string, unknown>>;
    (malformed["session-hooks"]!.grok as Record<string, unknown>).runtime = { verdict: "measured" };
    expect(parityDeclarationErrors(malformed)).toEqual(expect.arrayContaining([
      "session-hooks/grok/runtime: measured requires runtimeVersion",
      "session-hooks/grok/runtime: measured requires measuredAt as YYYY-MM-DD",
    ]));
  });

  it("refuses a mute unmeasured runtime half", () => {
    const malformed = structuredClone(RUNTIME_PARITY) as unknown as Record<string, Record<string, unknown>>;
    (malformed["session-hooks"]!.grok as Record<string, unknown>).runtime = { verdict: "unmeasured" };
    expect(parityDeclarationErrors(malformed)).toContain("session-hooks/grok/runtime: unmeasured requires needed");
  });

  it("refuses runtime behavior disguised as wired instead of explicitly unmeasured", () => {
    const malformed = structuredClone(RUNTIME_PARITY) as unknown as Record<string, Record<string, unknown>>;
    (malformed["session-hooks"]!.grok as Record<string, unknown>).runtime = { verdict: "wired" };
    expect(parityDeclarationErrors(malformed)).toContain(
      "session-hooks/grok/runtime: must be measured, cannot, or explicitly unmeasured; wired is projection-only",
    );
  });

  it("derives session-hooks through the runtime decision called by Workspace.silentPersistenceHooksDesired", () => {
    for (const runtime of PARITY_RUNTIMES) {
      const product = runtimeUsesSilentPersistenceHooks(runtime);
      const declared = declaredWired(RUNTIME_PARITY["session-hooks"][runtime]);
      expect(product, `session-hooks/${runtime}: product=${product ? "wired" : "not-wired"}, declaration=${declared ? "wired" : "not-wired"}`).toBe(declared);
    }
  });

  it("derives headless-probe through the adapter registry used by Workspace", () => {
    const adapters = headlessProbeAdapters();
    for (const runtime of PARITY_RUNTIMES) {
      const product = adapters.has(runtime) && PROBE_RUNTIME_SCHEMA.safeParse(runtime).success;
      const declared = declaredWired(RUNTIME_PARITY["headless-probe"][runtime]);
      expect(product, `headless-probe/${runtime}: product=${product ? "wired" : "not-wired"}, declaration=${declared ? "wired" : "not-wired"}`).toBe(declared);
    }
  });

  it("derives observed-model-provenance through the Activity normalizer registry", () => {
    for (const runtime of PARITY_RUNTIMES) {
      const product = activityNormalizerForRuntime(runtime) !== undefined;
      const declared = declaredWired(RUNTIME_PARITY["observed-model-provenance"][runtime]);
      expect(product, `observed-model-provenance/${runtime}: product=${product ? "wired" : "not-wired"}, declaration=${declared ? "wired" : "not-wired"}`).toBe(declared);
    }
  });

  it("derives probe-model-proof through each registered adapter's proof declaration", () => {
    const adapters = headlessProbeAdapters();
    for (const runtime of PARITY_RUNTIMES) {
      const adapter = adapters.get(runtime);
      const product = adapter?.reportsEffectiveModel === true && adapter.modelEvidence !== undefined;
      const declared = declaredWired(RUNTIME_PARITY["probe-model-proof"][runtime]);
      expect(product, `probe-model-proof/${runtime}: product=${product ? "wired" : "not-wired"}, declaration=${declared ? "wired" : "not-wired"}`).toBe(declared);
    }
  });

  it("derives cross-runtime-task-continuation through destination admission and brief delivery", () => {
    for (const runtime of PARITY_RUNTIMES) {
      const product = isSupportedAgentRuntime(runtime) && instructionsDeliverable(runtime);
      const declared = declaredWired(RUNTIME_PARITY["cross-runtime-task-continuation"][runtime]);
      expect(product, `cross-runtime-task-continuation/${runtime}: product=${product ? "wired" : "not-wired"}, declaration=${declared ? "wired" : "not-wired"}`).toBe(declared);
    }
  });

  it("derives persistent-instructions-launch through the projector AgentManager calls", () => {
    for (const runtime of PARITY_RUNTIMES) {
      const product = runtimeProjectsPersistentInstructions(runtime);
      const declared = declaredWired(RUNTIME_PARITY["persistent-instructions-launch"][runtime]);
      expect(product, `persistent-instructions-launch/${runtime}: product=${product ? "wired" : "not-wired"}, declaration=${declared ? "wired" : "not-wired"}`).toBe(declared);
    }
  });

  it("keeps the declaration axes closed to the scoped runtimes and implemented dimensions", () => {
    expect(Object.keys(RUNTIME_PARITY)).toEqual([...PARITY_DIMENSIONS]);
    for (const dimension of PARITY_DIMENSIONS) {
      expect(Object.keys(RUNTIME_PARITY[dimension])).toEqual([...PARITY_RUNTIMES]);
    }
  });
});
