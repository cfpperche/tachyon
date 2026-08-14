import type { RuntimeOpsProviderV2, RuntimeOpsSnapshotV2 } from "@tachyon/engine/runtimeOps/types.js";
export type { RuntimeOpsSummaryV1, RuntimeOpsSource, RuntimeOpsValue, RuntimeOpsThrottleRuntime, RuntimeOpsThrottleScope, RuntimeOpsRateLimitV1, RuntimeOpsModelLabel, RuntimeOpsModelV1, RuntimeOpsObservedModelV1, RuntimeOpsContextPressureV1, RuntimeOpsUsageV1, RuntimeOpsWorkspaceV1, RuntimeOpsAgentRefV1, RuntimeOpsVersionParityV1, RuntimeOpsRuntimeV1, RuntimeOpsProviderV2, RuntimeOpsProviderSourceV2, RuntimeOpsProviderConfidenceV2, RuntimeOpsProviderQuotaWindowV2, RuntimeOpsProviderFreshnessV2, RuntimeOpsProviderUnavailableReasonV2, RuntimeOpsProviderQuotaV2, RuntimeOpsProviderCapacityV2, RuntimeOpsSnapshotV1, RuntimeOpsSnapshotV2, RuntimeOpsSnapshot, RuntimeOpsSnapshotErrorV1 } from "@tachyon/engine/runtimeOps/types.js";
export function emptyRuntimeOpsSnapshot(now = new Date()): RuntimeOpsSnapshotV2 {
  const observedAt = now.toISOString();
  return {
    schemaVersion: 2,
    generatedAt: observedAt,
    summary: { runtimes: 0, managedAgents: 0 },
    runtimes: [],
    providerCapacity: ["codex", "claude"].map((provider) => ({
      provider: provider as RuntimeOpsProviderV2,
      scope: "provider-account" as const,
      configuration: { state: "disabled" as const },
      quota: { state: "unavailable" as const, observedAt, reason: "source-disabled" as const },
    })),
  };
}

export function unavailableRuntimeOpsSnapshot(now = new Date()): RuntimeOpsSnapshotV2 {
  return {
    ...emptyRuntimeOpsSnapshot(now),
    error: { code: "snapshot-unavailable" },
  };
}
