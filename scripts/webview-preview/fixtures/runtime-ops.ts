import { emptyRuntimeOpsSnapshot, unavailableRuntimeOpsSnapshot } from "../../../src/runtimeOps/types";
import type { RuntimeOpsSnapshot, RuntimeOpsSnapshotV2 } from "../../../src/runtimeOps/types";
import { buildRuntimeOpsSnapshot } from "@tachyon/engine/runtimeOps/model.js";
import { projectRuntimeOpsProviderCapacity } from "@tachyon/engine/runtimeOps/providerProjection.js";
import type {
  CollectorEnvelopeV1,
  ObservationConfidenceV1,
  ObservationFreshnessV1,
  ProviderQuotaWindowV1,
  ProviderUnavailableReasonV1,
  RuntimeObservabilityProviderV1,
} from "@tachyon/engine/runtimeObservability/types.js";
import type { ProviderObservationPreferenceV1 } from "@tachyon/engine/runtimeObservability/preferences.js";
import type { Fixture } from "../routes";

export type RuntimeOpsPreviewState =
  | { state: "loading" }
  | { state: "snapshot"; snapshot: RuntimeOpsSnapshot };

const snapshotFixture = (snapshot: RuntimeOpsSnapshot): Fixture<RuntimeOpsPreviewState> => ({
  provenance: "synthetic-edge",
  vm: { state: "snapshot", snapshot },
});

const nativeMixed = buildRuntimeOpsSnapshot({
      generatedAt: "2026-07-09T21:00:00.000Z",
      detectedRuntimes: ["claude", "codex", "grok"],
      agents: [
        {
          workspaceKey: "a1b2c3", workspaceLabel: "tachyon", agentName: "claude", runtime: "claude",
          usage: { runtime: "claude", agent: "claude", inputTokens: 18400, outputTokens: 2200, cacheReadTokens: 40500, lastActivity: "2026-07-09T20:58:00.000Z" },
          lastActivity: "2026-07-09T20:58:00.000Z", runtimeVersion: "2.1.9", versionObservedAt: "2026-07-09T20:58:00.000Z",
          status: "running", attention: { state: "working", stale: false },
          model: { state: "available", value: "Opus 4.8", source: "runtime-profile" },
          resume: { state: "live", reason: "Agent process is currently live." },
          bridge: { currentGeneration: 7, boundGeneration: 7, wired: true, clientState: "ok" },
        },
        {
          workspaceKey: "a1b2c3", workspaceLabel: "tachyon", agentName: "codex", runtime: "codex",
          usage: { runtime: "codex", agent: "codex", inputTokens: 96300, outputTokens: 8700, cacheReadTokens: 124000, lastActivity: "2026-07-09T20:59:30.000Z" },
          lastActivity: "2026-07-09T20:59:30.000Z", runtimeVersion: "0.55.90", versionObservedAt: "2026-07-09T20:59:30.000Z",
          status: "running",
          attention: { state: "throttled", stale: false, rateLimit: { runtime: "codex", scope: "5h", resetAt: 1783634400000, message: "Throttled - see agent terminal" } },
          model: { state: "available", value: "GPT-5.1 Codex", source: "command" },
          resume: { state: "live", reason: "Agent process is currently live." },
          bridge: { currentGeneration: 7, boundGeneration: 6, wired: true, clientState: "suspect" },
        },
      ],
	});

const providerHealthy = withProviderState(providerObservationState({
  codex: quotaEnvelope("codex", [
    { name: "session", usedPercent: 72, windowMinutes: 300, resetsAt: "2026-07-09T22:30:00.000Z" },
    { name: "weekly", usedPercent: 41, windowMinutes: 10_080, resetsAt: "2026-07-14T00:00:00.000Z" },
  ]),
  claude: quotaEnvelope("claude", [
    { name: "session", usedPercent: 26, windowMinutes: 300, resetsAt: "2026-07-10T00:00:00.000Z" },
    { name: "weekly", usedPercent: 58, windowMinutes: 10_080, resetsAt: "2026-07-15T00:00:00.000Z" },
  ]),
}));

const providerExhausted = withProviderState(providerObservationState({
  codex: quotaEnvelope("codex", [
    { name: "session", usedPercent: 100, windowMinutes: 300, resetsAt: "2026-07-09T22:30:00.000Z" },
    { name: "weekly", usedPercent: 99.8, windowMinutes: 10_080, resetsAt: "2026-07-14T00:00:00.000Z" },
  ]),
}, ["codex"]));

const providerPartial = withProviderState(providerObservationState({
  codex: quotaEnvelope("codex", [
    { name: "session", usedPercent: 33, windowMinutes: 300 },
  ], "estimated"),
  claude: unavailableEnvelope("claude", "not-observed"),
}));

const providerUnauthenticated = withProviderState(providerObservationState({
  codex: unavailableEnvelope("codex", "unauthenticated"),
}, ["codex"]));

const providerStale = withProviderState(providerObservationState({
  claude: staleEnvelope("claude", [
    { name: "session", usedPercent: 67, windowMinutes: 300, resetsAt: "2026-07-09T22:30:00.000Z" },
    { name: "weekly", usedPercent: 78, windowMinutes: 10_080, resetsAt: "2026-07-14T00:00:00.000Z" },
  ]),
}, ["claude"]));

