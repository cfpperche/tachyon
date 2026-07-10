import path from "node:path";
import { ActivityLog, type LoggedEvent } from "../activity/logStore.js";
import type { AgentAttention } from "../attention/AttentionMonitor.js";
import type { ManagedEntryInfo } from "../agents/AgentManager.js";
import { runtimeOf } from "../resume/adapters.js";
import { isResumable, type SessionRecord } from "../resume/SessionLedger.js";
import { buildRuntimeUsageSource, runtimeUsageSemantics, type RuntimeUsageUpdate } from "../runtimeUsage/model.js";
import { modelFromCommand } from "../sidebar/agentModel.js";
import { detectInstalledClis } from "../webview/cliDetect.js";
import { buildRuntimeOpsSnapshot, type RuntimeOpsAgentInput } from "./model.js";
import type { RuntimeOpsSnapshotV1 } from "./types.js";
import { buildWorkspaceLabels, type RuntimeOpsWorkspaceInput } from "./workspaceLabels.js";

export interface RuntimeOpsWorkspaceSource {
  workspaceRoot: string;
  wsHash: string;
  folderName: string;
  ledger: { all(): Map<string, SessionRecord> };
  manager?: {
    list(): Promise<ManagedEntryInfo[]>;
    defOf(name: string): { cmd: string } | undefined;
    resumeReadiness(name: string, record: SessionRecord): Promise<boolean>;
  };
  attentionOf?(name: string): AgentAttention | undefined;
  runtimeOpsBridgeHealth?(name: string): {
    currentGeneration: number;
    boundGeneration: number;
    wired: boolean;
    clientState?: "ok" | "suspect" | "rebinding" | "failed" | "cancelled";
  };
}

export interface RuntimeOpsSnapshotServiceOptions {
  detect?: () => Promise<string[]>;
  now?: () => number;
  detectionTtlMs?: number;
  activityLog?: (workspaceRoot: string, agent: string) => RuntimeOpsActivityLog;
}

export interface RuntimeOpsActivityLog {
  tailFrom(n: number): { events: LoggedEvent[]; offset: number; partial: Buffer };
  forwardFrom(offset: number, partial: Buffer): { events: LoggedEvent[]; offset: number; partial: Buffer };
  size(): number;
}

interface ActivityProjection {
  log: RuntimeOpsActivityLog;
  offset: number;
  partial: Buffer;
  lastActivity?: string;
  runtimeVersion?: string;
  versionObservedAt?: string;
  summedUsage: RuntimeUsageUpdate;
  latestCumulativeUsage?: RuntimeUsageUpdate;
}

const ACTIVITY_TAIL_RECORDS = 5000;

export class RuntimeOpsSnapshotService {
  private detection?: { value: string[]; expiresAt: number };
  private detectionGeneration = 0;
  private inFlight?: { generation: number; promise: Promise<string[]> };
  private readonly detect: () => Promise<string[]>;
  private readonly now: () => number;
  private readonly detectionTtlMs: number;
  private readonly activityLog: NonNullable<RuntimeOpsSnapshotServiceOptions["activityLog"]>;
  private readonly activity = new Map<string, ActivityProjection>();

  constructor(
    private readonly getWorkspaces: () => RuntimeOpsWorkspaceSource[],
    options: RuntimeOpsSnapshotServiceOptions = {},
  ) {
    this.detect = options.detect ?? detectInstalledClis;
    this.now = options.now ?? Date.now;
    this.detectionTtlMs = options.detectionTtlMs ?? 60_000;
    this.activityLog = options.activityLog ?? ((workspaceRoot, agent) =>
      new ActivityLog(path.join(workspaceRoot, ".tachyon", "activity"), agent));
  }

  invalidateDetection(): void {
    this.detectionGeneration += 1;
    this.detection = undefined;
  }

