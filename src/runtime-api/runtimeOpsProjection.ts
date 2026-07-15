import { z } from "zod";
import type {
  RuntimeOpsProviderCapacityV2,
  RuntimeOpsRuntimeV1,
  RuntimeOpsSnapshot,
  RuntimeOpsSnapshotV1,
  RuntimeOpsSnapshotV2,
} from "../runtimeOps/types.js";

const MAX_RUNTIMES = 64;
const MAX_WORKSPACES = 256;
const MAX_AGENTS = 1_000;
const text = (max: number, min = 0) => z.string().min(min).max(max);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = text(64, 1).refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const source = z.enum(["path", "session-ledger", "activity-log", "command", "runtime-profile"]);

const rateLimit = z.object({
  runtime: z.enum(["claude", "codex", "opencode"]).optional(),
  scope: z.enum(["5h", "weekly"]).optional(),
  resetAt: z.number().finite().positive().optional(),
}).strict();

const model = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("available"),
    value: z.enum([
      "Claude default",
      "Opus",
      "Opus 4.8",
      "Sonnet",
      "Sonnet 5",
      "Haiku",
      "Codex default",
      "GPT-5.1 Codex",
      "GPT-5 Codex",
      "Grok default",
    ]),
    source: z.enum(["command", "runtime-profile"]),
  }).strict(),
  z.object({ state: z.literal("unavailable") }).strict(),
]);

const observedModel = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("available"),
    value: text(64, 1).regex(/^[A-Za-z0-9 ._:/-]+$/),
    effort: text(64, 1).optional(),
    observedAt: timestamp.optional(),
    stale: z.boolean().optional(),
  }).strict(),
  z.object({ state: z.literal("unavailable") }).strict(),
]);

const contextPressure = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("available"),
    value: z.object({ used: count, limit: count.refine((value) => value > 0) }).strict(),
  }).strict(),
  z.object({ state: z.literal("unavailable") }).strict(),
]);

const agent = z.object({
  key: text(512, 1),
  name: text(128, 1),
  workspaceKey: text(128, 1),
  status: z.enum(["running", "stopping", "stop-failed", "stopped", "crashed"]),
  attention: z.object({
    state: z.enum(["working", "idle", "needs-input", "throttled", "unknown"]),
    stale: z.boolean(),
    rateLimit: rateLimit.optional(),
  }).strict().superRefine((value, context) => {
    if (value.rateLimit !== undefined && value.state !== "throttled") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "rate limit requires throttled attention" });
    }
  }),
  model,
  modelObserved: observedModel,
  modelDivergence: z.boolean(),
  resume: z.object({ state: z.enum(["live", "resumable", "fresh-start-only", "not-resumable"]) }).strict(),
  bridge: z.object({
    state: z.enum(["ok", "suspect", "rebinding", "failed", "not-wired", "unknown"]),
    currentGeneration: count.refine((value) => value > 0).optional(),
    boundGeneration: count.refine((value) => value > 0).optional(),
  }).strict(),
  contextPressure,
}).strict();

const usageValue = z.object({
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheCreationTokens: count,
  semantics: z.enum(["latest-cumulative", "summed-deltas"]),
}).strict();

const usage = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), value: usageValue, source: source, observedAt: timestamp.optional() }).strict(),
  z.object({ state: z.literal("unavailable") }).strict(),
]);

const stringValue = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), value: text(256, 1), source: source, observedAt: timestamp.optional() }).strict(),
  z.object({ state: z.literal("unavailable") }).strict(),
]);

