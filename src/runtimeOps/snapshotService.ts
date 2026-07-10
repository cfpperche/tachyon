import path from "node:path";
import { ActivityLog } from "../activity/logStore.js";
import type { SessionRecord } from "../resume/SessionLedger.js";
import { buildRuntimeUsageSource, type RuntimeUsageUpdate } from "../runtimeUsage/model.js";
import { detectInstalledClis } from "../webview/cliDetect.js";
import { buildRuntimeOpsSnapshot, type RuntimeOpsAgentInput } from "./model.js";
import type { RuntimeOpsSnapshotV1 } from "./types.js";
import { buildWorkspaceLabels, type RuntimeOpsWorkspaceInput } from "./workspaceLabels.js";

export interface RuntimeOpsWorkspaceSource {
  workspaceRoot: string;
  wsHash: string;
  folderName: string;
  ledger: { all(): Map<string, SessionRecord> };
}

export interface RuntimeOpsSnapshotServiceOptions {
  detect?: () => Promise<string[]>;
  now?: () => number;
  detectionTtlMs?: number;
  readEvents?: (workspaceRoot: string, agent: string) => ReturnType<ActivityLog["readTail"]>;
}

export class RuntimeOpsSnapshotService {
  private detection?: { value: string[]; expiresAt: number };
  private detectionGeneration = 0;
  private inFlight?: { generation: number; promise: Promise<string[]> };
  private readonly detect: () => Promise<string[]>;
  private readonly now: () => number;
  private readonly detectionTtlMs: number;
  private readonly readEvents: NonNullable<RuntimeOpsSnapshotServiceOptions["readEvents"]>;

  constructor(
    private readonly getWorkspaces: () => RuntimeOpsWorkspaceSource[],
    options: RuntimeOpsSnapshotServiceOptions = {},
  ) {
    this.detect = options.detect ?? detectInstalledClis;
    this.now = options.now ?? Date.now;
    this.detectionTtlMs = options.detectionTtlMs ?? 60_000;
    this.readEvents = options.readEvents ?? ((workspaceRoot, agent) =>
      new ActivityLog(path.join(workspaceRoot, ".tachyon", "activity"), agent).readTail(5000));
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
    for (const workspace of workspaces) {
      for (const [agentName, record] of workspace.ledger.all()) {
        const runtime = record.resume?.runtime;
        if (!runtime) continue;
        const events = this.readEvents(workspace.workspaceRoot, agentName);
        const updates: RuntimeUsageUpdate[] = [];
        let lastActivity: string | undefined;
        let runtimeVersion: string | undefined;
        let versionObservedAt: string | undefined;
        for (const event of events) {
          const observedAt = event.timestamp ?? event.loggedAt;
          if (observedAt && (!lastActivity || observedAt > lastActivity)) lastActivity = observedAt;
          if (event.runtimeVersion && (!versionObservedAt || observedAt >= versionObservedAt)) {
            runtimeVersion = event.runtimeVersion;
            versionObservedAt = observedAt;
          }
          if (event.type === "usage.updated") {
            const payload = event.payload as Omit<RuntimeUsageUpdate, "timestamp">;
            updates.push({ ...payload, timestamp: observedAt });
          }
        }
        agents.push({
          workspaceKey: workspace.wsHash,
          workspaceLabel: labels.get(workspace.wsHash) ?? workspace.folderName,
          agentName,
          runtime,
          usage: buildRuntimeUsageSource(runtime, agentName, updates),
          lastActivity,
          runtimeVersion,
          versionObservedAt,
        });
      }
    }
    return buildRuntimeOpsSnapshot({ generatedAt: new Date(this.now()).toISOString(), detectedRuntimes, agents });
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