  async snapshot(): Promise<RuntimeOpsSnapshotV1> {
    const detectedRuntimes = await this.detectCached();
    const workspaces = this.getWorkspaces();
    const workspaceInputs: RuntimeOpsWorkspaceInput[] = workspaces.map((workspace) => ({
      key: workspace.wsHash,
      name: workspace.folderName,
      root: workspace.workspaceRoot,
    }));
    const labels = buildWorkspaceLabels(workspaceInputs);
    const agents: RuntimeOpsAgentInput[] = [];
    const activeActivityKeys = new Set<string>();
    for (const workspace of workspaces) {
      const records = workspace.ledger.all();
      const entries = workspace.manager ? await workspace.manager.list() : [];
      const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
      const names = new Set([...records.keys(), ...entries.filter((entry) => entry.kind === "agent").map((entry) => entry.name)]);
      for (const agentName of names) {
        const record = records.get(agentName);
        const entry = entryByName.get(agentName);
        if (entry?.kind === "terminal" || record?.def?.kind === "terminal") continue;
        const definition = workspace.manager?.defOf(agentName);
        const runtime = record?.resume?.runtime ?? (definition ? runtimeOf(definition.cmd) ?? undefined : undefined);
        if (!runtime) continue;
        const key = `${workspace.wsHash}::${agentName}`;
        activeActivityKeys.add(key);
        const activity = this.activityProjection(key, workspace.workspaceRoot, agentName);
        const usageSemantics = runtimeUsageSemantics(runtime);
        agents.push({
          workspaceKey: workspace.wsHash,
          workspaceLabel: labels.get(workspace.wsHash) ?? workspace.folderName,
          agentName,
          runtime,
          usage: buildRuntimeUsageSource(runtime, agentName, usageSemantics === "latest-cumulative"
            ? (activity.latestCumulativeUsage ? [activity.latestCumulativeUsage] : [])
            : [activity.summedUsage]),
          lastActivity: activity.lastActivity,
          runtimeVersion: activity.runtimeVersion,
          versionObservedAt: activity.versionObservedAt,
          status: lifecycleStatus(entry),
          attention: projectAttention(workspace.attentionOf?.(agentName)),
          model: projectModel(definition?.cmd),
          resume: await projectResume(agentName, record, entryByName.get(agentName), workspace.manager),
          bridge: workspace.runtimeOpsBridgeHealth?.(agentName),
        });
      }
    }
    for (const key of this.activity.keys()) if (!activeActivityKeys.has(key)) this.activity.delete(key);
    return buildRuntimeOpsSnapshot({ generatedAt: new Date(this.now()).toISOString(), detectedRuntimes, agents });
  }

  private activityProjection(key: string, workspaceRoot: string, agent: string): ActivityProjection {
    let projection = this.activity.get(key);
    if (!projection) {
      const log = this.activityLog(workspaceRoot, agent);
      const tail = log.tailFrom(ACTIVITY_TAIL_RECORDS);
      projection = {
        log,
        offset: tail.offset,
        partial: tail.partial,
        summedUsage: {},
      };
      this.ingest(projection, tail.events);
      this.activity.set(key, projection);
      return projection;
    }

    if (projection.log.size() < projection.offset) {
      const tail = projection.log.tailFrom(ACTIVITY_TAIL_RECORDS);
      projection.offset = tail.offset;
      projection.partial = tail.partial;
      projection.lastActivity = undefined;
      projection.runtimeVersion = undefined;
      projection.versionObservedAt = undefined;
      projection.summedUsage = {};
      projection.latestCumulativeUsage = undefined;
      this.ingest(projection, tail.events);
      return projection;
    }

    const forward = projection.log.forwardFrom(projection.offset, projection.partial);
    projection.offset = forward.offset;
    projection.partial = forward.partial;
    this.ingest(projection, forward.events);
    return projection;
  }