const runtime = z.object({
  key: text(128, 1),
  runtime: text(64, 1),
  label: text(128, 1),
  availability: z.object({ pathDetected: z.boolean(), managed: z.boolean() }).strict(),
  usage,
  lastActivity: stringValue,
  version: stringValue,
  workspaces: z.array(z.object({ key: text(128, 1), label: text(256, 1) }).strict()).max(MAX_WORKSPACES),
  agents: z.array(agent).max(MAX_AGENTS),
}).strict().superRefine((value, context) => {
  if (value.key !== `runtime:${value.runtime}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "runtime key does not bind its runtime" });
  }
  if (value.availability.managed !== (value.agents.length > 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "managed availability contradicts agents" });
  }
  const workspaceKeys = value.workspaces.map((workspace) => workspace.key);
  if (new Set(workspaceKeys).size !== workspaceKeys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "runtime contains duplicate workspaces" });
  }
  const agentKeys = value.agents.map((entry) => entry.key);
  if (new Set(agentKeys).size !== agentKeys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "runtime contains duplicate agents" });
  }
  const workspaceSet = new Set(workspaceKeys);
  for (const entry of value.agents) {
    if (!workspaceSet.has(entry.workspaceKey) || entry.key !== `${entry.workspaceKey}:${entry.name}`) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "agent identity is not bound to its workspace" });
    }
  }
});

const providerSource = z.enum(["cli", "oauth"]);
const providerQuota = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("available"),
    source: providerSource,
    confidence: z.enum(["exact", "estimated", "unknown"]),
    observedAt: timestamp,
    freshness: z.discriminatedUnion("state", [
      z.object({ state: z.literal("fresh") }).strict(),
      z.object({ state: z.literal("stale"), lastGoodAt: timestamp }).strict(),
    ]),
    windows: z.array(z.object({
      name: z.enum(["session", "weekly", "tertiary"]),
      usedPercent: z.number().finite().min(0).max(100),
      windowMinutes: count.refine((value) => value > 0).optional(),
      resetsAt: timestamp.optional(),
    }).strict()).max(3),
  }).strict(),
  z.object({
    state: z.literal("unavailable"),
    source: providerSource.optional(),
    observedAt: timestamp,
    reason: z.enum([
      "unsupported", "source-disabled", "unauthenticated", "timeout", "cancelled",
      "not-observed", "provider-error", "invalid-payload", "stale-expired",
    ]),
    lastGoodAt: timestamp.optional(),
  }).strict(),
]);

const providerCapacity = z.object({
  provider: z.enum(["codex", "claude"]),
  scope: z.literal("provider-account"),
  configuration: z.discriminatedUnion("state", [
    z.object({ state: z.literal("disabled") }).strict(),
    z.object({ state: z.literal("enabled"), sources: z.array(providerSource).min(1).max(2) }).strict(),
  ]),
  quota: providerQuota,
}).strict().superRefine((value, context) => {
  if (value.configuration.state === "enabled"
    && new Set(value.configuration.sources).size !== value.configuration.sources.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "provider sources must be unique" });
  }
});

const snapshotV1 = z.object({
  schemaVersion: z.literal(1),
  generatedAt: timestamp,
  summary: z.object({
    runtimes: count,
    managedAgents: count,
    activeAgents: count.optional(),
    throttled: count.optional(),
    bridgeIssues: count.optional(),
  }).strict(),
  runtimes: z.array(runtime).max(MAX_RUNTIMES),
  error: z.object({ code: z.literal("snapshot-unavailable") }).strict().optional(),
}).strict().superRefine(validateSnapshotFacts);

const snapshotV2 = z.object({
  schemaVersion: z.literal(2),
  generatedAt: timestamp,
  summary: z.object({
    runtimes: count,
    managedAgents: count,
    activeAgents: count.optional(),
    throttled: count.optional(),
    bridgeIssues: count.optional(),
  }).strict(),
  runtimes: z.array(runtime).max(MAX_RUNTIMES),
  providerCapacity: z.array(providerCapacity).length(2),
  error: z.object({ code: z.literal("snapshot-unavailable") }).strict().optional(),
}).strict().superRefine((value, context) => {
  validateSnapshotFacts(value, context);
  const providers = value.providerCapacity.map((entry) => entry.provider);
  if (providers.length !== new Set(providers).size || !providers.includes("codex") || !providers.includes("claude")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "provider capacity must bind codex and claude exactly once" });
  }
});

const snapshot = z.union([snapshotV1, snapshotV2]);

function validateSnapshotFacts(
  value: { summary: RuntimeOpsSnapshotV1["summary"]; runtimes: RuntimeOpsRuntimeV1[] },
  context: z.RefinementCtx,
): void {
  if (value.summary.runtimes !== value.runtimes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "runtime summary count is contradictory" });
  }
  const runtimeKeys = value.runtimes.map((entry) => entry.key);
  const runtimeIds = value.runtimes.map((entry) => entry.runtime);
  if (new Set(runtimeKeys).size !== runtimeKeys.length || new Set(runtimeIds).size !== runtimeIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "snapshot contains duplicate runtimes" });
  }
  const agents = value.runtimes.flatMap((entry) => entry.agents);
  if (value.summary.managedAgents !== agents.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "managed-agent summary count is contradictory" });
  }
  const active = agents.filter((entry) => entry.status === "running" || entry.status === "stopping" || entry.status === "stop-failed").length;
  const throttled = agents.filter((entry) => entry.attention.state === "throttled").length;
  const bridgeIssues = agents.filter((entry) => entry.bridge.state !== "ok" && entry.bridge.state !== "not-wired").length;
  if (value.summary.activeAgents !== undefined && value.summary.activeAgents !== active
    || value.summary.throttled !== undefined && value.summary.throttled !== throttled
    || value.summary.bridgeIssues !== undefined && value.summary.bridgeIssues !== bridgeIssues) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "runtime agent summary is contradictory" });
  }
}

export function parseRuntimeOpsSnapshotV1(value: unknown): RuntimeOpsSnapshotV1 {
  return snapshotV1.parse(value) as RuntimeOpsSnapshotV1;
}

export function isRuntimeOpsSnapshotV1(value: unknown): value is RuntimeOpsSnapshotV1 {
  return snapshotV1.safeParse(value).success;
}

export function parseRuntimeOpsSnapshot(value: unknown): RuntimeOpsSnapshot {
  return snapshot.parse(value) as RuntimeOpsSnapshot;
}

export function isRuntimeOpsSnapshot(value: unknown): value is RuntimeOpsSnapshot {
  return snapshot.safeParse(value).success;
}

/** Combines independently authoritative per-workspace rows into the one fleet view owned by the editor. */
export function mergeRuntimeOpsSnapshotsV1(values: readonly RuntimeOpsSnapshot[]): RuntimeOpsSnapshot {
  const parsed = values.map(parseRuntimeOpsSnapshot);
  const runtimes = new Map<string, RuntimeOpsRuntimeV1[]>();
  for (const value of parsed) {
    for (const row of value.runtimes) {
      const rows = runtimes.get(row.runtime) ?? [];
      rows.push(row);
      runtimes.set(row.runtime, rows);
    }
  }
  const merged = [...runtimes.entries()]
    .map(([runtimeId, rows]) => mergeRuntime(runtimeId, rows))
    .sort((left, right) => left.label.localeCompare(right.label) || left.runtime.localeCompare(right.runtime));
  const agents = merged.flatMap((row) => row.agents);
  const base = {
    generatedAt: latestTimestamp(parsed.map((value) => value.generatedAt)) ?? new Date(0).toISOString(),
    summary: {
      runtimes: merged.length,
      managedAgents: agents.length,
      activeAgents: agents.filter((entry) => entry.status === "running" || entry.status === "stopping" || entry.status === "stop-failed").length,
      throttled: agents.filter((entry) => entry.attention.state === "throttled").length,
      bridgeIssues: agents.filter((entry) => entry.bridge.state !== "ok" && entry.bridge.state !== "not-wired").length,
    },
    runtimes: merged,
    ...(parsed.some((value) => value.error) ? { error: { code: "snapshot-unavailable" as const } } : {}),
  };
  const v2 = parsed.filter((value): value is RuntimeOpsSnapshotV2 => value.schemaVersion === 2);
  if (v2.length === 0) return parseRuntimeOpsSnapshotV1({ schemaVersion: 1, ...base });
  const providerCapacity = mergeProviderCapacity(v2);
  return parseRuntimeOpsSnapshot({ schemaVersion: 2, ...base, providerCapacity });
}

function mergeProviderCapacity(values: readonly RuntimeOpsSnapshotV2[]): RuntimeOpsProviderCapacityV2[] {
  return (["codex", "claude"] as const).map((provider) => {
    const entries = values.map((value) => value.providerCapacity.find((entry) => entry.provider === provider)!);
    const configurations = new Set(entries.map((entry) => JSON.stringify(entry.configuration)));
    if (configurations.size !== 1) throw new Error(`Runtime Ops provider configuration disagrees for '${provider}'`);
    return [...entries].sort((left, right) => left.quota.observedAt.localeCompare(right.quota.observedAt)).at(-1)!;
  });
}

function mergeRuntime(runtimeId: string, rows: RuntimeOpsRuntimeV1[]): RuntimeOpsRuntimeV1 {
  const agents = rows.flatMap((row) => row.agents)
    .sort((left, right) => left.workspaceKey.localeCompare(right.workspaceKey) || left.name.localeCompare(right.name));
  const workspaceMap = new Map(rows.flatMap((row) => row.workspaces).map((workspace) => [workspace.key, workspace]));
  const availableUsage = rows.flatMap((row) => row.usage.state === "available" ? [row.usage] : []);
  const usageSemantics = availableUsage[0]?.value.semantics;
  if (availableUsage.some((entry) => entry.value.semantics !== usageSemantics)) {
    throw new Error(`Runtime Ops usage semantics disagree for '${runtimeId}'`);
  }
  const lastActivity = newestAvailable(rows.map((row) => row.lastActivity));
  const version = newestAvailable(rows.map((row) => row.version));
  return {
    key: `runtime:${runtimeId}`,
    runtime: runtimeId,
    label: rows[0]?.label ?? runtimeId,
    availability: {
      pathDetected: rows.some((row) => row.availability.pathDetected),
      managed: agents.length > 0,
    },
    usage: availableUsage.length === 0 ? { state: "unavailable" } : {
      state: "available",
      source: "activity-log",
      ...(latestTimestamp(availableUsage.map((entry) => entry.observedAt).filter((value): value is string => value !== undefined))
        ? { observedAt: latestTimestamp(availableUsage.map((entry) => entry.observedAt).filter((value): value is string => value !== undefined)) }
        : {}),
      value: {
        inputTokens: availableUsage.reduce((sum, entry) => sum + entry.value.inputTokens, 0),
        outputTokens: availableUsage.reduce((sum, entry) => sum + entry.value.outputTokens, 0),
        cacheReadTokens: availableUsage.reduce((sum, entry) => sum + entry.value.cacheReadTokens, 0),
        cacheCreationTokens: availableUsage.reduce((sum, entry) => sum + entry.value.cacheCreationTokens, 0),
        semantics: usageSemantics!,
      },
    },
    lastActivity,
    version,
    workspaces: [...workspaceMap.values()].sort((left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key)),
    agents,
  };
}

function newestAvailable(
  values: RuntimeOpsRuntimeV1["lastActivity"][],
): RuntimeOpsRuntimeV1["lastActivity"] {
  return values
    .filter((value): value is Extract<typeof value, { state: "available" }> => value.state === "available")
    .sort((left, right) => (left.observedAt ?? left.value).localeCompare(right.observedAt ?? right.value))
    .at(-1) ?? { state: "unavailable" };
}

function latestTimestamp(values: readonly string[]): string | undefined {
  return [...values].sort().at(-1);
}
