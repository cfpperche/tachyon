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

/**
 * t-458497 — HOW a source acquires the number, declared by the source that acquires it.
 *
 * `ProviderSourceKindV1` cannot answer this: both shipped sources are `cli`, yet one asks the runtime
 * a machine question about its own limits and the other reads a number back off a surface the runtime
 * drew for a human. That difference is the whole reason a Claude quota must be labelled best-effort
 * and a Codex quota must not, so it is declared here — beside the code that does the acquiring —
 * rather than in a table of runtime names somewhere else that would have to be kept in step.
 *
 *  - `control-plane` — the runtime answered a request FOR its limits (a documented machine protocol).
 *  - `rendered-surface` — the number was parsed out of output shaped for a reader, so a layout change
 *    can silently take it away; consumers must present it as best-effort.
 */
export interface ProviderQuotaChannelV1 {
  readonly acquisition: "control-plane" | "rendered-surface";
  /** The exact mechanism, so a reader can check the classification instead of trusting the word. */
  readonly mechanism: string;
}

/** Narrow read-only source contract. It is not a generic CLI, HTTP, file, or plugin execution seam. */
export interface ProviderObservationSource {
  readonly provider: RuntimeObservabilityProviderV1;
  readonly source: ProviderSourceKindV1;
  /** t-458497 — self-declared acquisition kind; the ONLY place a channel's fragility is authored. */
  readonly channel: ProviderQuotaChannelV1;
  observe(request: ProviderObservationRequestV1): Promise<CollectorEnvelopeV1>;
}
