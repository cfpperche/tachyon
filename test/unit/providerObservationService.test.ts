import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderObservationPreferences,
  type ProviderObservationStatePort,
} from "@tachyon/engine/runtimeObservability/preferences.js";
import {
  PROVIDER_OBSERVATION_LAST_GOOD_STATE_KEY,
  ProviderObservationService,
} from "@tachyon/engine/runtimeObservability/service.js";
import type {
  ProviderObservationRequestV1,
  ProviderObservationSource,
} from "@tachyon/engine/runtimeObservability/source.js";
import type {
  CollectorEnvelopeV1,
  ProviderAccountObservationScopeV1,
  ProviderSourceKindV1,
  ProviderUnavailableReasonV1,
  RuntimeObservabilityProviderV1,
} from "@tachyon/engine/runtimeObservability/types.js";
import { validateCollectorEnvelopeV1 } from "@tachyon/engine/runtimeObservability/validate.js";

class MemoryState implements ProviderObservationStatePort {
  readonly values = new Map<string, unknown>();
  readonly writes: Array<{ key: string; value: unknown }> = [];

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): void {
    const copy = structuredClone(value);
    this.values.set(key, copy);
    this.writes.push({ key, value: copy });
  }
}

type SourceHandler = (request: ProviderObservationRequestV1) => Promise<CollectorEnvelopeV1>;

function fakeSource(
  provider: RuntimeObservabilityProviderV1,
  source: ProviderSourceKindV1,
  handler: SourceHandler,
  channel: ProviderObservationSource["channel"] = { acquisition: "control-plane", mechanism: "fixture" },
): ProviderObservationSource {
  return { provider, source, channel, observe: handler };
}

const START = Date.parse("2026-07-14T21:45:00.000Z");

function quota(
  scope: ProviderAccountObservationScopeV1,
  source: ProviderSourceKindV1,
  observedAt: string,
  usedPercent = 42,
): CollectorEnvelopeV1 {
  return {
    schemaVersion: 1,
    collector: { id: `fixture-${scope.provider}-${source}`, version: "1.0.0" },
    generatedAt: observedAt,
    facts: [{
      kind: "provider-quota",
      scope,
      source,
      confidence: "exact",
      observedAt,
      freshness: { state: "fresh" },
      windows: [{ name: "session", usedPercent, windowMinutes: 300 }],
    }],
    diagnostics: [],
  };
}

