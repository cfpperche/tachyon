import { randomBytes } from "node:crypto";
import type {
  ProviderAccountObservationScopeV1,
  ProviderSourceKindV1,
  RuntimeObservabilityProviderV1,
} from "./types.js";

export const PROVIDER_OBSERVATION_PREFERENCES_STATE_KEY = "tachyon.runtimeObservability.preferences.v1";

const PROVIDERS = ["codex", "claude"] as const satisfies readonly RuntimeObservabilityProviderV1[];
const SOURCES = new Set<ProviderSourceKindV1>(["cli", "oauth"]);
const SOURCE_PRIORITY: Record<ProviderSourceKindV1, number> = { cli: 0, oauth: 1 };
const SAFE_SCOPE_KEY = /^ps_[0-9a-f]{16,64}$/u;

export interface ProviderObservationStatePort {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): void | PromiseLike<void>;
}

export interface ProviderObservationPreferenceV1 {
  scope: ProviderAccountObservationScopeV1;
  /** Explicitly selected strategies in canonical host-owned fallback order. */
  sources: ProviderSourceKindV1[];
}

export type ProviderObservationPreferenceInputV1 =
  | { state: "disabled" }
  | {
      state: "granted";
      consent: "explicit-user";
      sources: readonly ProviderSourceKindV1[];
    };

interface PersistedProviderPreferenceV1 {
  accountScopeKey: string;
  sources: ProviderSourceKindV1[];
}

interface PersistedProviderPreferencesV1 {
  schemaVersion: 1;
  providers: Partial<Record<RuntimeObservabilityProviderV1, PersistedProviderPreferenceV1>>;
}

/**
 * Machine-local source selection. Nothing ambient can enable this store: callers must present an exact
 * `explicit-user` grant, and the default/invalid persisted state is disabled for every provider.
 */
export class ProviderObservationPreferences {
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: ProviderObservationStatePort,
    private readonly randomHex: () => string = () => randomBytes(16).toString("hex"),
  ) {}

  get(provider: RuntimeObservabilityProviderV1): ProviderObservationPreferenceV1 | undefined {
    const persisted = this.read().providers[provider];
    if (!persisted) return undefined;
    return {
      scope: { kind: "provider-account", provider, key: persisted.accountScopeKey },
      sources: [...persisted.sources],
    };
  }

  all(): Partial<Record<RuntimeObservabilityProviderV1, ProviderObservationPreferenceV1>> {
    const out: Partial<Record<RuntimeObservabilityProviderV1, ProviderObservationPreferenceV1>> = {};
    for (const provider of PROVIDERS) {
      const preference = this.get(provider);
      if (preference) out[provider] = preference;
    }
    return out;
  }

  configure(
    provider: RuntimeObservabilityProviderV1,
    input: ProviderObservationPreferenceInputV1,
  ): Promise<ProviderObservationPreferenceV1 | undefined> {
    return this.enqueueUpdate(() => this.configureNow(provider, input));
  }

  private async configureNow(
    provider: RuntimeObservabilityProviderV1,
    input: ProviderObservationPreferenceInputV1,
  ): Promise<ProviderObservationPreferenceV1 | undefined> {
    // Quota preferences remain Codex/Claude-only; Grok configuration uses a separate axis/source.
    if (!(PROVIDERS as readonly string[]).includes(provider) || !record(input)) {
      throw new TypeError("provider observation preference is invalid");
    }
    const current = this.read();
    if (input.state === "disabled") {
      if (current.providers[provider] === undefined) return undefined;
      delete current.providers[provider];
      await Promise.resolve(this.state.update(PROVIDER_OBSERVATION_PREFERENCES_STATE_KEY, current));
      return undefined;
    }
    if (input.state !== "granted" || input.consent !== "explicit-user") {
      throw new TypeError("provider observation requires explicit user consent");
    }

    const sources = validateExplicitSources(input.sources);
    const prior = current.providers[provider];
    const sameSources = prior !== undefined
      && prior.sources.length === sources.length
      && prior.sources.every((source, index) => source === sources[index]);
    const accountScopeKey = sameSources ? prior.accountScopeKey : this.createScopeKey();
    current.providers[provider] = { accountScopeKey, sources };
    await Promise.resolve(this.state.update(PROVIDER_OBSERVATION_PREFERENCES_STATE_KEY, current));
    return {
      scope: { kind: "provider-account", provider, key: accountScopeKey },
      sources: [...sources],
    };
  }

  private enqueueUpdate<T>(update: () => Promise<T>): Promise<T> {
    const next = this.updateQueue.then(update, update);
    this.updateQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private read(): PersistedProviderPreferencesV1 {
    const raw = this.state.get<unknown>(PROVIDER_OBSERVATION_PREFERENCES_STATE_KEY);
    if (!record(raw) || raw.schemaVersion !== 1 || !record(raw.providers)) {
      return { schemaVersion: 1, providers: {} };
    }
    const providers: PersistedProviderPreferencesV1["providers"] = {};
    for (const provider of PROVIDERS) {
      const candidate = raw.providers[provider];
      if (!record(candidate)
        || typeof candidate.accountScopeKey !== "string"
        || !SAFE_SCOPE_KEY.test(candidate.accountScopeKey)
        || !Array.isArray(candidate.sources)) {
        continue;
      }
      try {
        providers[provider] = {
          accountScopeKey: candidate.accountScopeKey,
          sources: validateExplicitSources(candidate.sources),
        };
      } catch {
        // A malformed provider entry disables only that provider; no ambient fallback is inferred.
      }
    }
    return { schemaVersion: 1, providers };
  }

  private createScopeKey(): string {
    const hex = this.randomHex();
    const key = `ps_${hex}`;
    if (!SAFE_SCOPE_KEY.test(key)) throw new Error("provider observation scope generator returned an unsafe key");
    return key;
  }
}

function validateExplicitSources(raw: readonly unknown[]): ProviderSourceKindV1[] {
  if (raw.length === 0 || raw.length > SOURCES.size) {
    throw new TypeError("provider observation sources must contain one or two explicit strategies");
  }
  const sources: ProviderSourceKindV1[] = [];
  for (const source of raw) {
    if (typeof source !== "string" || !SOURCES.has(source as ProviderSourceKindV1)) {
      throw new TypeError("provider observation source is unsupported");
    }
    if (sources.includes(source as ProviderSourceKindV1)) {
      throw new TypeError("provider observation sources must be unique");
    }
    sources.push(source as ProviderSourceKindV1);
  }
  return sources.sort((left, right) => SOURCE_PRIORITY[left] - SOURCE_PRIORITY[right]);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
