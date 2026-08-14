export interface RuntimeOpsSummaryV1 {
  runtimes: number;
  managedAgents: number;
  activeAgents?: number;
  throttled?: number;
  bridgeIssues?: number;
  /** t-019dac — host MemAvailable/total (MiB) when /proc/meminfo is readable. */
  hostMemAvailableMb?: number;
  hostMemTotalMb?: number;
  /**
   * Suggested vitest maxWorkers a NEW run would receive right now (t-7f9809).
   * Host-wide budget with live siblings discounted — not alone-process sizing.
   * 0 when the budget is spent (a real admit would refuse).
   */
  recommendedVitestWorkers?: number;
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


/**
 * spec 378 — the transcript-OBSERVED model fact, projected alongside (never replacing) the declared/profile
 * `RuntimeOpsModelV1` above. Deliberately NOT the closed `RuntimeOpsModelLabel` union: an observed id comes
 * from the runtime's own transcript store (not pane text), so an id missing from the alias table renders as
 * a validated raw/title-cased string rather than collapsing to "Unavailable" (open-fallback label policy —
 * the closed-enum invariant stays for `RuntimeOpsModelV1`'s declared/profile defaults).
 */
export type RuntimeOpsObservedModelV1 =
  | { state: "available"; value: string; effort?: string; observedAt?: string; stale?: boolean }
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
  /** spec 378 — the observed model + divergence-vs-declared fact, exposed for agent consumers (the RuntimeOps
   *  panel's model COLUMN stays declared-only this spec — a stated follow-up). */
  modelObserved: RuntimeOpsObservedModelV1;
  modelDivergence: boolean;
  resume: {
    state: "live" | "resumable" | "fresh-start-only" | "not-resumable";
  };
  bridge: {
    state: "ok" | "suspect" | "rebinding" | "failed" | "not-wired" | "unknown";
    currentGeneration?: number;
    boundGeneration?: number;
  };
  contextPressure: RuntimeOpsContextPressureV1;
  /** t-e3bae0 — optional pane-tree sample (Linux). */
  resources?: { cpuPct?: number; memMb: number };
}


/**
 * t-1322b5 — product measured CLI version vs PATH `--version` for this host.
 * Absent when the product has no measured baseline for the runtime.
 * Display only: never blocks spawn, gates, or ports.
 */
export type RuntimeOpsVersionParityV1 =
  | { state: "match"; measured: string; running: string }
  | { state: "drift"; measured: string; running: string }
  | { state: "unknown-running"; measured: string };


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
  /** Measured-vs-running compare when the product owns a baseline for this runtime. */
  versionParity?: RuntimeOpsVersionParityV1;
  workspaces: RuntimeOpsWorkspaceV1[];
  agents: RuntimeOpsAgentRefV1[];
}


export type RuntimeOpsProviderV2 = "codex" | "claude";

export type RuntimeOpsProviderSourceV2 = "cli" | "oauth";

export type RuntimeOpsProviderConfidenceV2 = "exact" | "estimated" | "unknown";


export interface RuntimeOpsProviderQuotaWindowV2 {
  name: "session" | "weekly" | "tertiary";
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
}


export type RuntimeOpsProviderFreshnessV2 =
  | { state: "fresh" }
  | { state: "stale"; lastGoodAt: string };


export type RuntimeOpsProviderUnavailableReasonV2 =
  | "unsupported"
  | "source-disabled"
  | "unauthenticated"
  | "timeout"
  | "cancelled"
  | "not-observed"
  | "provider-error"
  | "invalid-payload"
  | "stale-expired";


export type RuntimeOpsProviderQuotaV2 =
  | {
      state: "available";
      source: RuntimeOpsProviderSourceV2;
      confidence: RuntimeOpsProviderConfidenceV2;
      observedAt: string;
      freshness: RuntimeOpsProviderFreshnessV2;
      windows: RuntimeOpsProviderQuotaWindowV2[];
    }
  | {
      state: "unavailable";
      source?: RuntimeOpsProviderSourceV2;
      observedAt: string;
      reason: RuntimeOpsProviderUnavailableReasonV2;
      lastGoodAt?: string;
    };


/**
 * Provider quota is account-wide and deliberately has no agent/workspace key. The opaque host account-scope key
 * also stays host-side: the webview only needs the fixed scope class to avoid false per-agent attribution.
 */
export interface RuntimeOpsProviderCapacityV2 {
  provider: RuntimeOpsProviderV2;
  scope: "provider-account";
  configuration:
    | { state: "disabled" }
    | { state: "enabled"; sources: RuntimeOpsProviderSourceV2[] };
  quota: RuntimeOpsProviderQuotaV2;
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


/**
 * Schema V2 adds a bounded account-capacity lane while retaining V1 runtime rows unchanged. Consumers accept V1 so
 * an already-mounted webview can degrade to native-only data during an extension-host/webview version transition.
 */
export interface RuntimeOpsSnapshotV2 {
  schemaVersion: 2;
  generatedAt: string;
  summary: RuntimeOpsSummaryV1;
  runtimes: RuntimeOpsRuntimeV1[];
  providerCapacity: RuntimeOpsProviderCapacityV2[];
  error?: RuntimeOpsSnapshotErrorV1;
}


export type RuntimeOpsSnapshot = RuntimeOpsSnapshotV1 | RuntimeOpsSnapshotV2;


export interface RuntimeOpsSnapshotErrorV1 {
  code: "snapshot-unavailable";
}
