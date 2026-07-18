import { runtimeLabel, runtimeUsageSemantics, type RuntimeUsageSource } from "../runtimeUsage/model.js";
import type {
  RuntimeOpsAgentRefV1,
  RuntimeOpsContextPressureV1,
  RuntimeOpsModelLabel,
  RuntimeOpsModelV1,
  RuntimeOpsObservedModelV1,
  RuntimeOpsRateLimitV1,
  RuntimeOpsRuntimeV1,
  RuntimeOpsSnapshotV2,
  RuntimeOpsThrottleRuntime,
  RuntimeOpsThrottleScope,
  RuntimeOpsUsageV1,
} from "./types.js";
import { projectRuntimeOpsProviderCapacity } from "./providerProjection.js";

export interface RuntimeOpsAttentionInput {
  state: RuntimeOpsAgentRefV1["attention"]["state"];
  stale: boolean;
  /** Raw terminal text may accompany host attention records; projection must discard it. */
  matchedLine?: unknown;
  rateLimit?: {
    runtime?: unknown;
    scope?: unknown;
    resetAt?: unknown;
    message?: unknown;
  };
}

export interface RuntimeOpsModelInput {
  state: "available" | "unavailable";
  value?: unknown;
  source?: unknown;
  reason?: unknown;
}

/** spec 378 — host input for the observed model fact (see `RuntimeOpsObservedModelV1`). */
export interface RuntimeOpsObservedModelInput {
  state: "available" | "unavailable";
  value?: unknown;
  effort?: unknown;
  observedAt?: unknown;
  stale?: unknown;
}

export interface RuntimeOpsResumeInput {
  state?: unknown;
  reason?: unknown;
}

export interface RuntimeOpsContextPressureInput {
  state: "available" | "unavailable";
  value?: { used?: unknown; limit?: unknown };
  reason?: unknown;
}

export interface RuntimeOpsAgentInput {
  workspaceKey: string;
  workspaceLabel: string;
  agentName: string;
  runtime: string;
  usage?: RuntimeUsageSource;
  lastActivity?: string;
  runtimeVersion?: string;
  versionObservedAt?: string;
  status?: RuntimeOpsAgentRefV1["status"];
  attention?: RuntimeOpsAttentionInput;
  model?: RuntimeOpsModelInput;
  modelObserved?: RuntimeOpsObservedModelInput;
  modelDivergence?: unknown;
  resume?: RuntimeOpsResumeInput;
  bridge?: RuntimeOpsBridgeHealthInput;
  contextPressure?: RuntimeOpsContextPressureInput;
}

export interface RuntimeOpsBridgeHealthInput {
  currentGeneration: number;
  boundGeneration: number;
  wired: boolean;
  clientState?: "ok" | "suspect" | "rebinding" | "failed" | "cancelled";
}

export interface RuntimeOpsProjectionInput {
  generatedAt: string;
  detectedRuntimes: string[];
  agents: RuntimeOpsAgentInput[];
  /** Cached host observation state only. Projection must never invoke a provider collector. */
  providerObservations?: unknown;
  /** t-019dac — optional host memory facts (filled by host-only snapshotService). */
  hostMemory?: {
    hostMemAvailableMb?: number;
    hostMemTotalMb?: number;
    recommendedVitestWorkers?: number;
  };
}

export function buildRuntimeOpsSnapshot(input: RuntimeOpsProjectionInput): RuntimeOpsSnapshotV2 {
  const runtimeIds = new Set(input.detectedRuntimes);
  for (const agent of input.agents) runtimeIds.add(agent.runtime);
  const runtimes = [...runtimeIds]
    .sort((a, b) => runtimeLabel(a).localeCompare(runtimeLabel(b)) || a.localeCompare(b))
    .map((runtime) => projectRuntime(runtime, input.detectedRuntimes.includes(runtime), input.agents.filter((agent) => agent.runtime === runtime)));
  return {
    schemaVersion: 2,
    generatedAt: input.generatedAt,
    summary: {
      runtimes: runtimes.length,
      managedAgents: input.agents.length,
      activeAgents: input.agents.filter((agent) => agent.status === "running" || agent.status === "stopping" || agent.status === "stop-failed").length,
      throttled: input.agents.filter((agent) => agent.attention?.state === "throttled").length,
      bridgeIssues: input.agents.filter((agent) => {
        const state = projectBridgeHealth(agent.bridge).state;
        return state !== "ok" && state !== "not-wired";
      }).length,
      ...(input.hostMemory ?? {}),
    },
    runtimes,
    providerCapacity: projectRuntimeOpsProviderCapacity(input.providerObservations, input.generatedAt),
  };
}

