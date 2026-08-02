export const RUNTIME_OBSERVABILITY_SCHEMA_VERSION = 1 as const;

export type RuntimeObservabilityProviderV1 = "codex" | "claude" | "grok";
export type ProviderSourceKindV1 = "oauth" | "cli";
export type ObservationConfidenceV1 = "exact" | "estimated" | "unknown";

export interface AgentObservationScopeV1 {
  kind: "agent";
  workspaceKey: string;
  agentKey: string;
}

export interface ProviderObservationScopeV1 {
  kind: "provider";
  provider: RuntimeObservabilityProviderV1;
}

export interface ProviderAccountObservationScopeV1 {
  kind: "provider-account";
  provider: RuntimeObservabilityProviderV1;
  /** Opaque Tachyon-owned digest key. Never an email, username, organization id, or provider account id. */
  key: string;
}

export type ObservationFreshnessV1 =
  | { state: "fresh" }
  | { state: "stale"; lastGoodAt: string };

export interface NativeUsageFactV1 {
  kind: "native-usage";
  scope: AgentObservationScopeV1;
  runtime: string;
  source: "activity-log";
  observedAt: string;
  semantics: "latest-cumulative" | "summed-deltas";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ProviderQuotaWindowV1 {
  name: "session" | "weekly" | "tertiary";
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
}

export interface ProviderQuotaFactV1 {
  kind: "provider-quota";
  scope: ProviderAccountObservationScopeV1;
  source: ProviderSourceKindV1;
  confidence: ObservationConfidenceV1;
  observedAt: string;
  freshness: ObservationFreshnessV1;
  windows: ProviderQuotaWindowV1[];
}

/**
 * Shape reserved for a separately consented future schema. It is deliberately not a member of
 * `RuntimeObservationFactV1`, so the quota-only V1 envelope cannot produce or consume cost facts.
 */
export interface ProviderCostFactV1 {
  kind: "provider-cost";
  scope: ProviderAccountObservationScopeV1;
  source: "local-history";
  confidence: ObservationConfidenceV1;
  observedAt: string;
  freshness: ObservationFreshnessV1;
  currency: "USD";
  amountMicros: number;
  period: {
    startAt: string;
    endAt: string;
  };
}

/**
 * Grok (and any runtime without a remaining-quota channel) must declare that absence by name.
 * Never fill a `provider-quota` fact with zeros or invent headroom from session token spend.
 */
export type ConfigurationQuotaChannelV1 =
  | { state: "unsupported"; reason: "no-quota-channel" };

export interface ProviderConfigurationCompatCellV1 {
  vendor: string;
  surface: string;
  enabled: boolean;
  source: string;
}

/**
 * Allowlisted projection of `grok inspect --json` (and peer configuration inspectors). Paths, headers,
 * tokens, session ids, and credential material never belong here — only structure a host can safely show.
 */
export interface ProviderConfigurationFactV1 {
  kind: "provider-configuration";
  scope: AgentObservationScopeV1;
  runtime: "grok";
  source: ProviderSourceKindV1;
  confidence: ObservationConfidenceV1;
  observedAt: string;
  freshness: ObservationFreshnessV1;
  /** Named refusal of the quota axis — configuration is observable; remaining capacity is not. */
  quotaChannel: ConfigurationQuotaChannelV1;
  grokVersion?: string;
  projectTrusted?: boolean;
  permissionsLoaded?: number;
  /** Layer roles only (`user` / `project` / …). Never absolute filesystem paths. */
  configLayerRoles: string[];
  /** MCP server names only — no targets, headers, or env. */
  mcpServerNames: string[];
  externalCompat: ProviderConfigurationCompatCellV1[];
}

export type ProviderUnavailableReasonV1 =
  | "unsupported"
  | "source-disabled"
  | "unauthenticated"
  | "timeout"
  | "cancelled"
  | "not-observed"
  | "provider-error"
  | "invalid-payload"
  | "stale-expired";

export interface ProviderUnavailableFactV1 {
  kind: "provider-unavailable";
  scope: ProviderObservationScopeV1 | ProviderAccountObservationScopeV1;
  source?: ProviderSourceKindV1;
  observedAt: string;
  reason: ProviderUnavailableReasonV1;
  lastGoodAt?: string;
}

export type RuntimeObservationFactV1 =
  | NativeUsageFactV1
  | ProviderQuotaFactV1
  | ProviderConfigurationFactV1
  | ProviderUnavailableFactV1;

export type CollectorDiagnosticCodeV1 =
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_TIMEOUT"
  | "SOURCE_CANCELLED"
  | "INVALID_PAYLOAD"
  | "STALE_LAST_GOOD";

export interface CollectorDiagnosticV1 {
  code: CollectorDiagnosticCodeV1;
  provider?: RuntimeObservabilityProviderV1;
  factIndex?: number;
}

export interface CollectorIdentityV1 {
  id: string;
  version: string;
}

/** Provider-neutral host contract. It is intentionally not a CodexBar UsageSnapshot or CLI payload. */
export interface CollectorEnvelopeV1 {
  schemaVersion: typeof RUNTIME_OBSERVABILITY_SCHEMA_VERSION;
  collector: CollectorIdentityV1;
  generatedAt: string;
  facts: RuntimeObservationFactV1[];
  diagnostics: CollectorDiagnosticV1[];
}
