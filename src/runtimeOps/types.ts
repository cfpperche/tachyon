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
  | { state: "unavailable" };

/**
 * The webview protocol intentionally has a smaller vocabulary than the host's
 * parsed rate-limit metadata. Keep these values closed so terminal-derived
 * strings cannot become renderable protocol data.
 */
export type RuntimeOpsThrottleRuntime = "claude" | "codex" | "opencode";
export type RuntimeOpsThrottleScope = "5h" | "weekly";

export interface RuntimeOpsRateLimitV1 {
  runtime?: RuntimeOpsThrottleRuntime;
  scope?: RuntimeOpsThrottleScope;
  resetAt?: number;
}

export type RuntimeOpsModelLabel =
  | "Claude default"
  | "Opus"
  | "Opus 4.8"
  | "Sonnet"
  | "Sonnet 5"
  | "Haiku"
  | "Codex default"
  | "GPT-5.1 Codex"
  | "GPT-5 Codex"
  | "Grok default";

export type RuntimeOpsModelV1 =
  | { state: "available"; value: RuntimeOpsModelLabel; source: "command" | "runtime-profile" }
  | { state: "unavailable" };

export type RuntimeOpsContextPressureV1 =
  | { state: "available"; value: { used: number; limit: number } }
  | { state: "unavailable" };

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
    rateLimit?: RuntimeOpsRateLimitV1;
  };
  model: RuntimeOpsModelV1;
  resume: {
    state: "live" | "resumable" | "fresh-start-only" | "not-resumable";
  };
  bridge: {
    state: "ok" | "suspect" | "rebinding" | "failed" | "not-wired" | "unknown";
    currentGeneration?: number;
    boundGeneration?: number;
  };
  contextPressure: RuntimeOpsContextPressureV1;
}

export interface RuntimeOpsRuntimeV1 {
  key: string;
  runtime: string;
  label: string;
  availability: {
    pathDetected: boolean;
    managed: boolean;
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
