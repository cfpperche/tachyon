export interface RuntimeOpsSummaryV1 {
  runtimes: number;
  managedAgents: number;
  activeAgents?: number;
  throttled?: number;
  bridgeIssues?: number;
}

export type RuntimeOpsSource = "path" | "session-ledger" | "activity-log" | "command" | "runtime-profile";

export type RuntimeOpsValue<T> =
  | { state: "available"; value: T; source: RuntimeOpsSource; observedAt?: string }
  | { state: "unavailable"; reason: string };

export interface RuntimeOpsUsageV1 {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  semantics: "latest-cumulative" | "summed-deltas";
}

export interface RuntimeOpsWorkspaceV1 {
  key: string;
  label: string;
}

export interface RuntimeOpsAgentRefV1 {
  key: string;
  name: string;
  workspaceKey: string;
  status: "running" | "stopping" | "stop-failed" | "stopped" | "crashed";
  attention: {
    state: "working" | "idle" | "needs-input" | "throttled" | "unknown";
    stale: boolean;
    rateLimit?: { runtime?: string; scope?: string; resetAt?: number; message: string };
  };
  model: RuntimeOpsValue<string>;
  resume: {
    state: "live" | "resumable" | "fresh-start-only" | "not-resumable";
    reason: string;
  };
  bridge: {
    state: "ok" | "suspect" | "rebinding" | "failed" | "not-wired" | "unknown";
    reason: string;
    currentGeneration?: number;
    boundGeneration?: number;
  };
  contextPressure: RuntimeOpsValue<{ used: number; limit: number }>;
}

export interface RuntimeOpsRuntimeV1 {
  key: string;
  runtime: string;
  label: string;
  availability: {
    pathDetected: boolean;
    managed: boolean;
    detail: string;
  };
  usage: RuntimeOpsValue<RuntimeOpsUsageV1>;
  lastActivity: RuntimeOpsValue<string>;
  version: RuntimeOpsValue<string>;
  workspaces: RuntimeOpsWorkspaceV1[];
  agents: RuntimeOpsAgentRefV1[];
}

/**
 * Versioned, allowlisted host-to-webview contract for Runtime Ops.
 * Phase 1 intentionally publishes no runtime rows; later phases extend the row union without exposing raw logs.
 */
export interface RuntimeOpsSnapshotV1 {
  schemaVersion: 1;
  generatedAt: string;
  summary: RuntimeOpsSummaryV1;
  runtimes: RuntimeOpsRuntimeV1[];
  /**
   * An allowlisted host failure marker. Its fixed UI copy is owned by the webview,
   * so host exceptions and source data never cross the webview boundary.
   */
  error?: RuntimeOpsSnapshotErrorV1;
}

export interface RuntimeOpsSnapshotErrorV1 {
  code: "snapshot-unavailable";
}

export function emptyRuntimeOpsSnapshot(now = new Date()): RuntimeOpsSnapshotV1 {
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    summary: { runtimes: 0, managedAgents: 0 },
    runtimes: [],
  };
}

export function unavailableRuntimeOpsSnapshot(now = new Date()): RuntimeOpsSnapshotV1 {
  return {
    ...emptyRuntimeOpsSnapshot(now),
    error: { code: "snapshot-unavailable" },
  };
}
