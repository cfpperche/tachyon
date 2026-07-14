import type {
  CollectorDiagnosticCodeV1,
  CollectorEnvelopeV1,
  ProviderAccountObservationScopeV1,
  ProviderObservationScopeV1,
  ProviderQuotaFactV1,
  ProviderSourceKindV1,
  ProviderUnavailableReasonV1,
  RuntimeObservabilityProviderV1,
} from "./types.js";
import {
  PROVIDER_QUOTA_READ_CAPABILITY,
  type ProviderObservationSource,
} from "./source.js";
import {
  ProviderObservationPreferences,
  type ProviderObservationPreferenceInputV1,
  type ProviderObservationPreferenceV1,
  type ProviderObservationStatePort,
} from "./preferences.js";
import { validateCollectorEnvelopeV1 } from "./validate.js";

export const PROVIDER_OBSERVATION_LAST_GOOD_STATE_KEY = "tachyon.runtimeObservability.lastGood.v1";

const PROVIDERS = ["codex", "claude"] as const satisfies readonly RuntimeObservabilityProviderV1[];
const HOST_COLLECTOR = { id: "tachyon-provider-host", version: "1.0.0" } as const;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_COLLECTION_TIMEOUT_MS = 20_000;
const DEFAULT_STALE_AFTER_MS = 15 * 60_000;
const MAX_INTERVAL_MS = 24 * 60 * 60_000;
const MAX_COLLECTION_TIMEOUT_MS = 30_000;
const MAX_STALE_AFTER_MS = 7 * 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const ABORTED = Symbol("provider-observation-aborted");

interface PersistedLastGoodV1 {
  schemaVersion: 1;
  providers: Partial<Record<RuntimeObservabilityProviderV1, {
    accountScopeKey: string;
    envelope: CollectorEnvelopeV1;
  }>>;
}

interface LastGoodEntry {
  accountScopeKey: string;
  envelope: CollectorEnvelopeV1;
}

interface InFlightCollection {
  provider: RuntimeObservabilityProviderV1;
  accountScopeKey: string;
  controller: AbortController;
  promise: Promise<CollectorEnvelopeV1>;
}

export interface ProviderObservationServiceOptions {
  state: ProviderObservationStatePort;
  now?: () => Date;
  intervalMs?: number;
  collectionTimeoutMs?: number;
  staleAfterMs?: number;
  /** Delete provider-specific passive capture material when a grant changes or is disabled. */
  onPreferenceChanged?: (provider: RuntimeObservabilityProviderV1) => void | Promise<void>;
}

export interface ProviderObservationChangeV1 {
  provider: RuntimeObservabilityProviderV1;
  envelope: CollectorEnvelopeV1;
}

export type ProviderObservationChangeListener = (change: ProviderObservationChangeV1) => void | PromiseLike<void>;

/**
 * View-independent provider observation coordinator. It is intentionally account-scoped rather than agent-scoped:
 * one explicitly configured provider/account has one request, one last-good value and one cadence for the whole host.
 */
export class ProviderObservationService {
  private readonly sources = new Map<string, ProviderObservationSource>();
  private readonly state: ProviderObservationStatePort;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly collectionTimeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly onPreferenceChanged?: ProviderObservationServiceOptions["onPreferenceChanged"];
  private readonly inFlight = new Map<string, InFlightCollection>();
  private readonly lastGood = new Map<RuntimeObservabilityProviderV1, LastGoodEntry>();
  private readonly current = new Map<RuntimeObservabilityProviderV1, CollectorEnvelopeV1>();
  private readonly listeners = new Set<ProviderObservationChangeListener>();
  private configurationQueue: Promise<void> = Promise.resolve();
  private persistQueue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private disposed = false;

  constructor(
    readonly preferences: ProviderObservationPreferences,
    sources: readonly ProviderObservationSource[],
    options: ProviderObservationServiceOptions,
  ) {
    this.state = options.state;
    this.now = options.now ?? (() => new Date());
    this.intervalMs = boundedPositiveInteger(options.intervalMs ?? DEFAULT_INTERVAL_MS, MAX_INTERVAL_MS, "interval");
    this.collectionTimeoutMs = boundedPositiveInteger(
      options.collectionTimeoutMs ?? DEFAULT_COLLECTION_TIMEOUT_MS,
      MAX_COLLECTION_TIMEOUT_MS,
      "collection timeout",
    );
    this.staleAfterMs = boundedPositiveInteger(
      options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      MAX_STALE_AFTER_MS,
      "stale lifetime",
    );
    this.onPreferenceChanged = options.onPreferenceChanged;
    for (const source of sources) {
      const key = sourceKey(source.provider, source.source);
      if (this.sources.has(key)) throw new TypeError(`duplicate provider observation source: ${key}`);
      this.sources.set(key, source);
    }
    this.loadLastGood();
  }

