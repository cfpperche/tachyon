import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { ActivityLog, type LoggedEvent } from "../activity/logStore.js";
import type { AgentAttention } from "@tachyon/shared/attention/AttentionMonitor.js";
import type { ManagedEntryInfo } from "../agents/AgentManager.js";
import { runtimeOf } from "@tachyon/shared/resume/adapters.js";
import { agentSessionRecordsOf, isResumable, type SessionRecord } from "../resume/SessionLedger.js";
import { MEASURED_CLI_VERSIONS } from "../runtime/measuredCliVersions.js";
import { buildRuntimeUsageSource, runtimeUsageSemantics, type RuntimeUsageUpdate } from "../runtimeUsage/model.js";
import { modelFromCommand, resolveModelFact, type ObservedModelInput } from "../sidebar/agentModel.js";
import { detectInstalledClis } from "../webview/cliDetect.js";
import { buildRuntimeOpsSnapshot, type RuntimeOpsAgentInput } from "./model.js";
import type { RuntimeOpsProviderObservationSnapshotInput } from "./providerProjection.js";
import type { RuntimeOpsSnapshotV2 } from "./types.js";
import { buildWorkspaceLabels, type RuntimeOpsWorkspaceInput } from "./workspaceLabels.js";
import { cpus } from "node:os";
import { readHostMemory } from "../host/hostResources.js";
import { previewVitestShare } from "../host/vitestBudget.js";

const execFileP = promisify(execFile);

export interface RuntimeOpsWorkspaceSource {
  workspaceRoot: string;
  wsHash: string;
  folderName: string;
  ledger: { all(): Map<string, SessionRecord> };
  manager?: {
    listAgents(): Promise<ManagedEntryInfo[]>;
    defOf(name: string): { cmd: string } | undefined;
    resumeReadiness(name: string, record: SessionRecord): Promise<boolean>;
    /** Required for t-e3bae0 resource sampling; optional so lean test doubles stay valid. */
    session?(name: string): string;
  };
  tmux?: {
    panePid(session: string): Promise<number>;
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
  /** Synchronous cached read port. It must not collect or wait on a provider from the snapshot/render path. */
  providerObservations?: () => RuntimeOpsProviderObservationSnapshotInput;
  /** t-e3bae0 — shared with sidebar fleet so CPU% has continuous samples across views. */
  resourceSampler?: Pick<import("../attention/resourceSample.js").ResourceSampler, "sample" | "clear" | "keys">;
  /**
   * t-1322b5 — PATH `--version` for runtimes with a measured product baseline.
   * Default runs `<runtime> --version` with a short timeout. Inject in tests.
   * Returns the raw banner string, or null when the CLI cannot be read.
   */
  readPathVersion?: (runtime: string) => Promise<string | null>;
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
  /** spec 378 — the latched observed model fact, advanced in LOG APPEND ORDER (not `observedAt` compare —
   *  a host-stamped boundary could out-stamp and suppress a newer real observation). */
  model?: string;
  modelEffort?: string;
  modelObservedAt?: string;
  /** true after a process-preserving session boundary until a fresh observation re-latches. */
  modelStale: boolean;
  summedUsage: RuntimeUsageUpdate;
  latestCumulativeUsage?: RuntimeUsageUpdate;
}

const ACTIVITY_TAIL_RECORDS = 5000;

/** logWriter lifecycle labels that ROTATE the runtime process (spec 378 plan: "restarted/started/fork") — the
 *  new process provably reverted to its spawn command, so a demoted observed model must not survive the
 *  boundary. Process-PRESERVING boundaries (unlabeled "new" = in-TUI `/clear`, inferred "resume", or the
 *  Tachyon-labeled "resumed") instead retain the observation but flag it `stale` until re-observed. */
const PROCESS_ROTATING_BOUNDARY_REASONS = new Set(["restarted", "started", "forked"]);

export class RuntimeOpsSnapshotService {
  private detection?: { value: string[]; expiresAt: number };
  private detectionGeneration = 0;
  private inFlight?: { generation: number; promise: Promise<string[]> };
  private readonly detect: () => Promise<string[]>;
  private readonly now: () => number;
  private readonly detectionTtlMs: number;
  private readonly activityLog: NonNullable<RuntimeOpsSnapshotServiceOptions["activityLog"]>;
  private readonly providerObservations?: NonNullable<RuntimeOpsSnapshotServiceOptions["providerObservations"]>;
  private readonly resourceSampler?: NonNullable<RuntimeOpsSnapshotServiceOptions["resourceSampler"]>;
  private readonly readPathVersion: (runtime: string) => Promise<string | null>;
  private pathVersions?: { value: Record<string, string | null>; expiresAt: number; generation: number };
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
    this.providerObservations = options.providerObservations;
    this.resourceSampler = options.resourceSampler;
    this.readPathVersion = options.readPathVersion ?? defaultReadPathVersion;
  }

