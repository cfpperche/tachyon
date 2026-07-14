import {
  RUNTIME_OBSERVABILITY_SCHEMA_VERSION,
  type AgentObservationScopeV1,
  type CollectorDiagnosticCodeV1,
  type CollectorDiagnosticV1,
  type CollectorEnvelopeV1,
  type CollectorIdentityV1,
  type NativeUsageFactV1,
  type ObservationConfidenceV1,
  type ObservationFreshnessV1,
  type ProviderAccountObservationScopeV1,
  type ProviderObservationScopeV1,
  type ProviderQuotaFactV1,
  type ProviderQuotaWindowV1,
  type ProviderSourceKindV1,
  type ProviderUnavailableFactV1,
  type ProviderUnavailableReasonV1,
  type RuntimeObservationFactV1,
  type RuntimeObservabilityProviderV1,
} from "./types.js";

const MAX_FACTS = 512;
const MAX_DIAGNOSTICS = 64;
const MAX_WINDOWS = 3;
const MAX_WINDOW_MINUTES = 525_600;

const PROVIDERS: ReadonlySet<string> = new Set<RuntimeObservabilityProviderV1>(["codex", "claude"]);
const PROVIDER_SOURCES: ReadonlySet<string> = new Set<ProviderSourceKindV1>(["oauth", "cli"]);
const CONFIDENCE: ReadonlySet<string> = new Set<ObservationConfidenceV1>(["exact", "estimated", "unknown"]);
const WINDOW_NAMES: ReadonlySet<string> = new Set<ProviderQuotaWindowV1["name"]>(["session", "weekly", "tertiary"]);
const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set<ProviderUnavailableReasonV1>([
  "unsupported",
  "source-disabled",
  "unauthenticated",
  "timeout",
  "cancelled",
  "provider-error",
  "invalid-payload",
  "stale-expired",
]);
const DIAGNOSTIC_CODES: ReadonlySet<string> = new Set<CollectorDiagnosticCodeV1>([
  "SOURCE_UNAVAILABLE",
  "SOURCE_TIMEOUT",
  "SOURCE_CANCELLED",
  "INVALID_PAYLOAD",
  "STALE_LAST_GOOD",
]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_RUNTIME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SAFE_COLLECTOR_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const SAFE_PROVIDER_SCOPE_KEY = /^ps_[0-9a-f]{16,64}$/u;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,3}))?Z$/u;

export type CollectorValidationIssueCode =
  | "INVALID_ENVELOPE"
  | "UNSUPPORTED_SCHEMA"
  | "INVALID_COLLECTOR"
  | "TOO_MANY_FACTS"
  | "INVALID_FACT"
  | "INVALID_DIAGNOSTIC";

export interface CollectorValidationIssueV1 {
  code: CollectorValidationIssueCode;
  /** Validator-owned structural path. It never contains an input value. */
  path: string;
}

export type CollectorEnvelopeValidationResult =
  | { ok: true; value: CollectorEnvelopeV1 }
  | {
      ok: false;
      unavailable: {
        state: "unavailable";
        reason: "invalid-envelope" | "unsupported-schema";
        issues: CollectorValidationIssueV1[];
      };
    };

class ValidationFailure {
  constructor(
    readonly code: CollectorValidationIssueCode,
    readonly path: string,
  ) {}
}

/**
 * Validate and project an untrusted collector payload into a fresh allowlisted object graph.
 * Unknown additive fields are ignored; malformed required facts reject the whole envelope so callers can retain an
 * independently governed last-good value instead of mixing valid and attacker-controlled partial data.
 */
export function validateCollectorEnvelopeV1(raw: unknown): CollectorEnvelopeValidationResult {
  try {
    return { ok: true, value: parseEnvelope(raw) };
  } catch (error) {
    const failure = error instanceof ValidationFailure
      ? error
      : new ValidationFailure("INVALID_ENVELOPE", "$.");
    return {
      ok: false,
      unavailable: {
        state: "unavailable",
        reason: failure.code === "UNSUPPORTED_SCHEMA" ? "unsupported-schema" : "invalid-envelope",
        issues: [{ code: failure.code, path: failure.path }],
      },
    };
  }
}