function unavailable(
  scope: ProviderAccountObservationScopeV1,
  source: ProviderSourceKindV1,
  observedAt: string,
  reason: ProviderUnavailableReasonV1,
): CollectorEnvelopeV1 {
  return {
    schemaVersion: 1,
    collector: { id: `fixture-${scope.provider}-${source}`, version: "1.0.0" },
    generatedAt: observedAt,
    facts: [{ kind: "provider-unavailable", scope, source, observedAt, reason }],
    diagnostics: [{
      code: reason === "timeout" ? "SOURCE_TIMEOUT" : reason === "invalid-payload" ? "INVALID_PAYLOAD" : "SOURCE_UNAVAILABLE",
      provider: scope.provider,
      factIndex: 0,
    }],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function configuredHarness(options: {
  provider?: RuntimeObservabilityProviderV1;
  sources?: readonly ProviderSourceKindV1[];
  adapters?: ProviderObservationSource[];
  nowMs?: { value: number };
  state?: MemoryState;
  collectionTimeoutMs?: number;
  staleAfterMs?: number;
  intervalMs?: number;
  onPreferenceChanged?: (provider: RuntimeObservabilityProviderV1) => void | Promise<void>;
} = {}) {
  const provider = options.provider ?? "claude";
  const state = options.state ?? new MemoryState();
  const nowMs = options.nowMs ?? { value: START };
  const preferences = new ProviderObservationPreferences(state, () => "1".repeat(32));
  await preferences.configure(provider, {
    state: "granted",
    consent: "explicit-user",
    sources: options.sources ?? ["cli"],
  });
  const service = new ProviderObservationService(preferences, options.adapters ?? [], {
    state,
    now: () => new Date(nowMs.value),
    intervalMs: options.intervalMs ?? 60_000,
    collectionTimeoutMs: options.collectionTimeoutMs ?? 1_000,
    staleAfterMs: options.staleAfterMs ?? 15 * 60_000,
    onPreferenceChanged: options.onPreferenceChanged,
  });
  const preference = preferences.get(provider);
  if (!preference) throw new Error("test preference missing");
  return { provider, state, nowMs, preferences, preference, service };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ProviderObservationService", () => {
  it("does not touch any source while the machine-local preference is disabled", async () => {
    const state = new MemoryState();
    const preferences = new ProviderObservationPreferences(state);
    const observe = vi.fn<SourceHandler>();
    const service = new ProviderObservationService(preferences, [fakeSource("codex", "cli", observe)], {
      state,
      now: () => new Date(START),
    });

    const envelope = await service.refresh("codex");

    expect(envelope.facts[0]).toMatchObject({
      kind: "provider-unavailable",
      scope: { kind: "provider", provider: "codex" },
      reason: "source-disabled",
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it("tries only explicitly ordered sources and falls back after a typed failure", async () => {
    const calls: Array<{ source: string; request: ProviderObservationRequestV1 }> = [];
    let scope!: ProviderAccountObservationScopeV1;
    const cli = fakeSource("claude", "cli", async (request) => {
      calls.push({ source: "cli", request });
      scope = request.scope;
      return unavailable(scope, "cli", "2026-07-14T21:45:00.000Z", "not-observed");
    });
    const oauth = fakeSource("claude", "oauth", async (request) => {
      calls.push({ source: "oauth", request });
      return quota(request.scope, "oauth", "2026-07-14T21:45:00.000Z", 63);
    });
    const h = await configuredHarness({ sources: ["cli", "oauth"], adapters: [oauth, cli] });

    const envelope = await h.service.refresh("claude");

    expect(calls.map((call) => call.source)).toEqual(["cli", "oauth"]);
    expect(calls.map((call) => call.request.grant)).toEqual([
      { state: "granted", capability: "provider-quota-read", source: "cli", consent: "explicit-user" },
      { state: "granted", capability: "provider-quota-read", source: "oauth", consent: "explicit-user" },
    ]);
    expect(calls[0].request.scope).toEqual(calls[1].request.scope);
    expect(envelope.facts[0]).toMatchObject({
      kind: "provider-quota",
      source: "oauth",
      windows: [{ usedPercent: 63 }],
    });
  });

  it("never probes an installed but ungranted fallback", async () => {
    const cli = vi.fn<SourceHandler>();
    const oauth = vi.fn<SourceHandler>();
    const h = await configuredHarness({
      sources: ["cli"],
      adapters: [
        fakeSource("claude", "cli", async (request) => {
          cli(request);
          return unavailable(request.scope, "cli", "2026-07-14T21:45:00.000Z", "provider-error");
        }),
        fakeSource("claude", "oauth", async (request) => {
          oauth(request);
          return quota(request.scope, "oauth", "2026-07-14T21:45:00.000Z");
        }),
      ],
    });

    const envelope = await h.service.refresh("claude");

    expect(envelope.facts[0]).toMatchObject({ kind: "provider-unavailable", reason: "provider-error" });
    expect(cli).toHaveBeenCalledTimes(1);
    expect(oauth).not.toHaveBeenCalled();
  });

  it("coalesces concurrent refreshes for one provider/account scope", async () => {
    const pending = deferred<CollectorEnvelopeV1>();
    const observe = vi.fn<SourceHandler>((request) => pending.promise.then(() => (
      quota(request.scope, "cli", "2026-07-14T21:45:00.000Z")
    )));
    const h = await configuredHarness({ adapters: [fakeSource("claude", "cli", observe)] });

    const first = h.service.refresh("claude");
    const second = h.service.refresh("claude");
    expect(second).toBe(first);
    expect(observe).toHaveBeenCalledTimes(1);

    pending.resolve(quota(h.preference.scope, "cli", "2026-07-14T21:45:00.000Z"));
    await expect(first).resolves.toMatchObject({ facts: [{ kind: "provider-quota" }] });
  });

  it("fans out one cached normalized change and isolates a failing host listener", async () => {
    const h = await configuredHarness({
      adapters: [fakeSource("claude", "cli", async (request) => (
        quota(request.scope, "cli", "2026-07-14T21:45:00.000Z")
      ))],
    });
    const changes: CollectorEnvelopeV1[] = [];
    h.service.onDidChange(({ envelope }) => {
      (envelope.facts[0] as { kind: string }).kind = "mutated-by-listener";
      throw new Error("broken RuntimeOps listener");
    });
    h.service.onDidChange(async () => { throw new Error("rejected async RuntimeOps listener"); });
    const healthy = h.service.onDidChange(({ envelope }) => { changes.push(envelope); });

    await expect(h.service.refresh("claude")).resolves.toMatchObject({ facts: [{ kind: "provider-quota" }] });
    await expect(h.service.refresh("claude")).resolves.toMatchObject({ facts: [{ kind: "provider-quota" }] });

    expect(changes).toHaveLength(1);
    expect(changes[0].facts[0].kind).toBe("provider-quota");
    expect(changes[0]).toEqual(h.service.getCurrent("claude"));
    expect(h.service.snapshot().claude).toEqual(changes[0]);
    (changes[0].facts[0] as { kind: string }).kind = "mutated-by-consumer";
    expect(h.service.getCurrent("claude").facts[0].kind).toBe("provider-quota");
    healthy.dispose();
  });

  it("bounds a source that ignores cancellation with one whole-chain timeout", async () => {
    const observe = vi.fn<SourceHandler>(() => new Promise<CollectorEnvelopeV1>(() => undefined));
    const h = await configuredHarness({
      adapters: [fakeSource("claude", "cli", observe)],
      collectionTimeoutMs: 5,
    });

    const envelope = await h.service.refresh("claude");

    expect(envelope.facts[0]).toMatchObject({ kind: "provider-unavailable", reason: "timeout" });
    expect(envelope.diagnostics[0]).toMatchObject({ code: "SOURCE_TIMEOUT" });
    expect((observe.mock.calls[0][0] as ProviderObservationRequestV1).signal?.aborted).toBe(true);
  });

  it("revalidates source scope and fails a mismatched account closed", async () => {
    const h = await configuredHarness({
      adapters: [fakeSource("claude", "cli", async (request) => ({
        ...quota(request.scope, "cli", "2026-07-14T21:45:00.000Z"),
        facts: [{
          ...quota(request.scope, "cli", "2026-07-14T21:45:00.000Z").facts[0],
          scope: { ...request.scope, key: "ps_ffffffffffffffff" },
          futureRawIdentity: "MUST_NOT_CROSS",
        }],
        rawResponse: "MUST_NOT_CROSS_RAW",
      } as unknown as CollectorEnvelopeV1))],
    });

    const envelope = await h.service.refresh("claude");

    expect(envelope.facts[0]).toMatchObject({ kind: "provider-unavailable", reason: "invalid-payload" });
    expect(JSON.stringify(envelope)).not.toContain("MUST_NOT_CROSS");
  });

  it("rejects a provider-wide unavailable fact for an explicitly account-scoped request", async () => {
    const h = await configuredHarness({
      adapters: [fakeSource("claude", "cli", async () => ({
        schemaVersion: 1,
        collector: { id: "fixture-claude-cli", version: "1.0.0" },
        generatedAt: "2026-07-14T21:45:00.000Z",
        facts: [{
          kind: "provider-unavailable",
          scope: { kind: "provider", provider: "claude" },
          source: "cli",
          observedAt: "2026-07-14T21:45:00.000Z",
          reason: "provider-error",
        }],
        diagnostics: [{ code: "SOURCE_UNAVAILABLE", provider: "claude", factIndex: 0 }],
      }))],
    });

    const envelope = await h.service.refresh("claude");

    expect(envelope.facts[0]).toMatchObject({
      kind: "provider-unavailable",
      scope: h.preference.scope,
      reason: "invalid-payload",
    });
  });

  it("rejects a source that labels an expired observation as fresh", async () => {
    const old = new Date(START - 16 * 60_000).toISOString();
    const h = await configuredHarness({
      staleAfterMs: 15 * 60_000,
      adapters: [fakeSource("claude", "cli", async (request) => quota(request.scope, "cli", old))],
    });

    const envelope = await h.service.refresh("claude");

    expect(envelope.facts[0]).toMatchObject({ kind: "provider-unavailable", reason: "invalid-payload" });
  });

  it("serves normalized last-good data as stale, reloads it safely, then expires it", async () => {
    const state = new MemoryState();
    const nowMs = { value: START };
    let fail = false;
    const source = fakeSource("claude", "cli", async (request) => fail
      ? unavailable(request.scope, "cli", new Date(nowMs.value).toISOString(), "provider-error")
      : quota(request.scope, "cli", new Date(nowMs.value).toISOString(), 37));
    const first = await configuredHarness({ state, nowMs, adapters: [source], staleAfterMs: 5 * 60_000 });

    expect((await first.service.refresh("claude")).facts[0]).toMatchObject({ kind: "provider-quota" });
    const persisted = JSON.stringify(state.values.get(PROVIDER_OBSERVATION_LAST_GOOD_STATE_KEY));
    expect(persisted).not.toMatch(/email|session_id|rawResponse/u);

    fail = true;
    nowMs.value += 60_000;
    const stale = await first.service.refresh("claude");
    expect(stale.facts).toMatchObject([
      { kind: "provider-quota", freshness: { state: "stale", lastGoodAt: "2026-07-14T21:45:00.000Z" } },
      { kind: "provider-unavailable", reason: "provider-error", lastGoodAt: "2026-07-14T21:45:00.000Z" },
    ]);
    expect(validateCollectorEnvelopeV1(stale)).toMatchObject({ ok: true });

    const reloaded = await configuredHarness({ state, nowMs, adapters: [source], staleAfterMs: 5 * 60_000 });
    expect((await reloaded.service.refresh("claude")).facts[0]).toMatchObject({
      kind: "provider-quota",
      freshness: { state: "stale" },
    });

    nowMs.value += 6 * 60_000;
    const expired = await reloaded.service.refresh("claude");
    expect(expired.facts).toEqual([expect.objectContaining({
      kind: "provider-unavailable",
      reason: "stale-expired",
      lastGoodAt: "2026-07-14T21:45:00.000Z",
    })]);
  });

  it("aborts collection and clears normalized state when consent is disabled", async () => {
    const observed = deferred<CollectorEnvelopeV1>();
    const cleanup = vi.fn();
    const h = await configuredHarness({
      adapters: [fakeSource("claude", "cli", () => observed.promise)],
      onPreferenceChanged: cleanup,
    });
    const pending = h.service.refresh("claude");

    await h.service.configureProvider("claude", { state: "disabled" });
    const cancelled = await pending;

    expect(cancelled.facts[0]).toMatchObject({ kind: "provider-unavailable", reason: "source-disabled" });
    expect(h.service.getCurrent("claude").facts[0]).toMatchObject({ reason: "source-disabled" });
    expect(cleanup).toHaveBeenCalledWith("claude");
    expect(h.state.values.get(PROVIDER_OBSERVATION_LAST_GOOD_STATE_KEY)).toEqual({
      schemaVersion: 1,
      providers: {},
    });
  });

  it("does not publish a completed observation after consent revocation has started", async () => {
    const state = new MemoryState();
    const captureRevoked = deferred<void>();
    const h = await configuredHarness({
      state,
      adapters: [fakeSource("claude", "cli", async (request) => (
        quota(request.scope, "cli", "2026-07-14T21:45:00.000Z")
      ))],
      onPreferenceChanged: () => { captureRevoked.resolve(undefined); },
    });
    const persistenceStarted = deferred<void>();
    const persistenceRelease = deferred<void>();
    const disabledPersisted = deferred<void>();
    const baseUpdate = state.update.bind(state);
    let blockFirstLastGood = true;
    (state as { update: ProviderObservationStatePort["update"] }).update = (key, value) => {
      if (blockFirstLastGood && key === PROVIDER_OBSERVATION_LAST_GOOD_STATE_KEY) {
        blockFirstLastGood = false;
        persistenceStarted.resolve(undefined);
        return persistenceRelease.promise.then(() => baseUpdate(key, value));
      }
      const result = baseUpdate(key, value);
      if (key !== PROVIDER_OBSERVATION_LAST_GOOD_STATE_KEY) disabledPersisted.resolve(undefined);
      return result;
    };
    const changes: CollectorEnvelopeV1[] = [];
    h.service.onDidChange(({ envelope }) => { changes.push(envelope); });

    const refresh = h.service.refresh("claude");
    await persistenceStarted.promise;
    const disabled = h.service.configureProvider("claude", { state: "disabled" });
    await disabledPersisted.promise;
    expect(h.preferences.get("claude")).toBeUndefined();
    await captureRevoked.promise;
    persistenceRelease.resolve(undefined);

    await expect(refresh).resolves.toMatchObject({
      facts: [{ kind: "provider-unavailable", reason: "source-disabled" }],
    });
    await disabled;
    expect(changes.some((envelope) => envelope.facts.some((fact) => fact.kind === "provider-quota"))).toBe(false);
  });

  it("serializes same-provider consent lifecycle side effects", async () => {
    const cleanupStarted = deferred<void>();
    const cleanupRelease = deferred<void>();
    const h = await configuredHarness({
      onPreferenceChanged: async () => {
        cleanupStarted.resolve();
        await cleanupRelease.promise;
      },
    });

    const changed = h.service.configureProvider("claude", {
      state: "granted",
      consent: "explicit-user",
      sources: ["oauth", "cli"],
    });
    await cleanupStarted.promise;
    const disabled = h.service.configureProvider("claude", { state: "disabled" });
    expect(h.preferences.get("claude")?.sources).toEqual(["cli", "oauth"]);
    cleanupRelease.resolve();
    await Promise.all([changed, disabled]);

    expect(h.preferences.get("claude")).toBeUndefined();
    expect(h.service.getCurrent("claude").facts[0]).toMatchObject({ reason: "source-disabled" });
  });

  it("uses a self-rescheduling cadence and stops it on dispose", async () => {
    vi.useFakeTimers();
    const observe = vi.fn<SourceHandler>(async (request) => (
      quota(request.scope, "cli", "2026-07-14T21:45:00.000Z")
    ));
    const h = await configuredHarness({
      adapters: [fakeSource("claude", "cli", observe)],
      intervalMs: 1_000,
    });

    h.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(observe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(observe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(observe).toHaveBeenCalledTimes(2);

    h.service.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(observe).toHaveBeenCalledTimes(2);
  });
});