const providerTimeout = withProviderState(providerObservationState({
  codex: unavailableEnvelope("codex", "timeout", "2026-07-09T20:45:00.000Z"),
}, ["codex"]));

const providerInvalid = withProviderState({
  preferences: { codex: preference("codex") },
  observations: {
    codex: {
      schemaVersion: 999,
      rawAccount: "RAW_ACCOUNT_MUST_NOT_RENDER",
      token: "RAW_PROVIDER_TOKEN_MUST_NOT_RENDER",
      error: "RAW_PROVIDER_ERROR_MUST_NOT_RENDER",
    },
  },
});

const providerDisabled = withProviderState(providerObservationState({}, []));
const mixed = providerHealthy;

const throttled = buildRuntimeOpsSnapshot({
  generatedAt: "2026-07-09T21:00:00.000Z",
  detectedRuntimes: ["codex"],
  agents: [
    {
      workspaceKey: "ops01", workspaceLabel: "runtime-ops", agentName: "rate-limited", runtime: "codex",
      usage: { runtime: "codex", agent: "RAW_TOKEN_MUST_NOT_RENDER", inputTokens: 200, outputTokens: 40, lastActivity: "RAW_TOKEN_MUST_NOT_RENDER" },
      lastActivity: "RAW_TOKEN_MUST_NOT_RENDER", runtimeVersion: "RAW_PATH_MUST_NOT_RENDER", status: "running",
      attention: {
        state: "throttled", stale: false, matchedLine: "RAW_MATCHED_LINE_MUST_NOT_RENDER",
        rateLimit: {
          runtime: "RAW_THROTTLE_RUNTIME_MUST_NOT_RENDER",
          scope: "RAW_THROTTLE_SCOPE_MUST_NOT_RENDER",
          resetAt: 1783634400000,
          message: "RAW_THROTTLE_LINE_MUST_NOT_RENDER",
        },
      },
      model: { state: "available", value: "RAW_MODEL_VALUE_MUST_NOT_RENDER", source: "command" },
      contextPressure: { state: "unavailable", reason: "RAW_CONTEXT_REASON_MUST_NOT_RENDER" },
      resume: { state: "resumable", reason: "RAW_SESSION_ID_MUST_NOT_RENDER" },
      bridge: { currentGeneration: 8, boundGeneration: 7, wired: true, clientState: "suspect" },
    },
    {
      workspaceKey: "ops01", workspaceLabel: "runtime-ops", agentName: "known-throttle", runtime: "codex",
      lastActivity: "2026-07-09T20:59:30.000Z", status: "running",
      attention: { state: "throttled", stale: false, rateLimit: { runtime: "codex", scope: "5h", resetAt: 1783634400000 } },
      model: { state: "unavailable", reason: "RAW_MODEL_REASON_MUST_NOT_RENDER" },
      resume: { state: "resumable" },
      bridge: { currentGeneration: 8, boundGeneration: 7, wired: true, clientState: "suspect" },
    },
  ],
});

const staleBridge = buildRuntimeOpsSnapshot({
  generatedAt: "2026-07-09T21:00:00.000Z",
  detectedRuntimes: ["claude"],
  agents: [{
    workspaceKey: "bridge01", workspaceLabel: "bridge-check", agentName: "rebound-agent", runtime: "claude",
    lastActivity: "2026-07-09T20:55:00.000Z", status: "running", attention: { state: "working", stale: false },
    model: { state: "available", value: "Opus 4.8", source: "runtime-profile" },
    resume: { state: "live", reason: "Agent process is currently live." },
    bridge: { currentGeneration: 12, boundGeneration: 11, wired: true },
  }],
});

const longLabel = buildRuntimeOpsSnapshot({
  generatedAt: "2026-07-09T21:00:00.000Z",
  detectedRuntimes: ["claude"],
  agents: [{
    workspaceKey: "long01", workspaceLabel: "frontend-platform-observability-and-release-engineering", agentName: "migration-coordinator-with-a-deliberately-long-operational-label", runtime: "claude",
    lastActivity: "2026-07-09T20:55:00.000Z", status: "stopping", attention: { state: "needs-input", stale: true },
    model: { state: "available", value: "Claude default", source: "runtime-profile" },
    resume: { state: "fresh-start-only", reason: "The saved transcript is unavailable." },
    bridge: { currentGeneration: 3, boundGeneration: 3, wired: true, clientState: "ok" },
  }],
});