  onDidChange(listener: ProviderObservationChangeListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    void this.tick();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const collection of this.inFlight.values()) collection.controller.abort();
    this.listeners.clear();
  }

  configureProvider(
    provider: RuntimeObservabilityProviderV1,
    input: ProviderObservationPreferenceInputV1,
  ): Promise<ProviderObservationPreferenceV1 | undefined> {
    return this.enqueueConfiguration(() => this.configureProviderNow(provider, input));
  }

  private async configureProviderNow(
    provider: RuntimeObservabilityProviderV1,
    input: ProviderObservationPreferenceInputV1,
  ): Promise<ProviderObservationPreferenceV1 | undefined> {
    const before = this.preferences.get(provider);
    const after = await this.preferences.configure(provider, input);
    if (samePreference(before, after)) return after;

    this.abortProvider(provider);
    this.lastGood.delete(provider);
    this.current.delete(provider);
    await this.persistLastGood();
    await this.onPreferenceChanged?.(provider);

    const envelope = after
      ? unavailableEnvelope(after.scope, "not-observed", this.timestamp(), after.sources[0])
      : unavailableEnvelope(providerScope(provider), "source-disabled", this.timestamp());
    this.publish(provider, envelope);
    return after;
  }

  private enqueueConfiguration<T>(update: () => Promise<T>): Promise<T> {
    const next = this.configurationQueue.then(update, update);
    this.configurationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  getCurrent(provider: RuntimeObservabilityProviderV1): CollectorEnvelopeV1 {
    const cached = this.current.get(provider);
    if (cached) return cloneEnvelope(cached);
    const preference = this.preferences.get(provider);
    return preference
      ? unavailableEnvelope(preference.scope, "not-observed", this.timestamp(), preference.sources[0])
      : unavailableEnvelope(providerScope(provider), "source-disabled", this.timestamp());
  }

  snapshot(): Partial<Record<RuntimeObservabilityProviderV1, CollectorEnvelopeV1>> {
    const out: Partial<Record<RuntimeObservabilityProviderV1, CollectorEnvelopeV1>> = {};
    for (const provider of PROVIDERS) out[provider] = this.getCurrent(provider);
    return out;
  }

  async refreshAll(): Promise<Partial<Record<RuntimeObservabilityProviderV1, CollectorEnvelopeV1>>> {
    const configured = PROVIDERS.filter((provider) => this.preferences.get(provider) !== undefined);
    const pairs = await Promise.all(configured.map(async (provider) => [provider, await this.refresh(provider)] as const));
    return Object.fromEntries(pairs) as Partial<Record<RuntimeObservabilityProviderV1, CollectorEnvelopeV1>>;
  }

  refresh(provider: RuntimeObservabilityProviderV1): Promise<CollectorEnvelopeV1> {
    if (this.disposed) {
      return Promise.resolve(unavailableEnvelope(providerScope(provider), "cancelled", this.timestamp()));
    }
    const preference = this.preferences.get(provider);
    if (!preference) {
      const disabled = unavailableEnvelope(providerScope(provider), "source-disabled", this.timestamp());
      this.publish(provider, disabled);
      return Promise.resolve(disabled);
    }

    const key = collectionKey(provider, preference.scope.key);
    const active = this.inFlight.get(key);
    if (active) return active.promise;

    const controller = new AbortController();
    const collection = {} as InFlightCollection;
    collection.provider = provider;
    collection.accountScopeKey = preference.scope.key;
    collection.controller = controller;
    collection.promise = this.collect(preference, controller).then(async (envelope) => {
      const stillConfigured = this.preferences.get(provider);
      if (!stillConfigured || stillConfigured.scope.key !== preference.scope.key || this.disposed) {
        return this.getCurrent(provider);
      }
      const withFreshness = await this.applyLastGood(provider, preference, envelope);
      return this.publish(provider, withFreshness);
    }).finally(() => {
      if (this.inFlight.get(key) === collection) this.inFlight.delete(key);
    });
    this.inFlight.set(key, collection);
    return collection.promise;
  }

  private async collect(
    preference: ProviderObservationPreferenceV1,
    controller: AbortController,
  ): Promise<CollectorEnvelopeV1> {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.collectionTimeoutMs);
    let lastFailure: CollectorEnvelopeV1 | undefined;
    try {
      for (const sourceKind of preference.sources) {
        if (controller.signal.aborted) {
          return unavailableEnvelope(
            preference.scope,
            timedOut ? "timeout" : "cancelled",
            this.timestamp(),
            sourceKind,
          );
        }
        const source = this.sources.get(sourceKey(preference.scope.provider, sourceKind));
        if (!source) {
          lastFailure = unavailableEnvelope(preference.scope, "unsupported", this.timestamp(), sourceKind);
          continue;
        }
        const envelope = await observeBounded(source, preference.scope, controller.signal, () => timedOut, this.timestamp());
        const projected = validateSourceResult(
          envelope,
          preference.scope,
          sourceKind,
          this.now().getTime(),
          this.staleAfterMs,
        );
        if (projected.ok) return projected.envelope;
        lastFailure = projected.envelope;
        if (firstUnavailableReason(lastFailure) === "cancelled") return lastFailure;
      }
      return lastFailure ?? unavailableEnvelope(preference.scope, "unsupported", this.timestamp());
    } finally {
      clearTimeout(timer);
    }
  }

  private async applyLastGood(
    provider: RuntimeObservabilityProviderV1,
    preference: ProviderObservationPreferenceV1,
    envelope: CollectorEnvelopeV1,
  ): Promise<CollectorEnvelopeV1> {
    if (envelope.facts.some((fact) => fact.kind === "provider-quota")) {
      const retained = cloneEnvelope(envelope);
      this.lastGood.set(provider, { accountScopeKey: preference.scope.key, envelope: retained });
      await this.persistLastGood();
      return cloneEnvelope(retained);
    }

    const retained = this.lastGood.get(provider);
    if (!retained || retained.accountScopeKey !== preference.scope.key) return envelope;
    const quotaFacts = retained.envelope.facts.filter(
      (fact): fact is ProviderQuotaFactV1 => fact.kind === "provider-quota",
    );
    if (quotaFacts.length === 0) return envelope;
    const lastGoodAt = latestQuotaObservation(quotaFacts);
    const age = this.now().getTime() - Date.parse(lastGoodAt);
    if (!Number.isFinite(age) || age < 0 || age > this.staleAfterMs) {
      const failure = envelope.facts.find((fact) => fact.kind === "provider-unavailable");
      return unavailableEnvelope(
        preference.scope,
        "stale-expired",
        this.timestamp(),
        failure?.source,
        lastGoodAt,
      );
    }

    const generatedAt = this.timestamp();
    const staleFacts: ProviderQuotaFactV1[] = quotaFacts.map((fact) => ({
      ...fact,
      scope: { ...fact.scope },
      freshness: { state: "stale", lastGoodAt },
      windows: fact.windows.map((window) => ({ ...window })),
    }));
    const failure = envelope.facts.find((fact) => fact.kind === "provider-unavailable");
    const reason = failure?.reason ?? "provider-error";
    const candidate: CollectorEnvelopeV1 = {
      schemaVersion: 1,
      collector: HOST_COLLECTOR,
      generatedAt,
      facts: [
        ...staleFacts,
        {
          kind: "provider-unavailable",
          scope: { ...preference.scope },
          source: failure?.source,
          observedAt: generatedAt,
          reason,
          lastGoodAt,
        },
      ],
      diagnostics: [
        ...staleFacts.map((_fact, factIndex) => ({
          code: "STALE_LAST_GOOD" as const,
          provider,
          factIndex,
        })),
        {
          code: diagnosticCode(reason),
          provider,
          factIndex: staleFacts.length,
        },
      ],
    };
    return validatedHostEnvelope(candidate, preference.scope, generatedAt);
  }

  private loadLastGood(): void {
    const raw = this.state.get<unknown>(PROVIDER_OBSERVATION_LAST_GOOD_STATE_KEY);
    if (!record(raw) || raw.schemaVersion !== 1 || !record(raw.providers)) return;
    for (const provider of PROVIDERS) {
      const preference = this.preferences.get(provider);
      const entry = raw.providers[provider];
      if (!preference || !record(entry) || entry.accountScopeKey !== preference.scope.key) continue;
      const projected = validateSourceResult(
        entry.envelope,
        preference.scope,
        preference.sources,
        this.now().getTime(),
      );
      if (!projected.ok || !projected.envelope.facts.some((fact) => fact.kind === "provider-quota")) continue;
      this.lastGood.set(provider, { accountScopeKey: preference.scope.key, envelope: projected.envelope });
    }
  }

  private persistLastGood(): Promise<void> {
    const persist = async () => {
      const providers: PersistedLastGoodV1["providers"] = {};
      for (const provider of PROVIDERS) {
        const entry = this.lastGood.get(provider);
        if (entry) providers[provider] = {
          accountScopeKey: entry.accountScopeKey,
          envelope: cloneEnvelope(entry.envelope),
        };
      }
      const state: PersistedLastGoodV1 = { schemaVersion: 1, providers };
      await Promise.resolve(this.state.update(PROVIDER_OBSERVATION_LAST_GOOD_STATE_KEY, state));
    };
    const next = this.persistQueue.then(persist, persist);
    this.persistQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private abortProvider(provider: RuntimeObservabilityProviderV1): void {
    for (const collection of this.inFlight.values()) {
      if (collection.provider === provider) collection.controller.abort();
    }
  }

  private publish(provider: RuntimeObservabilityProviderV1, envelope: CollectorEnvelopeV1): CollectorEnvelopeV1 {
    const prior = this.current.get(provider);
    const retained = cloneEnvelope(envelope);
    this.current.set(provider, retained);
    if (prior && JSON.stringify(prior) === JSON.stringify(retained)) return cloneEnvelope(retained);
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener({ provider, envelope: cloneEnvelope(retained) })).catch(() => undefined);
      } catch { /* One host listener cannot break collection. */ }
    }
    return cloneEnvelope(retained);
  }

  private async tick(): Promise<void> {
    try {
      await this.refreshAll();
    } catch {
      // Individual sources are already converted to typed unavailable envelopes; scheduling remains alive.
    } finally {
      if (this.started && !this.disposed) this.timer = setTimeout(() => void this.tick(), this.intervalMs);
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

async function observeBounded(
  source: ProviderObservationSource,
  scope: ProviderAccountObservationScopeV1,
  signal: AbortSignal,
  timedOut: () => boolean,
  observedAt: string,
): Promise<CollectorEnvelopeV1> {
  if (signal.aborted) {
    return unavailableEnvelope(scope, timedOut() ? "timeout" : "cancelled", observedAt, source.source);
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      source.observe({
        scope,
        grant: {
          state: "granted",
          capability: PROVIDER_QUOTA_READ_CAPABILITY,
          source: source.source,
          consent: "explicit-user",
        },
        signal,
      }),
      aborted,
    ]);
  } catch (error) {
    return unavailableEnvelope(
      scope,
      error === ABORTED ? (timedOut() ? "timeout" : "cancelled") : "provider-error",
      observedAt,
      source.source,
    );
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

type SourceValidationResult =
  | { ok: true; envelope: CollectorEnvelopeV1 }
  | { ok: false; envelope: CollectorEnvelopeV1 };

function validateSourceResult(
  raw: unknown,
  scope: ProviderAccountObservationScopeV1,
  source: ProviderSourceKindV1 | readonly ProviderSourceKindV1[],
  nowMs: number,
  maxFreshAgeMs?: number,
): SourceValidationResult {
  const allowedSources = Array.isArray(source) ? source : [source];
  const validated = validateCollectorEnvelopeV1(raw);
  const invalid = () => ({
    ok: false as const,
    envelope: unavailableEnvelope(scope, "invalid-payload", new Date(nowMs).toISOString(), allowedSources[0]),
  });
  if (!validated.ok || validated.value.facts.length !== 1) return invalid();
  const envelope = validated.value;
  if (Date.parse(envelope.generatedAt) > nowMs + MAX_FUTURE_SKEW_MS) return invalid();
  if (envelope.diagnostics.some((diagnostic) => diagnostic.provider !== undefined && diagnostic.provider !== scope.provider)) {
    return invalid();
  }
  const fact = envelope.facts[0];
  if (fact.kind !== "provider-quota" && fact.kind !== "provider-unavailable") return invalid();
  if (fact.scope.kind !== "provider-account"
    || fact.scope.provider !== scope.provider
    || fact.scope.key !== scope.key) return invalid();
  if (fact.kind === "provider-quota") {
    if (!allowedSources.includes(fact.source) || fact.freshness.state !== "fresh" || envelope.diagnostics.length > 0) {
      return invalid();
    }
    if (maxFreshAgeMs !== undefined && nowMs - Date.parse(fact.observedAt) > maxFreshAgeMs) return invalid();
    return { ok: true, envelope };
  }
  if (fact.source !== undefined && !allowedSources.includes(fact.source)) return invalid();
  return { ok: false, envelope };
}

function unavailableEnvelope(
  scope: ProviderObservationScopeV1 | ProviderAccountObservationScopeV1,
  reason: ProviderUnavailableReasonV1,
  observedAt: string,
  source?: ProviderSourceKindV1,
  lastGoodAt?: string,
): CollectorEnvelopeV1 {
  const candidate: CollectorEnvelopeV1 = {
    schemaVersion: 1,
    collector: HOST_COLLECTOR,
    generatedAt: observedAt,
    facts: [{
      kind: "provider-unavailable",
      scope: { ...scope },
      ...(source ? { source } : {}),
      observedAt,
      reason,
      ...(lastGoodAt ? { lastGoodAt } : {}),
    }],
    diagnostics: [{ code: diagnosticCode(reason), provider: scope.provider, factIndex: 0 }],
  };
  return validatedHostEnvelope(candidate, scope, observedAt);
}

function validatedHostEnvelope(
  candidate: CollectorEnvelopeV1,
  scope: ProviderObservationScopeV1 | ProviderAccountObservationScopeV1,
  observedAt: string,
): CollectorEnvelopeV1 {
  const validated = validateCollectorEnvelopeV1(candidate);
  if (validated.ok) return validated.value;
  if (candidate.facts[0]?.kind === "provider-unavailable" && candidate.facts[0].reason === "invalid-payload") {
    throw new Error("host produced an invalid fallback envelope");
  }
  return unavailableEnvelope(scope, "invalid-payload", observedAt);
}

function diagnosticCode(reason: ProviderUnavailableReasonV1): CollectorDiagnosticCodeV1 {
  if (reason === "timeout") return "SOURCE_TIMEOUT";
  if (reason === "cancelled") return "SOURCE_CANCELLED";
  if (reason === "invalid-payload") return "INVALID_PAYLOAD";
  if (reason === "stale-expired") return "STALE_LAST_GOOD";
  return "SOURCE_UNAVAILABLE";
}

function firstUnavailableReason(envelope: CollectorEnvelopeV1): ProviderUnavailableReasonV1 | undefined {
  const fact = envelope.facts.find((candidate) => candidate.kind === "provider-unavailable");
  return fact?.reason;
}

function latestQuotaObservation(facts: readonly ProviderQuotaFactV1[]): string {
  return facts.reduce((latest, fact) => fact.observedAt > latest ? fact.observedAt : latest, facts[0].observedAt);
}

function providerScope(provider: RuntimeObservabilityProviderV1): ProviderObservationScopeV1 {
  return { kind: "provider", provider };
}

function sourceKey(provider: RuntimeObservabilityProviderV1, source: ProviderSourceKindV1): string {
  return `${provider}:${source}`;
}

function collectionKey(provider: RuntimeObservabilityProviderV1, accountScopeKey: string): string {
  return `${provider}:${accountScopeKey}`;
}

function samePreference(
  left: ProviderObservationPreferenceV1 | undefined,
  right: ProviderObservationPreferenceV1 | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.scope.key === right.scope.key
    && left.sources.length === right.sources.length
    && left.sources.every((source, index) => source === right.sources[index]);
}

function boundedPositiveInteger(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new TypeError(`provider observation ${label} must be an integer between 1 and ${max}ms`);
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneEnvelope(envelope: CollectorEnvelopeV1): CollectorEnvelopeV1 {
  return structuredClone(envelope);
}