function projectRuntime(runtime: string, pathDetected: boolean, agents: RuntimeOpsAgentInput[]): RuntimeOpsRuntimeV1 {
  const orderedAgents = [...agents].sort((a, b) =>
    a.workspaceLabel.localeCompare(b.workspaceLabel) || a.agentName.localeCompare(b.agentName) || a.workspaceKey.localeCompare(b.workspaceKey));
  const workspaces = [...new Map(orderedAgents.map((agent) => [agent.workspaceKey, { key: agent.workspaceKey, label: agent.workspaceLabel }])).values()];
  const usageSources = orderedAgents.map((agent) => agent.usage).filter((usage): usage is RuntimeUsageSource => usage !== undefined);
  const usageObservedAt = latest(usageSources.map((usage) => normalizeTimestamp(usage.lastActivity)));
  const usage = usageSources.length > 0
    ? {
        state: "available" as const,
        value: aggregateUsage(runtime, usageSources),
        source: "activity-log" as const,
        ...(usageObservedAt ? { observedAt: usageObservedAt } : {}),
      }
    : { state: "unavailable" as const };
  const lastActivity = latest(orderedAgents.map((agent) => normalizeTimestamp(agent.lastActivity)));
  const versionCandidate = orderedAgents
    .map((agent) => ({
      ...agent,
      runtimeVersion: normalizeRuntimeVersion(agent.runtimeVersion),
      versionObservedAt: normalizeTimestamp(agent.versionObservedAt),
    }))
    .filter((agent): agent is typeof agent & { runtimeVersion: string } => agent.runtimeVersion !== undefined)
    .sort((a, b) => (a.versionObservedAt ?? "").localeCompare(b.versionObservedAt ?? "") || a.workspaceKey.localeCompare(b.workspaceKey) || a.agentName.localeCompare(b.agentName))
    .at(-1);
  return {
    key: `runtime:${runtime}`,
    runtime,
    label: runtimeLabel(runtime),
    availability: { pathDetected, managed: orderedAgents.length > 0 },
    usage,
    lastActivity: lastActivity
      ? { state: "available", value: lastActivity, source: "activity-log", observedAt: lastActivity }
      : { state: "unavailable" },
    version: versionCandidate?.runtimeVersion
      ? {
          state: "available",
          value: versionCandidate.runtimeVersion,
          source: "activity-log",
          ...(versionCandidate.versionObservedAt ? { observedAt: versionCandidate.versionObservedAt } : {}),
        }
      : { state: "unavailable" },
    workspaces,
    agents: orderedAgents.map((agent) => ({
      key: `${agent.workspaceKey}:${agent.agentName}`,
      name: agent.agentName,
      workspaceKey: agent.workspaceKey,
      status: normalizeStatus(agent.status),
      attention: normalizeAttention(agent.attention),
      model: normalizeModel(agent.model),
      modelObserved: normalizeObservedModel(agent.modelObserved),
      modelDivergence: agent.modelDivergence === true,
      resume: normalizeResume(agent.resume),
      bridge: projectBridgeHealth(agent.bridge),
      contextPressure: normalizeContextPressure(agent.contextPressure),
    })),
  };
}

export function projectBridgeHealth(input: RuntimeOpsBridgeHealthInput | undefined): RuntimeOpsAgentRefV1["bridge"] {
  if (!input || input.wired !== true) return { state: "not-wired" };
  const currentGeneration = normalizedGeneration(input.currentGeneration);
  const boundGeneration = normalizedGeneration(input.boundGeneration);
  const generations = currentGeneration !== undefined
    ? { currentGeneration, ...(boundGeneration !== undefined ? { boundGeneration } : {}) }
    : {};
  if (input.clientState === "cancelled") {
    return { state: "unknown", ...generations };
  }
  if (input.clientState === "failed") return { state: "failed", ...generations };
  if (input.clientState === "rebinding") return { state: "rebinding", ...generations };
  if (input.clientState === "suspect") return { state: "suspect", ...generations };
  if (currentGeneration === undefined || boundGeneration === undefined) return { state: "unknown", ...generations };
  if (boundGeneration < currentGeneration) {
    return { state: "suspect", ...generations };
  }
  if (boundGeneration > currentGeneration) {
    return { state: "unknown", ...generations };
  }
  return { state: "ok", ...generations };
}

function aggregateUsage(runtime: string, sources: RuntimeUsageSource[]): RuntimeOpsUsageV1 {
  return {
    inputTokens: sources.reduce((sum, source) => sum + normalizeTokenCount(source.inputTokens), 0),
    outputTokens: sources.reduce((sum, source) => sum + normalizeTokenCount(source.outputTokens), 0),
    cacheReadTokens: sources.reduce((sum, source) => sum + normalizeTokenCount(source.cacheReadTokens), 0),
    cacheCreationTokens: sources.reduce((sum, source) => sum + normalizeTokenCount(source.cacheCreationTokens), 0),
    semantics: runtimeUsageSemantics(runtime),
  };
}