function parseEnvelope(raw: unknown): CollectorEnvelopeV1 {
  const value = record(raw, "$", "INVALID_ENVELOPE");
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== RUNTIME_OBSERVABILITY_SCHEMA_VERSION) fail("UNSUPPORTED_SCHEMA", "$.schemaVersion");
  const generatedAt = timestamp(value.generatedAt, "$.generatedAt", "INVALID_ENVELOPE");
  const collector = parseCollector(value.collector);
  const rawFacts = array(
    value.facts,
    "$.facts",
    MAX_FACTS,
    "INVALID_ENVELOPE",
    1,
    "TOO_MANY_FACTS",
    "INVALID_FACT",
  );
  const facts = rawFacts.map((fact, index) => {
    const parsed = parseFact(fact, `$.facts[${index}]`);
    if (Date.parse(parsed.observedAt) > Date.parse(generatedAt)) {
      fail("INVALID_FACT", `$.facts[${index}].observedAt`);
    }
    return parsed;
  });
  const rawDiagnostics = array(value.diagnostics, "$.diagnostics", MAX_DIAGNOSTICS, "INVALID_DIAGNOSTIC");
  const diagnostics = rawDiagnostics.map((diagnostic, index) => (
    parseDiagnostic(diagnostic, `$.diagnostics[${index}]`, facts.length)
  ));
  return {
    schemaVersion: RUNTIME_OBSERVABILITY_SCHEMA_VERSION,
    collector,
    generatedAt,
    facts,
    diagnostics,
  };
}

function parseCollector(raw: unknown): CollectorIdentityV1 {
  const value = record(raw, "$.collector", "INVALID_COLLECTOR");
  return {
    id: patternedString(value.id, "$.collector.id", 64, SAFE_COLLECTOR_ID, "INVALID_COLLECTOR"),
    version: patternedString(value.version, "$.collector.version", 64, SAFE_VERSION, "INVALID_COLLECTOR"),
  };
}

function parseFact(raw: unknown, path: string): RuntimeObservationFactV1 {
  const value = record(raw, path, "INVALID_FACT");
  switch (value.kind) {
    case "native-usage": return parseNativeUsage(value, path);
    case "provider-quota": return parseProviderQuota(value, path);
    case "provider-unavailable": return parseProviderUnavailable(value, path);
    default: return fail("INVALID_FACT", `${path}.kind`);
  }
}

