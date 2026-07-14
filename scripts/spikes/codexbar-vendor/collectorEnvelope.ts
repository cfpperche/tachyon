export type SpikeProvider = "codex" | "claude";

export interface SpikeQuotaWindowV1 {
  name: "session" | "weekly" | "tertiary";
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
}

export type SpikeCollectorFactV1 =
  | {
      kind: "provider-quota";
      provider: SpikeProvider;
      source: "oauth" | "cli";
      confidence: "exact" | "estimated" | "unknown";
      observedAt: string;
      windows: SpikeQuotaWindowV1[];
    }
  | {
      kind: "provider-unavailable";
      provider: SpikeProvider;
      reason: "upstream-error" | "invalid-payload" | "no-quota-windows";
    };

export interface SpikeCollectorEnvelopeV1 {
  schemaVersion: 1;
  engine: {
    name: "codexbar";
    version: string;
    upstreamTag: string;
    upstreamCommit: string;
  };
  generatedAt: string;
  facts: SpikeCollectorFactV1[];
  diagnostics: Array<{ provider: SpikeProvider; code: "UPSTREAM_ERROR" | "INVALID_PAYLOAD" | "NO_WINDOWS" }>;
}

export interface SpikeEnvelopeOptions {
  engineVersion: string;
  upstreamTag: string;
  upstreamCommit: string;
  generatedAt: string;
}

const SOURCES = new Set(["oauth", "cli"]);
const PROVIDERS = new Set(["codex", "claude"]);

export function projectCodexBarPayload(raw: unknown, options: SpikeEnvelopeOptions): SpikeCollectorEnvelopeV1 {
  const envelope: SpikeCollectorEnvelopeV1 = {
    schemaVersion: 1,
    engine: {
      name: "codexbar",
      version: bounded(options.engineVersion, 64, "engine version"),
      upstreamTag: bounded(options.upstreamTag, 64, "upstream tag"),
      upstreamCommit: bounded(options.upstreamCommit, 64, "upstream commit"),
    },
    generatedAt: iso(options.generatedAt, "generatedAt"),
    facts: [],
    diagnostics: [],
  };

  const records = Array.isArray(raw) ? raw : [raw];
  if (records.length === 0 || records.length > 2) throw new Error("expected one bounded record per supported provider");
  const seenProviders = new Set<string>();
  for (const record of records) {
    if (object(record) && typeof record.provider === "string") {
      if (seenProviders.has(record.provider)) throw new Error("duplicate provider record");
      seenProviders.add(record.provider);
    }
    projectRecord(record, envelope);
  }
  return envelope;
}

function projectRecord(raw: unknown, envelope: SpikeCollectorEnvelopeV1): void {
  if (!object(raw) || typeof raw.provider !== "string" || !PROVIDERS.has(raw.provider)) {
    throw new Error("unsupported or missing provider");
  }
  const provider = raw.provider as SpikeProvider;
  if (object(raw.error)) {
    unavailable(envelope, provider, "upstream-error", "UPSTREAM_ERROR");
    return;
  }
  try {
    if (typeof raw.source !== "string" || !SOURCES.has(raw.source)) throw new Error("invalid source");
    const usage = raw.usage;
    if (!object(usage)) throw new Error("missing usage");
    const observedAt = iso(usage.updatedAt, "usage.updatedAt");
    const windows = (["primary", "secondary", "tertiary"] as const).flatMap((key, index) => {
      const value = usage[key];
      if (value === null || value === undefined) return [];
      return [quotaWindow(value, ["session", "weekly", "tertiary"][index] as SpikeQuotaWindowV1["name"])];
    });
    if (windows.length === 0) {
      unavailable(envelope, provider, "no-quota-windows", "NO_WINDOWS");
      return;
    }
    const confidence = usage.dataConfidence === "exact"
      ? "exact"
      : usage.dataConfidence === "estimated" ? "estimated" : "unknown";
    envelope.facts.push({
      kind: "provider-quota",
      provider,
      source: raw.source as Extract<SpikeCollectorFactV1, { kind: "provider-quota" }>["source"],
      confidence,
      observedAt,
      windows,
    });
  } catch {
    unavailable(envelope, provider, "invalid-payload", "INVALID_PAYLOAD");
  }
}

function quotaWindow(raw: unknown, name: SpikeQuotaWindowV1["name"]): SpikeQuotaWindowV1 {
  if (!object(raw) || typeof raw.usedPercent !== "number" || !Number.isFinite(raw.usedPercent) || raw.usedPercent < 0 || raw.usedPercent > 100) {
    throw new Error("invalid usedPercent");
  }
  const result: SpikeQuotaWindowV1 = { name, usedPercent: raw.usedPercent };
  if (raw.windowMinutes !== undefined) {
    if (!Number.isInteger(raw.windowMinutes) || (raw.windowMinutes as number) <= 0 || (raw.windowMinutes as number) > 525_600) {
      throw new Error("invalid windowMinutes");
    }
    result.windowMinutes = raw.windowMinutes as number;
  }
  if (raw.resetsAt !== undefined && raw.resetsAt !== null) result.resetsAt = iso(raw.resetsAt, "resetsAt");
  return result;
}

function unavailable(
  envelope: SpikeCollectorEnvelopeV1,
  provider: SpikeProvider,
  reason: Extract<SpikeCollectorFactV1, { kind: "provider-unavailable" }>["reason"],
  code: SpikeCollectorEnvelopeV1["diagnostics"][number]["code"],
): void {
  envelope.facts.push({ kind: "provider-unavailable", provider, reason });
  envelope.diagnostics.push({ provider, code });
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function iso(value: unknown, label: string): string {
  const text = bounded(value, 64, label);
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,3}))?Z$/u.exec(text);
  if (!match) throw new Error(`invalid ${label}`);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new Error(`invalid ${label}`);
  const canonicalInput = `${text.replace(/(?:\.\d{1,3})?Z$/u, "")}.${(match[1] ?? "").padEnd(3, "0")}Z`;
  const normalized = new Date(time).toISOString();
  if (normalized !== canonicalInput) throw new Error(`invalid ${label}`);
  return normalized;
}