  invalidateDetection(): void {
    this.detectionGeneration += 1;
    this.detection = undefined;
    this.pathVersions = undefined;
  }

  async snapshot(): Promise<RuntimeOpsSnapshotV2> {
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
    const liveResourceKeys = new Set<string>();
    for (const workspace of workspaces) {
      const records = agentSessionRecordsOf(workspace.ledger.all());
      const entries = workspace.manager ? await workspace.manager.listAgents() : [];
      const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
      const names = new Set([...records.keys(), ...entries.map((entry) => entry.name)]);
      for (const agentName of names) {
        const record = records.get(agentName);
        const entry = entryByName.get(agentName);
        const definition = workspace.manager?.defOf(agentName);
        const runtime = record?.resume?.runtime ?? (definition ? runtimeOf(definition.cmd) ?? undefined : undefined);
        if (!runtime) continue;
        const key = `${workspace.wsHash}::${agentName}`;
        activeActivityKeys.add(key);
        const activity = this.activityProjection(key, workspace.workspaceRoot, agentName);
        const usageSemantics = runtimeUsageSemantics(runtime);
        const observed: ObservedModelInput | undefined = activity.model
          ? { id: activity.model, effort: activity.modelEffort, observedAt: activity.modelObservedAt, stale: activity.modelStale }
          : undefined;
        const modelFact = resolveModelFact(definition?.cmd, observed);
        const resources = await this.sampleAgentResources(workspace, agentName, entry);
        if (resources) liveResourceKeys.add(agentName);
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
          modelObserved: modelFact?.source === "observed"
            ? {
                state: "available",
                value: modelFact.label,
                effort: observed?.effort,
                observedAt: modelFact.observedAt,
                stale: modelFact.stale,
              }
            : { state: "unavailable" },
          modelDivergence: modelFact?.divergence === true,
          resume: await projectResume(agentName, record, entryByName.get(agentName), workspace.manager),
          bridge: workspace.runtimeOpsBridgeHealth?.(agentName),
          ...(resources ? { resources } : {}),
        });
      }
    }
    for (const key of this.activity.keys()) if (!activeActivityKeys.has(key)) this.activity.delete(key);
    if (this.resourceSampler) {
      for (const key of this.resourceSampler.keys()) {
        if (!liveResourceKeys.has(key)) this.resourceSampler.clear(key);
      }
    }
    let providerObservations: unknown;
    try {
      providerObservations = this.providerObservations?.();
    } catch {
      // Provider observation is additive. A broken cached accessor must not remove native runtime inventory.
    }
    const pathVersions = await this.pathVersionsCached();
    return buildRuntimeOpsSnapshot({
      generatedAt: new Date(this.now()).toISOString(),
      detectedRuntimes,
      agents,
      pathVersions,
      providerObservations,
      // t-7f9809 — workers from the host-wide budget preview (siblings discounted), not alone-sizing.
      hostMemory: (() => {
        const memory = readHostMemory();
        if (memory.source !== "proc-meminfo") return undefined;
        let recommendedVitestWorkers = 0;
        try {
          recommendedVitestWorkers = previewVitestShare({
            memory,
            cpuCount: cpus().length || 1,
          }).workers;
        } catch {
          // Ledger lock / infra failure: do not invent a claim and do not crash the snapshot.
          // Zero is the honest "we cannot say a run would get workers right now" without lying high.
          recommendedVitestWorkers = 0;
        }
        return {
          hostMemAvailableMb: memory.memAvailableMb,
          hostMemTotalMb: memory.memTotalMb,
          recommendedVitestWorkers,
        };
      })(),
    });
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
        modelStale: false,
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
      projection.model = undefined;
      projection.modelEffort = undefined;
      projection.modelObservedAt = undefined;
      projection.modelStale = false;
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
      // grok/opencode no longer stamp `runtimeVersion` (spec 378 un-overload) — fall back to their `model`
      // field so the RuntimeOps version column keeps working via the new field.
      const versionSource = event.runtimeVersion
        ?? ((event.source.runtime === "grok" || event.source.runtime === "opencode") ? event.model : undefined);
      if (versionSource && (!projection.versionObservedAt || observedAt >= projection.versionObservedAt)) {
        projection.runtimeVersion = versionSource;
        projection.versionObservedAt = observedAt;
      }
      if (event.type === "session.boundary") {
        const reason = (event.payload as { reason?: string } | undefined)?.reason;
        if (reason && PROCESS_ROTATING_BOUNDARY_REASONS.has(reason)) {
          // The new process provably reverted to its spawn command — the prior observation cannot be trusted.
          projection.model = undefined;
          projection.modelEffort = undefined;
          projection.modelObservedAt = undefined;
          projection.modelStale = false;
        } else if (projection.model) {
          // Process-preserving boundary (in-TUI /clear, resume) — keep the observation, flag it stale.
          projection.modelStale = true;
        }
      }
      // Latched in LOG APPEND ORDER (not an `observedAt` compare — a host-stamped boundary above could
      // out-stamp and suppress a newer real observation that follows it in the same batch).
      if (event.model) {
        projection.model = event.model;
        projection.modelEffort = event.effort;
        projection.modelObservedAt = observedAt;
        projection.modelStale = false;
      }
      if (event.type !== "usage.updated") continue;
      const update = { ...(event.payload as Omit<RuntimeUsageUpdate, "timestamp">), timestamp: observedAt };
      projection.latestCumulativeUsage = update;
      projection.summedUsage = sumUsage(projection.summedUsage, update);
    }
  }

  /**
   * Cheap, VIEW-INDEPENDENT accessor (spec 378): advances this agent's shared activity projection itself —
   * no CLI detection, no whole-fleet snapshot — and returns its latched observed model fact. Used by both
   * `snapshot()` and the sidebar's live model-provenance gather, so a model update reaches the sidebar even
   * when the RuntimeOps webview is never opened (`RuntimeOpsView.refresh()` no-ops while hidden).
   */
  observedModelFor(workspaceRoot: string, wsHash: string, agentName: string): ObservedModelInput | undefined {
    const key = `${wsHash}::${agentName}`;
    const projection = this.activityProjection(key, workspaceRoot, agentName);
    if (!projection.model) return undefined;
    return {
      id: projection.model,
      effort: projection.modelEffort,
      observedAt: projection.modelObservedAt,
      stale: projection.modelStale,
    };
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

  /**
   * t-1322b5 — PATH versions for runtimes that have a product measured baseline.
   * Cached on the same TTL/generation as CLI presence detection. Never blocks the product
   * when a probe fails: the map carries null and the UI says the running version is unknown.
   */
  private async pathVersionsCached(): Promise<Record<string, string | null>> {
    const now = this.now();
    const generation = this.detectionGeneration;
    if (this.pathVersions && this.pathVersions.generation === generation && now < this.pathVersions.expiresAt) {
      return this.pathVersions.value;
    }
    const runtimes = Object.keys(MEASURED_CLI_VERSIONS);
    const entries = await Promise.all(
      runtimes.map(async (runtime) => {
        try {
          return [runtime, await this.readPathVersion(runtime)] as const;
        } catch {
          return [runtime, null] as const;
        }
      }),
    );
    const value = Object.fromEntries(entries);
    this.pathVersions = { value, expiresAt: this.now() + this.detectionTtlMs, generation };
    return value;
  }

  /** t-e3bae0 — pane-subtree RSS/CPU via shared ResourceSampler (Linux /proc). */
  private async sampleAgentResources(
    workspace: RuntimeOpsWorkspaceSource,
    agentName: string,
    entry: ManagedEntryInfo | undefined,
  ): Promise<{ cpuPct?: number; memMb: number } | undefined> {
    if (!this.resourceSampler || !workspace.manager?.session || !workspace.tmux) return undefined;
    if (!entry?.running || entry.dead) return undefined;
    try {
      const panePid = await workspace.tmux.panePid(workspace.manager.session(agentName));
      return this.resourceSampler.sample(agentName, panePid);
    } catch {
      return undefined;
    }
  }
}

/**
 * t-1322b5 — default PATH version probe. Only `--version` (never upgrade selectors).
 * Returns null when the binary is missing or the banner is empty — never invents a version.
 */
async function defaultReadPathVersion(runtime: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileP(runtime, ["--version"], {
      timeout: 10_000,
      encoding: "utf8",
    });
    const banner = `${stdout ?? ""}${stderr ?? ""}`.trim();
    return banner || null;
  } catch {
    return null;
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
