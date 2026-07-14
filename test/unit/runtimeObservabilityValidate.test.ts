import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CollectorEnvelopeV1 } from "../../src/runtimeObservability/types.js";
import {
  validateCollectorEnvelopeV1,
  type CollectorEnvelopeValidationResult,
  type CollectorValidationIssueCode,
} from "../../src/runtimeObservability/validate.js";

interface FixtureCorpus {
  provenance: {
    upstreamTag: string;
    upstreamCommit: string;
  };
  validEnvelope: Record<string, unknown>;
  futureCostEnvelope: Record<string, unknown>;
}

type EnvelopeFixtureName = "validEnvelope" | "futureCostEnvelope";

const corpus = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), "test/fixtures/runtime-observability-v1.json"),
  "utf8",
)) as FixtureCorpus;

function cloneEnvelope(name: EnvelopeFixtureName = "validEnvelope"): Record<string, unknown> {
  return structuredClone(corpus[name]);
}

function facts(envelope: Record<string, unknown>): Array<Record<string, unknown>> {
  return envelope.facts as Array<Record<string, unknown>>;
}

function valid(raw: unknown): CollectorEnvelopeV1 {
  const result = validateCollectorEnvelopeV1(raw);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error("expected valid fixture");
  return result.value;
}

function invalid(
  raw: unknown,
  code: CollectorValidationIssueCode,
  pathValue?: string,
): Extract<CollectorEnvelopeValidationResult, { ok: false }> {
  const result = validateCollectorEnvelopeV1(raw);
  expect(result).toMatchObject({ ok: false, unavailable: { state: "unavailable", issues: [{ code }] } });
  if (result.ok) throw new Error("expected invalid fixture");
  if (pathValue) expect(result.unavailable.issues[0].path).toBe(pathValue);
  return result;
}

