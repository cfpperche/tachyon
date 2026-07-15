import { describe, expect, it } from "vitest";
import { buildRuntimeOpsSnapshot } from "../../src/runtimeOps/model.js";
import type { CollectorEnvelopeV1 } from "../../src/runtimeObservability/types.js";

const GENERATED_AT = "2026-07-09T21:00:00.000Z";
const OBSERVED_AT = "2026-07-09T20:59:00.000Z";

describe("Runtime Ops provider capacity projection (SDD 369 T4)", () => {
  it("publishes schema V2 with account capacity separate from native runtime and agent attribution", () => {
    const snapshot = buildRuntimeOpsSnapshot({
      generatedAt: GENERATED_AT,
      detectedRuntimes: ["codex"],
      agents: [{ workspaceKey: "ws", workspaceLabel: "app", agentName: "worker", runtime: "codex" }],
      providerObservations: state({ codex: quotaEnvelope("codex") }),
    });

    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.runtimes[0].agents[0].key).toBe("ws:worker");
    expect(snapshot.providerCapacity[0]).toMatchObject({
      provider: "codex",
      scope: "provider-account",
      configuration: { state: "enabled", sources: ["cli"] },
      quota: { state: "available", source: "cli", confidence: "exact" },
    });
    expect(snapshot.providerCapacity[0]).not.toHaveProperty("agentKey");
    expect(snapshot.providerCapacity[0]).not.toHaveProperty("workspaceKey");
  });

  it("re-allows only quota/source/confidence/freshness/reset fields and strips host scope and raw payload data", () => {
    const marker = "RAW_PROVIDER_SECRET_MUST_NOT_CROSS";
    const envelope = quotaEnvelope("codex");
    const fact = envelope.facts[0];
    if (fact.kind !== "provider-quota") throw new Error("quota fixture is invalid");
    const input = state({
      codex: {
        ...envelope,
        rawResponse: marker,
        account: { email: marker },
        facts: [{
          ...fact,
          rawResponse: marker,
          scope: {
            kind: "provider-account",
            provider: "codex",
            key: "ps_1111111111111111",
            accountEmail: marker,
          },
        }],
      },
    });

    const snapshot = buildRuntimeOpsSnapshot({
      generatedAt: GENERATED_AT,
      detectedRuntimes: [],
      agents: [],
      providerObservations: input,
    });
    const codex = snapshot.providerCapacity[0];
    expect(codex.quota).toEqual({
      state: "available",
      source: "cli",
      confidence: "exact",
      observedAt: OBSERVED_AT,
      freshness: { state: "fresh" },
      windows: [
        { name: "session", usedPercent: 25, windowMinutes: 300, resetsAt: "2026-07-09T22:00:00.000Z" },
        { name: "weekly", usedPercent: 60 },
      ],
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain("ps_1111111111111111");
    expect(serialized).not.toContain("tachyon-codex-test");
  });

  it("fails an enabled provider closed on incompatible schema without losing native runtime rows", () => {
    const marker = "RAW_INVALID_PROVIDER_ERROR_MUST_NOT_CROSS";
    const snapshot = buildRuntimeOpsSnapshot({
      generatedAt: GENERATED_AT,
      detectedRuntimes: ["grok"],
      agents: [],
      providerObservations: {
        preferences: { codex: preference("codex") },
        observations: { codex: { schemaVersion: 999, error: marker } },
      },
    });

    expect(snapshot.runtimes.map((runtime) => runtime.runtime)).toEqual(["grok"]);
    expect(snapshot.providerCapacity[0].quota).toEqual({
      state: "unavailable",
      source: "cli",
      observedAt: GENERATED_AT,
      reason: "invalid-payload",
    });
    expect(JSON.stringify(snapshot)).not.toContain(marker);
  });

  it("ignores cached observations for disabled providers and emits deterministic provider order", () => {
    const snapshot = buildRuntimeOpsSnapshot({
      generatedAt: GENERATED_AT,
      detectedRuntimes: [],
      agents: [],
      providerObservations: {
        preferences: {},
        observations: { codex: quotaEnvelope("codex"), claude: quotaEnvelope("claude") },
      },
    });

    expect(snapshot.providerCapacity.map((provider) => provider.provider)).toEqual(["codex", "claude"]);
    expect(snapshot.providerCapacity.map((provider) => provider.configuration.state)).toEqual(["disabled", "disabled"]);
    expect(snapshot.providerCapacity.map((provider) => provider.quota)).toEqual([
      { state: "unavailable", observedAt: GENERATED_AT, reason: "source-disabled" },
      { state: "unavailable", observedAt: GENERATED_AT, reason: "source-disabled" },
    ]);
  });

  it("preserves bounded stale and unavailable metadata but rejects a source outside the explicit grant", () => {
    const stale = quotaEnvelope("claude");
    const staleFact = stale.facts[0];
    if (staleFact.kind !== "provider-quota") throw new Error("quota fixture is invalid");
    stale.facts[0] = {
      ...staleFact,
      freshness: { state: "stale" as const, lastGoodAt: "2026-07-09T20:45:00.000Z" },
    };
    stale.facts.push({
      kind: "provider-unavailable",
      scope: { ...staleFact.scope },
      source: "cli",
      observedAt: GENERATED_AT,
      reason: "timeout",
      lastGoodAt: "2026-07-09T20:45:00.000Z",
    });
    const timeout = unavailableEnvelope("codex", "timeout", "2026-07-09T20:40:00.000Z");
    const snapshot = buildRuntimeOpsSnapshot({
      generatedAt: GENERATED_AT,
      detectedRuntimes: [],
      agents: [],
      providerObservations: state({ codex: timeout, claude: stale }),
    });

    expect(snapshot.providerCapacity[0].quota).toMatchObject({
      state: "unavailable",
      reason: "timeout",
      lastGoodAt: "2026-07-09T20:40:00.000Z",
    });
    expect(snapshot.providerCapacity[1].quota).toMatchObject({
      state: "available",
      freshness: { state: "stale", lastGoodAt: "2026-07-09T20:45:00.000Z" },
    });

    const wrongSource = quotaEnvelope("codex");
    const fact = wrongSource.facts[0];
    if (fact.kind === "provider-quota") fact.source = "oauth";
    const rejected = buildRuntimeOpsSnapshot({
      generatedAt: GENERATED_AT,
      detectedRuntimes: [],
      agents: [],
      providerObservations: state({ codex: wrongSource }, ["codex"]),
    });
    expect(rejected.providerCapacity[0].quota).toMatchObject({ state: "unavailable", reason: "invalid-payload" });

    const wrongScope = quotaEnvelope("codex");
    const scopedFact = wrongScope.facts[0];
    if (scopedFact.kind !== "provider-quota") throw new Error("quota fixture is invalid");
    scopedFact.scope.key = "ps_3333333333333333";
    const wrongScopeSnapshot = buildRuntimeOpsSnapshot({
      generatedAt: GENERATED_AT,
      detectedRuntimes: [],
      agents: [],
      providerObservations: state({ codex: wrongScope }, ["codex"]),
    });
    expect(wrongScopeSnapshot.providerCapacity[0].quota).toMatchObject({
      state: "unavailable",
      reason: "invalid-payload",
    });
    expect(JSON.stringify(wrongScopeSnapshot)).not.toContain("ps_3333333333333333");
  });
});

function state(
  observations: Record<string, unknown>,
  enabled: readonly ("codex" | "claude")[] = ["codex", "claude"],
): unknown {
  return {
    preferences: Object.fromEntries(enabled.map((provider) => [provider, preference(provider)])),
    observations,
  };
}

function preference(provider: "codex" | "claude"): unknown {
  return {
    scope: {
      kind: "provider-account",
      provider,
      key: provider === "codex" ? "ps_1111111111111111" : "ps_2222222222222222",
    },
    sources: ["cli"],
  };
}

function quotaEnvelope(provider: "codex" | "claude"): CollectorEnvelopeV1 {
  return {
    schemaVersion: 1 as const,
    collector: { id: `tachyon-${provider}-test`, version: "1.0.0" },
    generatedAt: GENERATED_AT,
    facts: [{
      kind: "provider-quota" as const,
      scope: {
        kind: "provider-account" as const,
        provider,
        key: provider === "codex" ? "ps_1111111111111111" : "ps_2222222222222222",
      },
      source: "cli" as const,
      confidence: "exact" as const,
      observedAt: OBSERVED_AT,
      freshness: { state: "fresh" as const },
      windows: [
        { name: "weekly" as const, usedPercent: 60 },
        { name: "session" as const, usedPercent: 25, windowMinutes: 300, resetsAt: "2026-07-09T22:00:00.000Z" },
      ],
    }],
    diagnostics: [],
  };
}

function unavailableEnvelope(
  provider: "codex" | "claude",
  reason: "timeout",
  lastGoodAt: string,
): CollectorEnvelopeV1 {
  return {
    schemaVersion: 1 as const,
    collector: { id: `tachyon-${provider}-test`, version: "1.0.0" },
    generatedAt: GENERATED_AT,
    facts: [{
      kind: "provider-unavailable" as const,
      scope: {
        kind: "provider-account" as const,
        provider,
        key: provider === "codex" ? "ps_1111111111111111" : "ps_2222222222222222",
      },
      source: "cli" as const,
      observedAt: OBSERVED_AT,
      reason,
      lastGoodAt,
    }],
    diagnostics: [],
  };
}
