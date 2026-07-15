import type { ProviderObservationPreferenceV1 } from "../runtimeObservability/preferences.js";
import type {
  CollectorEnvelopeV1,
  ProviderSourceKindV1,
  RuntimeObservabilityProviderV1,
} from "../runtimeObservability/types.js";
import { validateCollectorEnvelopeV1 } from "../runtimeObservability/validate.js";
import type {
  RuntimeOpsProviderCapacityV2,
  RuntimeOpsProviderQuotaV2,
  RuntimeOpsProviderUnavailableReasonV2,
  RuntimeOpsProviderV2,
} from "./types.js";

const PROVIDERS = ["codex", "claude"] as const satisfies readonly RuntimeOpsProviderV2[];
const SOURCES = ["cli", "oauth"] as const satisfies readonly ProviderSourceKindV1[];
const SAFE_SCOPE_KEY = /^ps_[0-9a-f]{16,64}$/u;

export interface RuntimeOpsProviderObservationSnapshotInput {
  preferences: Partial<Record<RuntimeObservabilityProviderV1, ProviderObservationPreferenceV1>>;
  observations: Partial<Record<RuntimeObservabilityProviderV1, CollectorEnvelopeV1>>;
}

interface ProjectedPreference {
  scopeKey: string;
  sources: ProviderSourceKindV1[];
}

/**
 * Reprojects the cached provider service state into the smaller webview contract. The host-only opaque scope key,
 * collector identity, diagnostics and every unknown/raw field are intentionally discarded.
 */
export function projectRuntimeOpsProviderCapacity(
  input: unknown,
  generatedAt: string,
): RuntimeOpsProviderCapacityV2[] {
  const observedAt = timestamp(generatedAt) ?? new Date(0).toISOString();
  const root = record(input);
  const preferences = record(root?.preferences);
  const observations = record(root?.observations);

  return PROVIDERS.map((provider) => {
    const preference = projectPreference(preferences?.[provider], provider);
    if (!preference) return disabledCapacity(provider, observedAt);
    return {
      provider,
      scope: "provider-account",
      configuration: { state: "enabled", sources: preference.sources },
      quota: projectQuota(observations?.[provider], provider, preference, observedAt),
    };
  });
}

function disabledCapacity(provider: RuntimeOpsProviderV2, observedAt: string): RuntimeOpsProviderCapacityV2 {
  return {
    provider,
    scope: "provider-account",
    configuration: { state: "disabled" },
    quota: { state: "unavailable", observedAt, reason: "source-disabled" },
  };
}

function projectPreference(raw: unknown, provider: RuntimeOpsProviderV2): ProjectedPreference | undefined {
  const value = record(raw);
  const scope = record(value?.scope);
  if (scope?.kind !== "provider-account"
    || scope.provider !== provider
    || typeof scope.key !== "string"
    || !SAFE_SCOPE_KEY.test(scope.key)
    || !Array.isArray(value?.sources)
    || value.sources.length < 1
    || value.sources.length > SOURCES.length) {
    return undefined;
  }
  const sources: ProviderSourceKindV1[] = [];
  for (const source of value.sources) {
    if (!isSource(source) || sources.includes(source)) return undefined;
    sources.push(source);
  }
  // The preference store owns cheapest-first ordering; a broader source cannot jump ahead of CLI.
  if (sources.includes("cli") && sources[0] !== "cli") return undefined;
  return { scopeKey: scope.key, sources };
}

function projectQuota(
  rawEnvelope: unknown,
  provider: RuntimeOpsProviderV2,
  preference: ProjectedPreference,
  fallbackObservedAt: string,
): RuntimeOpsProviderQuotaV2 {
  const validated = validateCollectorEnvelopeV1(rawEnvelope);
  if (!validated.ok) return invalidQuota(fallbackObservedAt, preference.sources[0]);

  const facts = validated.value.facts;
  if (facts.length < 1 || facts.length > 2 || facts.some((fact) =>
    (fact.kind !== "provider-quota" && fact.kind !== "provider-unavailable")
    || fact.scope.kind !== "provider-account"
    || fact.scope.provider !== provider
    || fact.scope.key !== preference.scopeKey)) {
    return invalidQuota(fallbackObservedAt, preference.sources[0]);
  }

  const quotaFacts = facts.filter((fact) => fact.kind === "provider-quota");
  const unavailableFacts = facts.filter((fact) => fact.kind === "provider-unavailable");
  if (quotaFacts.length === 1) {
    const quota = quotaFacts[0];
    const companion = unavailableFacts[0];
    if (unavailableFacts.length > 1
      || !preference.sources.includes(quota.source)
      || (companion !== undefined && (
        quota.freshness.state !== "stale"
        || companion.lastGoodAt !== quota.freshness.lastGoodAt
        || companion.reason === "source-disabled"
        || companion.reason === "stale-expired"
        || (companion.source !== undefined && !preference.sources.includes(companion.source))
      ))) {
      return invalidQuota(quota.observedAt, preference.sources[0]);
    }
    return {
      state: "available",
      source: quota.source,
      confidence: quota.confidence,
      observedAt: quota.observedAt,
      freshness: quota.freshness.state === "fresh"
        ? { state: "fresh" }
        : { state: "stale", lastGoodAt: quota.freshness.lastGoodAt },
      windows: [...quota.windows]
        .sort((left, right) => windowOrder(left.name) - windowOrder(right.name))
        .map((window) => ({
          name: window.name,
          usedPercent: window.usedPercent,
          ...(window.windowMinutes !== undefined ? { windowMinutes: window.windowMinutes } : {}),
          ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
        })),
    };
  }

  const unavailable = unavailableFacts[0];
  if (quotaFacts.length !== 0 || unavailableFacts.length !== 1 || unavailable === undefined) {
    return invalidQuota(fallbackObservedAt, preference.sources[0]);
  }
  if (unavailable.source !== undefined && !preference.sources.includes(unavailable.source)) {
    return invalidQuota(unavailable.observedAt, preference.sources[0]);
  }
  return {
    state: "unavailable",
    ...(unavailable.source !== undefined ? { source: unavailable.source } : {}),
    observedAt: unavailable.observedAt,
    reason: unavailable.reason,
    ...(unavailable.lastGoodAt !== undefined ? { lastGoodAt: unavailable.lastGoodAt } : {}),
  };
}

function invalidQuota(
  observedAt: string,
  source: ProviderSourceKindV1 | undefined,
): RuntimeOpsProviderQuotaV2 {
  return {
    state: "unavailable",
    ...(source ? { source } : {}),
    observedAt,
    reason: "invalid-payload" satisfies RuntimeOpsProviderUnavailableReasonV2,
  };
}

function windowOrder(name: "session" | "weekly" | "tertiary"): number {
  if (name === "session") return 0;
  if (name === "weekly") return 1;
  return 2;
}

function isSource(value: unknown): value is ProviderSourceKindV1 {
  return value === "cli" || value === "oauth";
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