function latest(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => value !== undefined).sort().at(-1);
}

function normalizeAttention(input: RuntimeOpsAttentionInput | undefined): RuntimeOpsAgentRefV1["attention"] {
  const state = normalizeAttentionState(input?.state);
  const rateLimit = state === "throttled" && input?.rateLimit ? normalizeRateLimit(input.rateLimit) : undefined;
  return { state, stale: input?.stale === true, ...(rateLimit ? { rateLimit } : {}) };
}

function normalizeAttentionState(value: unknown): RuntimeOpsAgentRefV1["attention"]["state"] {
  switch (value) {
    case "working":
    case "idle":
    case "needs-input":
    case "throttled":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function normalizeRateLimit(input: NonNullable<RuntimeOpsAttentionInput["rateLimit"]>): RuntimeOpsRateLimitV1 {
  const runtime = normalizeThrottleRuntime(input.runtime);
  const scope = normalizeThrottleScope(input.scope);
  const resetAt = normalizeResetAt(input.resetAt);
  return {
    ...(runtime ? { runtime } : {}),
    ...(scope ? { scope } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

function normalizeThrottleRuntime(value: unknown): RuntimeOpsThrottleRuntime | undefined {
  switch (value) {
    case "claude":
    case "codex":
    case "opencode":
      return value;
    default:
      return undefined;
  }
}

function normalizeThrottleScope(value: unknown): RuntimeOpsThrottleScope | undefined {
  switch (value) {
    case "5h":
    case "weekly":
      return value;
    default:
      return undefined;
  }
}

function normalizeModel(input: RuntimeOpsModelInput | undefined): RuntimeOpsModelV1 {
  if (input?.state !== "available") return { state: "unavailable" };
  const value = normalizeModelLabel(input.value);
  const source = input.source === "command" || input.source === "runtime-profile" ? input.source : undefined;
  return value && source ? { state: "available", value, source } : { state: "unavailable" };
}

function normalizeModelLabel(value: unknown): RuntimeOpsModelLabel | undefined {
  switch (value) {
    case "Claude default":
    case "Opus":
    case "Opus 4.8":
    case "Sonnet":
    case "Sonnet 5":
    case "Haiku":
    case "Codex default":
    case "GPT-5.1 Codex":
    case "GPT-5 Codex":
    case "Grok default":
      return value;
    default:
      return undefined;
  }
}

/** spec 378 — validated-open charset/length gate for an observed model id (or its title-cased label —
 *  `labelModel` only inserts spaces/capitalizes, so a validated raw id stays within this charset). Mirrors
 *  `sidebar/agentModel.ts`'s gate at this second protocol boundary. */
const OBSERVED_MODEL_RE = /^[A-Za-z0-9 ._:/-]{1,64}$/;

function normalizeObservedModel(input: RuntimeOpsObservedModelInput | undefined): RuntimeOpsObservedModelV1 {
  if (input?.state !== "available") return { state: "unavailable" };
  const value = typeof input.value === "string" && OBSERVED_MODEL_RE.test(input.value) ? input.value : undefined;
  if (!value) return { state: "unavailable" };
  const effort = typeof input.effort === "string" ? input.effort : undefined;
  const observedAt = normalizeTimestamp(input.observedAt);
  return {
    state: "available",
    value,
    ...(effort ? { effort } : {}),
    ...(observedAt ? { observedAt } : {}),
    ...(input.stale === true ? { stale: true } : {}),
  };
}

function normalizeResume(input: RuntimeOpsResumeInput | undefined): RuntimeOpsAgentRefV1["resume"] {
  switch (input?.state) {
    case "live":
    case "resumable":
    case "fresh-start-only":
    case "not-resumable":
      return { state: input.state };
    default:
      return { state: "not-resumable" };
  }
}

function normalizeContextPressure(input: RuntimeOpsContextPressureInput | undefined): RuntimeOpsContextPressureV1 {
  if (input?.state !== "available") return { state: "unavailable" };
  const used = normalizeTokenCount(input.value?.used);
  const limit = normalizeTokenCount(input.value?.limit);
  return limit > 0 ? { state: "available", value: { used, limit } } : { state: "unavailable" };
}

function normalizeStatus(value: unknown): RuntimeOpsAgentRefV1["status"] {
  switch (value) {
    case "running":
    case "stopping":
    case "stop-failed":
    case "stopped":
    case "crashed":
      return value;
    default:
      return "stopped";
  }
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeRuntimeVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : undefined;
}

function normalizeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeResetAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizedGeneration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