function parseNativeUsage(value: Record<string, unknown>, path: string): NativeUsageFactV1 {
  const inputTokens = tokenCount(value.inputTokens, `${path}.inputTokens`);
  const outputTokens = tokenCount(value.outputTokens, `${path}.outputTokens`);
  const cacheReadTokens = tokenCount(value.cacheReadTokens, `${path}.cacheReadTokens`);
  const cacheCreationTokens = tokenCount(value.cacheCreationTokens, `${path}.cacheCreationTokens`);
  if (![inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens].some((count) => count > 0)) {
    fail("INVALID_FACT", path);
  }
  const source = value.source;
  const semantics = value.semantics;
  if (source !== "activity-log") fail("INVALID_FACT", `${path}.source`);
  if (semantics !== "latest-cumulative" && semantics !== "summed-deltas") {
    fail("INVALID_FACT", `${path}.semantics`);
  }
  return {
    kind: "native-usage",
    scope: parseAgentScope(value.scope, `${path}.scope`),
    runtime: patternedString(value.runtime, `${path}.runtime`, 64, SAFE_RUNTIME, "INVALID_FACT"),
    source: "activity-log",
    observedAt: timestamp(value.observedAt, `${path}.observedAt`, "INVALID_FACT"),
    semantics,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}

function parseProviderQuota(value: Record<string, unknown>, path: string): ProviderQuotaFactV1 {
  const observedAt = timestamp(value.observedAt, `${path}.observedAt`, "INVALID_FACT");
  const rawWindows = array(value.windows, `${path}.windows`, MAX_WINDOWS, "INVALID_FACT", 1);
  const windows = rawWindows.map((window, index) => parseQuotaWindow(window, `${path}.windows[${index}]`));
  if (new Set(windows.map((window) => window.name)).size !== windows.length) {
    fail("INVALID_FACT", `${path}.windows`);
  }
  return {
    kind: "provider-quota",
    scope: parseProviderAccountScope(value.scope, `${path}.scope`),
    source: providerSource(value.source, `${path}.source`),
    confidence: confidence(value.confidence, `${path}.confidence`),
    observedAt,
    freshness: parseFreshness(value.freshness, `${path}.freshness`, observedAt),
    windows,
  };
}

function parseProviderUnavailable(value: Record<string, unknown>, path: string): ProviderUnavailableFactV1 {
  const observedAt = timestamp(value.observedAt, `${path}.observedAt`, "INVALID_FACT");
  const reason = value.reason;
  const source = value.source;
  const rawLastGoodAt = value.lastGoodAt;
  if (typeof reason !== "string" || !UNAVAILABLE_REASONS.has(reason)) {
    fail("INVALID_FACT", `${path}.reason`);
  }
  const fact: ProviderUnavailableFactV1 = {
    kind: "provider-unavailable",
    scope: parseProviderScope(value.scope, `${path}.scope`),
    observedAt,
    reason: reason as ProviderUnavailableReasonV1,
  };
  if (source !== undefined) fact.source = providerSource(source, `${path}.source`);
  if (rawLastGoodAt !== undefined) {
    fact.lastGoodAt = timestamp(rawLastGoodAt, `${path}.lastGoodAt`, "INVALID_FACT");
    if (Date.parse(fact.lastGoodAt) > Date.parse(observedAt)) fail("INVALID_FACT", `${path}.lastGoodAt`);
  }
  if (fact.reason === "stale-expired" && fact.lastGoodAt === undefined) fail("INVALID_FACT", `${path}.lastGoodAt`);
  return fact;
}

function parseAgentScope(raw: unknown, path: string): AgentObservationScopeV1 {
  const value = record(raw, path, "INVALID_FACT");
  const kind = value.kind;
  if (kind !== "agent") fail("INVALID_FACT", `${path}.kind`);
  return {
    kind: "agent",
    workspaceKey: patternedString(value.workspaceKey, `${path}.workspaceKey`, 128, SAFE_ID, "INVALID_FACT"),
    agentKey: patternedString(value.agentKey, `${path}.agentKey`, 128, SAFE_ID, "INVALID_FACT"),
  };
}

function parseProviderScope(
  raw: unknown,
  path: string,
): ProviderObservationScopeV1 | ProviderAccountObservationScopeV1 {
  const value = record(raw, path, "INVALID_FACT");
  const kind = value.kind;
  if (kind === "provider") {
    return { kind: "provider", provider: provider(value.provider, `${path}.provider`) };
  }
  if (kind === "provider-account") return projectProviderAccountScope(value, path);
  return fail("INVALID_FACT", `${path}.kind`);
}

function parseProviderAccountScope(raw: unknown, path: string): ProviderAccountObservationScopeV1 {
  const value = record(raw, path, "INVALID_FACT");
  const kind = value.kind;
  if (kind !== "provider-account") fail("INVALID_FACT", `${path}.kind`);
  return projectProviderAccountScope(value, path);
}

function projectProviderAccountScope(
  value: Record<string, unknown>,
  path: string,
): ProviderAccountObservationScopeV1 {
  return {
    kind: "provider-account",
    provider: provider(value.provider, `${path}.provider`),
    key: patternedString(value.key, `${path}.key`, 67, SAFE_PROVIDER_SCOPE_KEY, "INVALID_FACT"),
  };
}

function parseFreshness(raw: unknown, path: string, observedAt: string): ObservationFreshnessV1 {
  const value = record(raw, path, "INVALID_FACT");
  const state = value.state;
  if (state === "fresh") return { state: "fresh" };
  if (state !== "stale") fail("INVALID_FACT", `${path}.state`);
  const lastGoodAt = timestamp(value.lastGoodAt, `${path}.lastGoodAt`, "INVALID_FACT");
  if (Date.parse(lastGoodAt) > Date.parse(observedAt)) fail("INVALID_FACT", `${path}.lastGoodAt`);
  return { state: "stale", lastGoodAt };
}

function parseQuotaWindow(raw: unknown, path: string): ProviderQuotaWindowV1 {
  const value = record(raw, path, "INVALID_FACT");
  const name = value.name;
  const usedPercent = value.usedPercent;
  if (typeof name !== "string" || !WINDOW_NAMES.has(name)) fail("INVALID_FACT", `${path}.name`);
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)
    || usedPercent < 0 || usedPercent > 100) {
    fail("INVALID_FACT", `${path}.usedPercent`);
  }
  const window: ProviderQuotaWindowV1 = {
    name: name as ProviderQuotaWindowV1["name"],
    usedPercent,
  };
  const rawWindowMinutes = value.windowMinutes;
  const rawResetsAt = value.resetsAt;
  if (rawWindowMinutes !== undefined) {
    window.windowMinutes = positiveSafeInteger(
      rawWindowMinutes,
      `${path}.windowMinutes`,
      "INVALID_FACT",
      MAX_WINDOW_MINUTES,
    );
  }
  if (rawResetsAt !== undefined) {
    window.resetsAt = timestamp(rawResetsAt, `${path}.resetsAt`, "INVALID_FACT");
  }
  return window;
}

