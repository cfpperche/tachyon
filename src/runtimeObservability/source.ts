import type {
  CollectorEnvelopeV1,
  ProviderAccountObservationScopeV1,
  ProviderSourceKindV1,
  RuntimeObservabilityProviderV1,
} from "./types.js";

export const PROVIDER_QUOTA_READ_CAPABILITY = "provider-quota-read" as const;

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

export interface ProviderObservationRequestV1 {
  /** Tachyon-owned opaque key supplied by the host. An adapter must not derive it from provider identity. */
  scope: ProviderAccountObservationScopeV1;
  grant: ProviderObservationGrantV1;
  signal?: AbortSignal;
}

/** Narrow read-only source contract. It is not a generic CLI, HTTP, file, or plugin execution seam. */
export interface ProviderObservationSource {
  readonly provider: RuntimeObservabilityProviderV1;
  readonly source: ProviderSourceKindV1;
  observe(request: ProviderObservationRequestV1): Promise<CollectorEnvelopeV1>;
}