const duplicateWorkspace = buildRuntimeOpsSnapshot({
  generatedAt: "2026-07-09T21:00:00.000Z",
  detectedRuntimes: ["codex"],
  agents: [
    {
      workspaceKey: "apps-api", workspaceLabel: "apps/api", agentName: "review", runtime: "codex",
      lastActivity: "2026-07-09T20:56:00.000Z", status: "running", attention: { state: "idle", stale: false },
      model: { state: "available", value: "GPT-5.1 Codex", source: "command" }, resume: { state: "live", reason: "Agent process is currently live." },
      bridge: { currentGeneration: 2, boundGeneration: 2, wired: true, clientState: "ok" },
    },
    {
      workspaceKey: "tools-api", workspaceLabel: "tools/api", agentName: "review", runtime: "codex",
      lastActivity: "2026-07-09T20:57:00.000Z", status: "stopped", attention: { state: "unknown", stale: false },
      model: { state: "unavailable", reason: "No model was recorded." }, resume: { state: "resumable", reason: "A resumable session is recorded." },
      bridge: { currentGeneration: 2, boundGeneration: 2, wired: false },
    },
  ],
});

function withProviderState(input: unknown): RuntimeOpsSnapshotV2 {
  return {
    ...nativeMixed,
    providerCapacity: projectRuntimeOpsProviderCapacity(input, nativeMixed.generatedAt),
  };
}

function providerObservationState(
  observations: Partial<Record<RuntimeObservabilityProviderV1, CollectorEnvelopeV1>>,
  enabled: readonly RuntimeObservabilityProviderV1[] = ["codex", "claude"],
): {
  preferences: Partial<Record<RuntimeObservabilityProviderV1, ProviderObservationPreferenceV1>>;
  observations: Partial<Record<RuntimeObservabilityProviderV1, CollectorEnvelopeV1>>;
} {
  return {
    preferences: Object.fromEntries(enabled.map((provider) => [provider, preference(provider)])),
    observations,
  };
}

function preference(provider: RuntimeObservabilityProviderV1): ProviderObservationPreferenceV1 {
  return {
    scope: {
      kind: "provider-account",
      provider,
      key: provider === "codex" ? "ps_1111111111111111" : "ps_2222222222222222",
    },
    sources: ["cli"],
  };
}

function quotaEnvelope(
  provider: RuntimeObservabilityProviderV1,
  windows: ProviderQuotaWindowV1[],
  confidence: ObservationConfidenceV1 = "exact",
  freshness: ObservationFreshnessV1 = { state: "fresh" },
): CollectorEnvelopeV1 {
  return {
    schemaVersion: 1,
    collector: { id: `tachyon-${provider}-fixture`, version: "1.0.0" },
    generatedAt: "2026-07-09T21:00:00.000Z",
    facts: [{
      kind: "provider-quota",
      scope: preference(provider).scope,
      source: "cli",
      confidence,
      observedAt: "2026-07-09T20:59:00.000Z",
      freshness,
      windows,
    }],
    diagnostics: [],
  };
}

function unavailableEnvelope(
  provider: RuntimeObservabilityProviderV1,
  reason: ProviderUnavailableReasonV1,
  lastGoodAt?: string,
): CollectorEnvelopeV1 {
  return {
    schemaVersion: 1,
    collector: { id: `tachyon-${provider}-fixture`, version: "1.0.0" },
    generatedAt: "2026-07-09T21:00:00.000Z",
    facts: [{
      kind: "provider-unavailable",
      scope: preference(provider).scope,
      source: "cli",
      observedAt: "2026-07-09T20:59:00.000Z",
      reason,
      ...(lastGoodAt ? { lastGoodAt } : {}),
    }],
    diagnostics: [],
  };
}

function staleEnvelope(
  provider: RuntimeObservabilityProviderV1,
  windows: ProviderQuotaWindowV1[],
): CollectorEnvelopeV1 {
  const lastGoodAt = "2026-07-09T20:45:00.000Z";
  const envelope = quotaEnvelope(provider, windows, "exact", { state: "stale", lastGoodAt });
  envelope.facts.push({
    kind: "provider-unavailable",
    scope: preference(provider).scope,
    source: "cli",
    observedAt: "2026-07-09T21:00:00.000Z",
    reason: "timeout",
    lastGoodAt,
  });
  return envelope;
}

export const runtimeOpsFixtures: Record<string, Fixture<RuntimeOpsPreviewState>> = {
  default: snapshotFixture(mixed),
  loading: { provenance: "synthetic-edge", vm: { state: "loading" } },
  empty: snapshotFixture(emptyRuntimeOpsSnapshot(new Date("2026-07-09T21:00:00.000Z"))),
  error: snapshotFixture(unavailableRuntimeOpsSnapshot(new Date("2026-07-09T21:00:00.000Z"))),
  mixed: snapshotFixture(mixed),
  throttled: snapshotFixture(throttled),
  "stale-bridge": snapshotFixture(staleBridge),
  "long-label": snapshotFixture(longLabel),
  "duplicate-workspace": snapshotFixture(duplicateWorkspace),
  "provider-healthy": snapshotFixture(providerHealthy),
  "provider-exhausted": snapshotFixture(providerExhausted),
  "provider-partial": snapshotFixture(providerPartial),
  "provider-unauthenticated": snapshotFixture(providerUnauthenticated),
  "provider-stale": snapshotFixture(providerStale),
  "provider-timeout": snapshotFixture(providerTimeout),
  "provider-invalid": snapshotFixture(providerInvalid),
  "provider-disabled": snapshotFixture(providerDisabled),
};
