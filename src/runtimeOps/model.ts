import { runtimeLabel, runtimeUsageSemantics, type RuntimeUsageSource } from "../runtimeUsage/model.js";
import type { RuntimeOpsAgentRefV1, RuntimeOpsRuntimeV1, RuntimeOpsSnapshotV1, RuntimeOpsUsageV1 } from "./types.js";

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
  attention?: RuntimeOpsAgentRefV1["attention"];
  model?: RuntimeOpsAgentRefV1["model"];
  resume?: RuntimeOpsAgentRefV1["resume"];
  bridge?: RuntimeOpsBridgeHealthInput;
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
}

export function buildRuntimeOpsSnapshot(input: RuntimeOpsProjectionInput): RuntimeOpsSnapshotV1 {
  const runtimeIds = new Set(input.detectedRuntimes);
  for (const agent of input.agents) runtimeIds.add(agent.runtime);
  const runtimes = [...runtimeIds]
    .sort((a, b) => runtimeLabel(a).localeCompare(runtimeLabel(b)) || a.localeCompare(b))
    .map((runtime) => projectRuntime(runtime, input.detectedRuntimes.includes(runtime), input.agents.filter((agent) => agent.runtime === runtime)));
  return {
    schemaVersion: 1,
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
    },
    runtimes,
  };
}

function projectRuntime(runtime: string, pathDetected: boolean, agents: RuntimeOpsAgentInput[]): RuntimeOpsRuntimeV1 {
  const orderedAgents = [...agents].sort((a, b) =>
    a.workspaceLabel.localeCompare(b.workspaceLabel) || a.agentName.localeCompare(b.agentName) || a.workspaceKey.localeCompare(b.workspaceKey));
  const workspaces = [...new Map(orderedAgents.map((agent) => [agent.workspaceKey, { key: agent.workspaceKey, label: agent.workspaceLabel }])).values()];
  const usageSources = orderedAgents.map((agent) => agent.usage).filter((usage): usage is RuntimeUsageSource => usage !== undefined);
  const usageObservedAt = latest(usageSources.map((usage) => usage.lastActivity));
  const usage = usageSources.length > 0
    ? {
        state: "available" as const,
        value: aggregateUsage(runtime, usageSources),
        source: "activity-log" as const,
        ...(usageObservedAt ? { observedAt: usageObservedAt } : {}),
      }
    : { state: "unavailable" as const, reason: orderedAgents.length > 0 ? "No normalized usage events were observed." : "No Tachyon-managed session has usage data." };
  const lastActivity = latest(orderedAgents.map((agent) => agent.lastActivity));
  const versionCandidate = [...orderedAgents]
    .filter((agent) => agent.runtimeVersion)
    .sort((a, b) => (a.versionObservedAt ?? "").localeCompare(b.versionObservedAt ?? "") || a.workspaceKey.localeCompare(b.workspaceKey) || a.agentName.localeCompare(b.agentName))
    .at(-1);
  const availability = pathDetected && orderedAgents.length > 0
    ? "PATH detected; managed sessions observed"
    : pathDetected
      ? "PATH detected; authentication not checked"
      : "Managed session observed; PATH not detected in this host";
  return {
    key: `runtime:${runtime}`,
    runtime,
    label: runtimeLabel(runtime),
    availability: { pathDetected, managed: orderedAgents.length > 0, detail: availability },
    usage,
    lastActivity: lastActivity
      ? { state: "available", value: lastActivity, source: "activity-log", observedAt: lastActivity }
      : { state: "unavailable", reason: "No normalized activity timestamp was observed." },
    version: versionCandidate?.runtimeVersion
      ? {
          state: "available",
          value: versionCandidate.runtimeVersion,
          source: "activity-log",
          ...(versionCandidate.versionObservedAt ? { observedAt: versionCandidate.versionObservedAt } : {}),
        }
      : { state: "unavailable", reason: "No normalized runtime version was observed." },
    workspaces,
    agents: orderedAgents.map((agent) => ({
      key: `${agent.workspaceKey}:${agent.agentName}`,
      name: agent.agentName,
      workspaceKey: agent.workspaceKey,
      status: agent.status ?? "stopped",
      attention: agent.attention ?? { state: "unknown", stale: false },
      model: agent.model ?? { state: "unavailable", reason: "No configured or command-line model was resolved." },
      resume: agent.resume ?? { state: "not-resumable", reason: "No resumable session is recorded." },
      bridge: projectBridgeHealth(agent.bridge),
      contextPressure: { state: "unavailable", reason: "No normalized context-window used/limit source is wired." },
    })),
  };
}

export function projectBridgeHealth(input: RuntimeOpsBridgeHealthInput | undefined): RuntimeOpsAgentRefV1["bridge"] {
  if (!input || !input.wired) return { state: "not-wired", reason: "Bridge client materialization is not recorded." };
  const generations = input.currentGeneration > 0
    ? { currentGeneration: input.currentGeneration, boundGeneration: input.boundGeneration }
    : {};
  if (input.clientState === "cancelled") {
    return { state: "unknown", reason: "A cancelled prior incarnation was not reset.", ...generations };
  }
  if (input.clientState === "failed") return { state: "failed", reason: "Bridge client rebind failed.", ...generations };
  if (input.clientState === "rebinding") return { state: "rebinding", reason: "Bridge client rebind is in progress.", ...generations };
  if (input.clientState === "suspect") return { state: "suspect", reason: "Bridge client is marked suspect for this host generation.", ...generations };
  if (input.currentGeneration < 1) return { state: "unknown", reason: "Current Bridge host generation is unavailable." };
  if (input.boundGeneration < input.currentGeneration) {
    return { state: "suspect", reason: "Bridge client is bound to an older host generation.", ...generations };
  }
  if (input.boundGeneration > input.currentGeneration) {
    return { state: "unknown", reason: "Bridge client binding is ahead of the current host generation.", ...generations };
  }
  return { state: "ok", reason: "Wired and bound to the current host generation.", ...generations };
}

function aggregateUsage(runtime: string, sources: RuntimeUsageSource[]): RuntimeOpsUsageV1 {
  return {
    inputTokens: sources.reduce((sum, source) => sum + (source.inputTokens ?? 0), 0),
    outputTokens: sources.reduce((sum, source) => sum + (source.outputTokens ?? 0), 0),
    cacheReadTokens: sources.reduce((sum, source) => sum + (source.cacheReadTokens ?? 0), 0),
    cacheCreationTokens: sources.reduce((sum, source) => sum + (source.cacheCreationTokens ?? 0), 0),
    semantics: runtimeUsageSemantics(runtime),
  };
}

function latest(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => value !== undefined).sort().at(-1);
}