function parseDiagnostic(raw: unknown, path: string, factCount: number): CollectorDiagnosticV1 {
  const value = record(raw, path, "INVALID_DIAGNOSTIC");
  const code = value.code;
  const rawProvider = value.provider;
  const rawFactIndex = value.factIndex;
  if (typeof code !== "string" || !DIAGNOSTIC_CODES.has(code)) {
    fail("INVALID_DIAGNOSTIC", `${path}.code`);
  }
  const diagnostic: CollectorDiagnosticV1 = { code: code as CollectorDiagnosticCodeV1 };
  if (rawProvider !== undefined) {
    diagnostic.provider = provider(rawProvider, `${path}.provider`, "INVALID_DIAGNOSTIC");
  }
  if (rawFactIndex !== undefined) {
    const factIndex = nonNegativeSafeInteger(rawFactIndex, `${path}.factIndex`, "INVALID_DIAGNOSTIC");
    if (factIndex >= factCount) fail("INVALID_DIAGNOSTIC", `${path}.factIndex`);
    diagnostic.factIndex = factIndex;
  }
  return diagnostic;
}

function provider(raw: unknown, path: string, code: CollectorValidationIssueCode = "INVALID_FACT"): RuntimeObservabilityProviderV1 {
  if (typeof raw !== "string" || !PROVIDERS.has(raw)) fail(code, path);
  return raw as RuntimeObservabilityProviderV1;
}

function providerSource(raw: unknown, path: string): ProviderSourceKindV1 {
  if (typeof raw !== "string" || !PROVIDER_SOURCES.has(raw)) fail("INVALID_FACT", path);
  return raw as ProviderSourceKindV1;
}

function confidence(raw: unknown, path: string): ObservationConfidenceV1 {
  if (typeof raw !== "string" || !CONFIDENCE.has(raw)) fail("INVALID_FACT", path);
  return raw as ObservationConfidenceV1;
}

function tokenCount(raw: unknown, path: string): number {
  return nonNegativeSafeInteger(raw, path, "INVALID_FACT");
}

function timestamp(raw: unknown, path: string, code: CollectorValidationIssueCode): string {
  const text = boundedString(raw, path, 64, code);
  const match = RFC3339_UTC.exec(text);
  if (!match) fail(code, path);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) fail(code, path);
  const canonicalInput = `${text.replace(/(?:\.\d{1,3})?Z$/u, "")}.${(match[1] ?? "").padEnd(3, "0")}Z`;
  const normalized = new Date(time).toISOString();
  if (normalized !== canonicalInput) fail(code, path);
  return normalized;
}

function patternedString(
  raw: unknown,
  path: string,
  maxLength: number,
  pattern: RegExp,
  code: CollectorValidationIssueCode,
): string {
  const value = boundedString(raw, path, maxLength, code);
  if (!pattern.test(value)) fail(code, path);
  return value;
}

function boundedString(raw: unknown, path: string, maxLength: number, code: CollectorValidationIssueCode): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(raw)) {
    fail(code, path);
  }
  return raw;
}

function positiveSafeInteger(
  raw: unknown,
  path: string,
  code: CollectorValidationIssueCode,
  max: number,
): number {
  const value = nonNegativeSafeInteger(raw, path, code);
  if (value === 0 || value > max) fail(code, path);
  return value;
}

function nonNegativeSafeInteger(raw: unknown, path: string, code: CollectorValidationIssueCode): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) fail(code, path);
  return raw;
}

function array(
  raw: unknown,
  path: string,
  maxLength: number,
  code: CollectorValidationIssueCode,
  minLength = 0,
  tooLongCode: CollectorValidationIssueCode = code,
  elementCode: CollectorValidationIssueCode = code,
): unknown[] {
  if (!Array.isArray(raw)) fail(code, path);
  const length = raw.length;
  if (!Number.isSafeInteger(length) || length < minLength) fail(code, path);
  if (length > maxLength) fail(tooLongCode, path);
  const dense: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(raw, index)) fail(elementCode, `${path}[${index}]`);
    dense.push(raw[index]);
  }
  return dense;
}

function record(raw: unknown, path: string, code: CollectorValidationIssueCode): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(code, path);
  return raw as Record<string, unknown>;
}

function fail(code: CollectorValidationIssueCode, path: string): never {
  throw new ValidationFailure(code, path);
}
