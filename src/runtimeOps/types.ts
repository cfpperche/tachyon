export interface RuntimeOpsSummaryV1 {
  runtimes: number;
  activeAgents: number;
  throttled: number;
  bridgeIssues: number;
}

/**
 * Versioned, allowlisted host-to-webview contract for Runtime Ops.
 * Phase 1 intentionally publishes no runtime rows; later phases extend the row union without exposing raw logs.
 */
export interface RuntimeOpsSnapshotV1 {
  schemaVersion: 1;
  generatedAt: string;
  summary: RuntimeOpsSummaryV1;
  runtimes: readonly [];
}

export function emptyRuntimeOpsSnapshot(now = new Date()): RuntimeOpsSnapshotV1 {
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    summary: { runtimes: 0, activeAgents: 0, throttled: 0, bridgeIssues: 0 },
    runtimes: [],
  };
}
