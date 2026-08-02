import type {
  AgentObservationScopeV1,
  CollectorEnvelopeV1,
  ProviderAccountObservationScopeV1,
  ProviderSourceKindV1,
  RuntimeObservabilityProviderV1,
} from "./types.js";

export const PROVIDER_QUOTA_READ_CAPABILITY = "provider-quota-read" as const;
export const PROVIDER_CONFIGURATION_READ_CAPABILITY = "provider-configuration-read" as const;

/**
 * A grant is deliberately explicit and source-bound. The host may construct `granted` only from a persisted,
 * user-controlled selection; adapters never infer consent from installed CLIs, credentials, or ambient files.
 */
export type ProviderObservationGrantV1 =
  | { state: "disabled" }
  | {
      state: "granted";
      capability: typeof PROVIDER_QUOTA_READ_CAPABILITY;
      source: ProviderSourceKindV1;
      consent: "explicit-user";
    };

export type ConfigurationObservationGrantV1 =
  | { state: "disabled" }
  | {
      state: "granted";
      capability: typeof PROVIDER_CONFIGURATION_READ_CAPABILITY;
      source: ProviderSourceKindV1;
      consent: "explicit-user";
    };

export interface ProviderObservationRequestV1 {
  /** Tachyon-owned opaque key supplied by the host. An adapter must not derive it from provider identity. */
  scope: ProviderAccountObservationScopeV1;
  grant: ProviderObservationGrantV1;
  signal?: AbortSignal;
}

/**
 * Configuration observation is agent-scoped: private homes (e.g. GROK_HOME) differ per agent, so a
 * provider-account grant alone cannot select the home that must be inspected.
 */
export interface ConfigurationObservationRequestV1 {
  scope: AgentObservationScopeV1;
  /** Absolute path of the observed agent's private runtime home (GROK_HOME). Never the workspace ambient home. */
  grokHome: string;
  /** Working directory for project-layer discovery. When omitted the child inherits the adapter process cwd. */
  cwd?: string;
  /**
   * When true (default), co-bind `HOME` to `grokHome` so inspect cannot read ambient `$HOME/.claude` /
   * `$HOME/.grok` layers that do not belong to the observed agent.
   */
  coBindHome?: boolean;
  grant: ConfigurationObservationGrantV1;
  signal?: AbortSignal;
}

/** Narrow read-only source contract. It is not a generic CLI, HTTP, file, or plugin execution seam. */
export interface ProviderObservationSource {
  readonly provider: RuntimeObservabilityProviderV1;
  readonly source: ProviderSourceKindV1;
  observe(request: ProviderObservationRequestV1): Promise<CollectorEnvelopeV1>;
}

/** Configuration-axis source. Must never emit `provider-quota` facts; quota absence is declared by name. */
export interface ConfigurationObservationSource {
  readonly runtime: "grok";
  readonly source: ProviderSourceKindV1;
  observe(request: ConfigurationObservationRequestV1): Promise<CollectorEnvelopeV1>;
}