describe("RuntimeObservability CollectorEnvelopeV1 validation", () => {
  it("normalizes the pinned synthetic compatibility fixture into a provider-neutral contract", () => {
    const envelope = valid(cloneEnvelope());
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      collector: {
        id: "tachyon-reference-fixture",
        version: "1.0.0",
      },
      generatedAt: "2026-07-14T18:00:00.000Z",
    });
    expect(corpus.provenance).toMatchObject({
      upstreamTag: "v0.43.0",
      upstreamCommit: "5a0cbc07119ac04d998e2fd5267442ed9358fff0",
    });
    expect(JSON.stringify(envelope).toLowerCase()).not.toContain("codexbar");
    expect(envelope.facts).toHaveLength(3);
    expect(envelope.facts[0]).toMatchObject({
      kind: "native-usage",
      scope: { kind: "agent", workspaceKey: "ws-7f31", agentKey: "agent-codex" },
    });
    expect(envelope.facts[1]).toMatchObject({
      kind: "provider-quota",
      scope: { kind: "provider-account", provider: "codex", key: "ps_0000000000000001" },
    });
  });

  it("keeps the reserved cost shape outside the quota-only V1 envelope", () => {
    const raw = cloneEnvelope("futureCostEnvelope");
    invalid(raw, "INVALID_FACT", "$.facts[0].kind");
    expect(JSON.stringify(raw)).not.toContain("agentKey");
  });

  it("tolerates additive fields while stripping identities, credentials, paths, raw bodies, and messages", () => {
    const raw = cloneEnvelope();
    raw.futureEnvelopeField = { token: "MUST_NOT_CROSS_TOKEN" };
    const collector = raw.collector as Record<string, unknown>;
    collector.accountEmail = "must-not-cross@example.invalid";
    collector.absolutePath = "/home/private/provider.json";
    const quota = facts(raw)[1];
    quota.attribution = { kind: "agent", agentKey: "MUST_NOT_CROSS_AGENT" };
    quota.rawResponse = { authorization: "Bearer MUST_NOT_CROSS_BEARER" };
    (quota.windows as Array<Record<string, unknown>>)[0].message = "MUST_NOT_CROSS_MESSAGE";
    const diagnostic = (raw.diagnostics as Array<Record<string, unknown>>)[0];
    diagnostic.rawError = "MUST_NOT_CROSS_ERROR";

    const serialized = JSON.stringify(valid(raw));
    for (const forbidden of [
      "MUST_NOT_CROSS",
      "example.invalid",
      "/home/private",
      "authorization",
      "rawResponse",
      "rawError",
      "message",
      "attribution",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("keeps native agent scope and provider account scope structurally disjoint", () => {
    const providerWithAgentScope = cloneEnvelope();
    facts(providerWithAgentScope)[1].scope = { kind: "agent", workspaceKey: "ws", agentKey: "agent" };
    invalid(providerWithAgentScope, "INVALID_FACT", "$.facts[1].scope.kind");

    const nativeWithProviderScope = cloneEnvelope();
    facts(nativeWithProviderScope)[0].scope = {
      kind: "provider-account",
      provider: "codex",
      key: "ps_0000000000000001",
    };
    invalid(nativeWithProviderScope, "INVALID_FACT", "$.facts[0].scope.kind");
  });

  it("rejects raw account identifiers instead of accepting them as opaque provider scope keys", () => {
    const raw = cloneEnvelope();
    (facts(raw)[1].scope as Record<string, unknown>).key = "customer@example.invalid";
    invalid(raw, "INVALID_FACT", "$.facts[1].scope.key");
  });

  it.each([
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [-0.01, "negative"],
    [100.01, "over-100"],
  ])("rejects invalid quota percentage %s (%s)", (usedPercent) => {
    const raw = cloneEnvelope();
    (facts(raw)[1].windows as Array<Record<string, unknown>>)[0].usedPercent = usedPercent;
    invalid(raw, "INVALID_FACT", "$.facts[1].windows[0].usedPercent");
  });

  it.each([
    "not-a-time",
    "2026-02-31T12:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-07-14T18:00:00+00:00",
  ])("rejects invalid or non-canonical timestamp %s", (observedAt) => {
    const raw = cloneEnvelope();
    facts(raw)[1].observedAt = observedAt;
    invalid(raw, "INVALID_FACT", "$.facts[1].observedAt");
  });

  it("rejects unknown required enums but ignores unknown additive fields", () => {
    const unknownProvider = cloneEnvelope();
    (facts(unknownProvider)[1].scope as Record<string, unknown>).provider = "future-provider";
    invalid(unknownProvider, "INVALID_FACT", "$.facts[1].scope.provider");

    const unknownSource = cloneEnvelope();
    facts(unknownSource)[1].source = "browser-cookie";
    invalid(unknownSource, "INVALID_FACT", "$.facts[1].source");

    const unknownKind = cloneEnvelope();
    facts(unknownKind)[1].kind = "provider-everything";
    invalid(unknownKind, "INVALID_FACT", "$.facts[1].kind");
  });

  it("rejects zero-only or negative native token facts instead of fabricating available usage", () => {
    const zero = cloneEnvelope();
    Object.assign(facts(zero)[0], {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    invalid(zero, "INVALID_FACT", "$.facts[0]");

    const negative = cloneEnvelope();
    facts(negative)[0].inputTokens = -1;
    invalid(negative, "INVALID_FACT", "$.facts[0].inputTokens");
  });

  it("rejects duplicate or oversized quota windows", () => {
    const duplicate = cloneEnvelope();
    const quota = facts(duplicate)[1];
    quota.windows = [
      ...(quota.windows as unknown[]),
      { name: "weekly", usedPercent: 10 },
    ];
    invalid(duplicate, "INVALID_FACT", "$.facts[1].windows");

    const oversized = cloneEnvelope();
    facts(oversized)[1].windows = [
      { name: "session", usedPercent: 1 },
      { name: "weekly", usedPercent: 2 },
      { name: "tertiary", usedPercent: 3 },
      { name: "session", usedPercent: 4 },
    ];
    invalid(oversized, "INVALID_FACT", "$.facts[1].windows");
  });

  it("rejects future last-good timestamps and stale-expired facts without provenance", () => {
    const futureLastGood = cloneEnvelope();
    facts(futureLastGood)[1].freshness = { state: "stale", lastGoodAt: "2026-07-14T18:00:01Z" };
    invalid(futureLastGood, "INVALID_FACT", "$.facts[1].freshness.lastGoodAt");

    const missingLastGood = cloneEnvelope();
    Object.assign(facts(missingLastGood)[2], { reason: "stale-expired" });
    invalid(missingLastGood, "INVALID_FACT", "$.facts[2].lastGoodAt");
  });

  it("bounds facts, diagnostics, and collector strings", () => {
    const tooManyFacts = cloneEnvelope();
    tooManyFacts.facts = Array.from({ length: 513 }, () => structuredClone(facts(cloneEnvelope())[0]));
    invalid(tooManyFacts, "TOO_MANY_FACTS", "$.facts");

    const tooManyDiagnostics = cloneEnvelope();
    tooManyDiagnostics.diagnostics = Array.from({ length: 65 }, () => ({ code: "INVALID_PAYLOAD" }));
    invalid(tooManyDiagnostics, "INVALID_DIAGNOSTIC", "$.diagnostics");

    const oversizedVersion = cloneEnvelope();
    (oversizedVersion.collector as Record<string, unknown>).version = "v".repeat(65);
    invalid(oversizedVersion, "INVALID_COLLECTOR", "$.collector.version");
  });

  it("rejects sparse arrays instead of projecting holes as typed facts", () => {
    const sparseFacts = cloneEnvelope();
    sparseFacts.facts = new Array(1);
    invalid(sparseFacts, "INVALID_FACT", "$.facts[0]");

    const sparseDiagnostics = cloneEnvelope();
    sparseDiagnostics.diagnostics = new Array(1);
    invalid(sparseDiagnostics, "INVALID_DIAGNOSTIC", "$.diagnostics[0]");
  });

  it("fails closed on an unsupported schema without copying raw data into its issue", () => {
    const raw = cloneEnvelope();
    raw.schemaVersion = 99;
    raw.secret = "MUST_NOT_CROSS_SCHEMA_SECRET";
    const result = invalid(raw, "UNSUPPORTED_SCHEMA", "$.schemaVersion");
    expect(result.unavailable.reason).toBe("unsupported-schema");
    expect(JSON.stringify(result)).not.toContain("MUST_NOT_CROSS_SCHEMA_SECRET");
  });

  it("returns a bounded unavailable result instead of throwing on hostile object access", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("MUST_NOT_CROSS_PROXY_ERROR"); } });
    const result = invalid(hostile, "INVALID_ENVELOPE", "$.");
    expect(JSON.stringify(result)).not.toContain("MUST_NOT_CROSS_PROXY_ERROR");
  });

  it("reads allowlisted fields once so hostile getters cannot swap values after validation", () => {
    const raw = cloneEnvelope();
    let semanticsReads = 0;
    Object.defineProperty(facts(raw)[0], "semantics", {
      enumerable: true,
      get: () => {
        semanticsReads += 1;
        return semanticsReads === 1 ? "latest-cumulative" : "MUST_NOT_CROSS_SWAPPED_VALUE";
      },
    });
    Object.defineProperty(raw, "ignoredGetter", {
      enumerable: true,
      get: () => { throw new Error("MUST_NOT_CROSS_IGNORED_GETTER"); },
    });

    const envelope = valid(raw);
    expect(envelope.facts[0]).toMatchObject({ semantics: "latest-cumulative" });
    expect(semanticsReads).toBe(1);
    expect(JSON.stringify(envelope)).not.toContain("MUST_NOT_CROSS");
  });

  it("rejects empty or chronologically impossible envelopes", () => {
    const empty = cloneEnvelope();
    empty.facts = [];
    invalid(empty, "INVALID_ENVELOPE", "$.facts");

    const futureObservation = cloneEnvelope();
    facts(futureObservation)[0].observedAt = "2026-07-14T18:00:01Z";
    invalid(futureObservation, "INVALID_FACT", "$.facts[0].observedAt");
  });
});