  private ingest(projection: ActivityProjection, events: LoggedEvent[]): void {
    for (const event of events) {
      const observedAt = event.timestamp ?? event.loggedAt;
      if (observedAt && (!projection.lastActivity || observedAt > projection.lastActivity)) projection.lastActivity = observedAt;
      if (event.runtimeVersion && (!projection.versionObservedAt || observedAt >= projection.versionObservedAt)) {
        projection.runtimeVersion = event.runtimeVersion;
        projection.versionObservedAt = observedAt;
      }
      if (event.type !== "usage.updated") continue;
      const update = { ...(event.payload as Omit<RuntimeUsageUpdate, "timestamp">), timestamp: observedAt };
      projection.latestCumulativeUsage = update;
      projection.summedUsage = sumUsage(projection.summedUsage, update);
    }
  }

  private async detectCached(): Promise<string[]> {
    const now = this.now();
    if (this.detection && now < this.detection.expiresAt) return this.detection.value;
    const generation = this.detectionGeneration;
    if (this.inFlight?.generation === generation) return this.inFlight.promise;
    const promise = this.detect().then((value) => {
      const normalized = [...new Set(value)].sort();
      if (generation === this.detectionGeneration) this.detection = { value: normalized, expiresAt: this.now() + this.detectionTtlMs };
      return normalized;
    }).finally(() => {
      if (this.inFlight?.generation === generation) this.inFlight = undefined;
    });
    this.inFlight = { generation, promise };
    return promise;
  }
}

function sumUsage(total: RuntimeUsageUpdate, update: RuntimeUsageUpdate): RuntimeUsageUpdate {
  return {
    inputTokens: (total.inputTokens ?? 0) + (update.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (update.outputTokens ?? 0),
    cacheReadTokens: (total.cacheReadTokens ?? 0) + (update.cacheReadTokens ?? 0),
    cacheCreationTokens: (total.cacheCreationTokens ?? 0) + (update.cacheCreationTokens ?? 0),
    timestamp: !total.timestamp || (update.timestamp && update.timestamp > total.timestamp) ? update.timestamp : total.timestamp,
  };
}

function lifecycleStatus(entry: ManagedEntryInfo | undefined): RuntimeOpsAgentInput["status"] {
  if (!entry) return "stopped";
  if (entry.stopFailed) return "stop-failed";
  if (entry.stopping) return "stopping";
  if (entry.running) return "running";
  if (entry.crashed) return "crashed";
  return "stopped";
}

function projectAttention(attention: AgentAttention | undefined): RuntimeOpsAgentInput["attention"] {
  if (!attention) return { state: "unknown", stale: false };
  const rateLimit = attention.state === "throttled" && attention.rateLimit
    ? {
        ...(attention.rateLimit.runtime ? { runtime: attention.rateLimit.runtime } : {}),
        ...(attention.rateLimit.scope ? { scope: attention.rateLimit.scope } : {}),
        ...(attention.rateLimit.resetAt ? { resetAt: attention.rateLimit.resetAt } : {}),
      }
    : undefined;
  return {
    state: attention.state,
    stale: attention.stale,
    ...(rateLimit ? { rateLimit } : {}),
  };
}

function projectModel(command: string | undefined): RuntimeOpsAgentInput["model"] {
  const label = modelFromCommand(command);
  if (!label) return { state: "unavailable" };
  const explicit = !!command && /(?:^|\s)(?:--model(?:=|\s)|-m\s)/.test(command);
  return {
    state: "available",
    value: label,
    source: explicit ? "command" : "runtime-profile",
  };
}

async function projectResume(
  name: string,
  record: SessionRecord | undefined,
  entry: ManagedEntryInfo | undefined,
  manager: RuntimeOpsWorkspaceSource["manager"],
): Promise<NonNullable<RuntimeOpsAgentInput["resume"]>> {
  if (entry?.running) return { state: "live" };
  if (!record || !isResumable(record)) return { state: "not-resumable" };
  const ready = manager ? await manager.resumeReadiness(name, record) : true;
  return ready
    ? { state: "resumable" }
    : { state: "fresh-start-only" };
}
