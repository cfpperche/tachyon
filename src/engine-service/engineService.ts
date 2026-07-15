import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { workspaceHash } from "../tmux/TmuxService.js";
import {
  ActivityLogManager,
  restartAgentWithActivity,
  resumeAgentWithActivity,
  startAgentWithActivity,
} from "../activity/ActivityLogManager.js";
import { readLinuxProcessIdentity } from "../delivery/reloadReconciliation.js";
import { DaemonEngineHost, type DaemonHostEvent, type DaemonSettingsSnapshot } from "../workspace/DaemonEngineHost.js";
import type { ViewKind } from "../workspace/EngineHost.js";
import { Workspace } from "../workspace/Workspace.js";
import { sendManagedAgentInput } from "../agents/agentInputService.js";
import {
  startHandoffDistillation,
  workspaceHandoffDistillOperations,
} from "../handoff/handoffDistillService.js";
import { ensureProjectHandoffFile } from "../handoff/handoffFileService.js";
import { projectActivityContext } from "../runtime-api/activityProjection.js";
import { projectHandoffView } from "../runtime-api/handoffProjection.js";
import { projectSidebarView } from "../runtime-api/sidebarProjection.js";
import { applySidebarMutation } from "../sidebar/sidebarMutationService.js";
import { RuntimeOpsSnapshotService } from "../runtimeOps/snapshotService.js";
import type { WorkspaceCoreProjectionsV1 } from "../runtime-api/workspaceProjection.js";
import { buildBoardSnapshot } from "../tasks/boardSnapshot.js";
import { projectMissionControlBoard } from "../runtime-api/missionControlProjection.js";
import { projectPinStudio } from "../runtime-api/pinStudioProjection.js";
import {
  parsePinStudioStagedPayloadV1,
  PIN_STUDIO_STAGED_PAYLOAD_MAX_BYTES,
} from "../runtime-api/pinStudioCommands.js";
import { projectTaskDetail } from "../runtime-api/taskDetailProjection.js";
import { projectTaskStudio } from "../runtime-api/taskStudioProjection.js";
import {
  parseTaskStudioStagedPayloadV1,
  TASK_STUDIO_STAGED_PAYLOAD_MAX_BYTES,
} from "../runtime-api/taskStudioCommands.js";
import { reviewTaskPrototype } from "../tasks/taskPrototypeReview.js";
import {
  putPinStudioImage,
  putPinStudioSketch,
  savePinStudio,
} from "../pins/pinStudioService.js";
import {
  cancelTaskStudio,
  importTaskStudioPrototype,
  putTaskStudioImage,
  putTaskStudioSketch,
  saveTaskStudio,
} from "../tasks/taskStudioService.js";
import { startEngineControlServer, type RunningEngineControlServer } from "./controlServer.js";
import { EngineEventJournal } from "./eventJournal.js";
import { StagedPayloadStore } from "./stagedPayloadStore.js";
import {
  ENGINE_SHELL_PROTOCOL,
  isEngineServiceIdentityV1,
  isSha256,
  workspaceActivityContextSuccessV1,
  workspaceCommandSuccessV1,
  workspaceHandoffDistillSuccessV1,
  workspaceHandoffEnsureSuccessV1,
  workspaceHandoffViewSuccessV1,
  workspaceSidebarMutationSuccessV1,
  workspaceSidebarViewSuccessV1,
  workspaceMissionControlViewSuccessV1,
  workspacePinStudioApplySuccessV1,
  workspacePinStudioViewSuccessV1,
  workspaceProbeViewSuccessV1,
  workspaceTaskDetailViewSuccessV1,
  workspaceTaskStudioApplySuccessV1,
  workspaceTaskStudioViewSuccessV1,
  type EngineServiceIdentityV1,
  type WorkspaceCommandResultV1,
  type WorkspaceCommandV1,
  type WorkspaceQueryResultV1,
  type WorkspaceQueryV1,
  type WorkspaceSnapshotEnvelopeV1,
} from "./protocol.js";

const AGENT_SNAPSHOT_LIMIT = 50;
const TASK_SNAPSHOT_LIMIT = 50;
const PIN_SNAPSHOT_LIMIT = 20;
const SCHEDULE_SNAPSHOT_LIMIT = 25;
const MAX_SNAPSHOT_BYTES = 48 * 1024;

export interface StartDaemonEngineServiceOptions {
  workspaceRoot: string;
  storageRoot: string;
  mediaRoot: string;
  controlSocketPath: string;
  appVersion: string;
  bundleId: string;
  settings?: DaemonSettingsSnapshot;
}

export interface RunningDaemonEngineService {
  readonly identity: EngineServiceIdentityV1;
  readonly controlSocketPath: string;
  snapshot(): Promise<WorkspaceSnapshotEnvelopeV1>;
  shellCount(): number;
  close(): Promise<void>;
}

/**
 * Starts one complete operational engine for one canonical workspace.  The returned service owns the
 * Workspace, its direct public Bridge, scheduler/watchers and the private shell-control socket.  Shell
 * attachment is deliberately absent from this startup path: a shell may come and go without entering
 * the Workspace lifecycle.
 */
export async function startDaemonEngineService(
  options: StartDaemonEngineServiceOptions,
): Promise<RunningDaemonEngineService> {
  validateOptions(options);
  const canonicalRoot = canonicalWorkspaceRoot(options.workspaceRoot);
  const hash = workspaceHash(canonicalRoot);
  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  const journal = new EngineEventJournal({
    filePath: path.join(options.storageRoot, "events", `${instanceId}.jsonl`),
    engineInstanceId: instanceId,
  });
  const projections = new EngineProjectionCoordinator(journal, instanceId);
  const stagedPayloads = new StagedPayloadStore(path.dirname(options.controlSocketPath));
  stagedPayloads.cleanupStale();
  const host = new DaemonEngineHost({
    storageRoot: path.join(options.storageRoot, "state"),
    mediaRoot: options.mediaRoot,
    appVersion: options.appVersion,
    settings: options.settings,
    emit: (event) => projections.record(event),
  });

  let workspace: Workspace | undefined;
  let control: RunningEngineControlServer | undefined;
  let activityLog: ActivityLogManager | undefined;
  try {
    workspace = await Workspace.createDaemon(canonicalRoot, {
      host,
      onViewsChanged: (view) => host.onViewsChanged(view),
    });
    await workspace.start();
    const runningWorkspace = workspace;
    activityLog = new ActivityLogManager(
      () => [runningWorkspace],
      2_000,
      3_000,
      (_workspaceHash, agent, count) => host.onActivityAppended(agent, count),
    );
    activityLog.start();
    const runningActivityLog = activityLog;
    const runtimeOpsSnapshots = new RuntimeOpsSnapshotService(() => [runningWorkspace]);

    const bridgePort = runningWorkspace.bridge.listenerPort;
    if (bridgePort === undefined || runningWorkspace.bridge.port !== bridgePort) {
      const detail = runningWorkspace.bridgeStartFailureInfo()?.technicalDetail;
      throw new Error(`daemon Bridge did not bind a direct listener${detail ? `: ${detail}` : ""}`);
    }
    const identity: EngineServiceIdentityV1 = {
      schemaVersion: 1,
      workspaceRoot: canonicalRoot,
      workspaceHash: hash,
      instanceId,
      pid: process.pid,
      processStartIdentity: currentProcessStartIdentity(),
      startedAt,
      bundleId: options.bundleId,
      engineVersion: options.appVersion,
      protocol: { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL },
      bridge: { instanceId: runningWorkspace.bridgeInstanceId, port: bridgePort },
    };
    if (!isEngineServiceIdentityV1(identity)) throw new Error("daemon engine produced an invalid service identity");
    const getSnapshot = () => projections.snapshot(() => buildProjections(runningWorkspace, identity));
    control = await startEngineControlServer({
      socketPath: options.controlSocketPath,
      identity,
      getSnapshot,
      readEvents: (afterSeq, limit) => journal.readAfter(afterSeq, limit),
      query: (query) => executeWorkspaceQuery(runningWorkspace, query, runtimeOpsSnapshots),
      invoke: (command) => executeWorkspaceCommand(
        runningWorkspace,
        runningActivityLog,
        stagedPayloads,
        command,
        (view) => host.onViewsChanged(view),
      ),
    });
    const runningControl = control;

    let closing: Promise<void> | undefined;
    return {
      identity,
      controlSocketPath: runningControl.socketPath,
      snapshot: getSnapshot,
      shellCount: () => runningControl.shellCount(),
      close: () => {
        closing ??= closeService(runningControl, runningWorkspace, runningActivityLog, host);
        return closing;
      },
    };
  } catch (error) {
    await control?.close().catch(() => undefined);
    await activityLog?.stop().catch(() => undefined);
    await workspace?.dispose().catch(() => undefined);
    host.dispose();
    throw error;
  }
}

async function executeWorkspaceQuery(
  workspace: Workspace,
  query: WorkspaceQueryV1,
  runtimeOpsSnapshots: RuntimeOpsSnapshotService,
): Promise<WorkspaceQueryResultV1> {
  if (query.method === "activity.context") {
    return workspaceActivityContextSuccessV1({
      schemaVersion: 1,
      context: await projectActivityContext(workspace, query.input.agent),
    });
  }
  if (query.method === "handoff.view") {
    return workspaceHandoffViewSuccessV1(await projectHandoffView({
      workspaceRoot: workspace.workspaceRoot,
      store: workspace.handoffStore,
      lastActivityAt: workspace.lastActivityAt(),
      distill: workspaceHandoffDistillOperations(workspace, { reveal: false }),
    }));
  }
  if (query.method === "sidebar.view") {
    return workspaceSidebarViewSuccessV1(await projectSidebarView(workspace, {
      observedModelFor: (agent) => runtimeOpsSnapshots.observedModelFor(workspace.workspaceRoot, workspace.wsHash, agent),
    }));
  }
  if (query.method === "task.board") {
    return workspaceMissionControlViewSuccessV1({
      schemaVersion: 1,
      board: projectMissionControlBoard(buildBoardSnapshot({
        store: workspace.taskStore,
        declaredAgents: Object.keys(workspace.config?.agents ?? {}),
        liveAdhocAgents: query.input.liveAdhocAgents,
        validationStore: workspace.validationStore,
        workspaceRoot: workspace.workspaceRoot,
      })),
    });
  }
  if (query.method === "task.detail") {
    return workspaceTaskDetailViewSuccessV1({
      schemaVersion: 1,
      detail: projectTaskDetail(workspace.taskStore, workspace.workspaceRoot, query.input.id),
    });
  }
  if (query.method === "task.studio") {
    return workspaceTaskStudioViewSuccessV1({
      schemaVersion: 1,
      studio: projectTaskStudio(workspace.taskStore, workspace.workspaceRoot, query.input.id),
    });
  }
  if (query.method === "pin.studio") {
    return workspacePinStudioViewSuccessV1({
      schemaVersion: 1,
      studio: projectPinStudio(workspace.pinStore, query.input.id),
    });
  }
  return workspaceProbeViewSuccessV1(await workspace.probeView(query.input.caller));
}

async function executeWorkspaceCommand(
  workspace: Workspace,
  activityLog: ActivityLogManager,
  stagedPayloads: StagedPayloadStore,
  command: WorkspaceCommandV1,
  onViewsChanged: (view: ViewKind) => void,
): Promise<WorkspaceCommandResultV1> {
  if (command.method === "handoff.ensure") {
    const ensured = ensureProjectHandoffFile(workspace.workspaceRoot, workspace.handoffStore);
    if (ensured.created) onViewsChanged("handoff");
    return workspaceHandoffEnsureSuccessV1(command, ensured.relativePath);
  }
  if (command.method === "handoff.distill") {
    const result = await startHandoffDistillation(
      workspaceHandoffDistillOperations(workspace, { reveal: false }),
      command.input,
    );
    return workspaceHandoffDistillSuccessV1(command, result);
  }
  if (command.method === "sidebar.mutate") {
    const result = applySidebarMutation(workspace, command.input, onViewsChanged);
    return workspaceSidebarMutationSuccessV1(command, result);
  }
  if (command.method === "studio.submit") {
    return workspaceCommandSuccessV1(command, workspace.studioSubmit(command.input));
  }
  if (command.method === "task.update") {
    await workspace.taskStore.update(command.input.id, command.input.patch);
    return workspaceCommandSuccessV1(command);
  }
  if (command.method === "task.reorder-lane") {
    await workspace.taskStore.reorderLane(command.input.status, command.input.priority, {
      orderedIds: command.input.orderedIds,
      expect: command.input.expect,
    });
    return workspaceCommandSuccessV1(command);
  }
  if (command.method === "validation.close") {
    await workspace.validationStore.closeRound(command.input.id, {
      outcome: command.input.outcome,
      result_note: command.input.result_note,
    });
    return workspaceCommandSuccessV1(command);
  }
  if (command.method === "task.prototype.review") {
    await reviewTaskPrototype(workspace.workspaceRoot, workspace.taskStore, command.input);
    // Unlike task.update, a note/rejection may mutate only attachments/<task>/prototypes.json, outside the
    // Workspace task-file watcher. Emit the authoritative view invalidation so every attached shell refreshes.
    onViewsChanged("tasks");
    return workspaceCommandSuccessV1(command);
  }
  if (command.method === "task.studio.cancel") {
    cancelTaskStudio(workspace.workspaceRoot, workspace.taskStore, command.input.taskId);
    return workspaceCommandSuccessV1(command);
  }
  if (command.method === "task.studio.apply") {
    const bytes = stagedPayloads.consume(command.input.payload, TASK_STUDIO_STAGED_PAYLOAD_MAX_BYTES);
    const payload = parseTaskStudioStagedPayloadV1(command.input.action, bytes);
    if (command.input.action === "save") {
      if (!("patch" in payload)) throw new Error("Task Studio save payload has the wrong shape");
      const saved = await saveTaskStudio(workspace.workspaceRoot, workspace.taskStore, command.input.taskId, payload.patch);
      if (saved.status === "error") throw new Error(saved.message);
      if (saved.status === "conflict") {
        return workspaceTaskStudioApplySuccessV1(command, { outcome: "conflict", message: saved.message });
      }
      onViewsChanged("tasks");
      return workspaceTaskStudioApplySuccessV1(command, { outcome: "saved" });
    }
    if (command.input.action === "put-image") {
      if (!("dataBase64" in payload) || !("mediaType" in payload)) throw new Error("Task Studio image payload has the wrong shape");
      const stored = putTaskStudioImage(workspace.workspaceRoot, command.input.taskId, payload);
      return workspaceTaskStudioApplySuccessV1(command, { outcome: "attachment-stored", ...stored });
    }
    if (command.input.action === "put-sketch") {
      if (!("sceneJson" in payload)) throw new Error("Task Studio sketch payload has the wrong shape");
      const stored = putTaskStudioSketch(workspace.workspaceRoot, command.input.taskId, payload);
      return workspaceTaskStudioApplySuccessV1(command, { outcome: "attachment-stored", ...stored });
    }
    if (!("html" in payload)) throw new Error("Task Studio prototype payload has the wrong shape");
    importTaskStudioPrototype(workspace.workspaceRoot, command.input.taskId, payload);
    onViewsChanged("tasks");
    return workspaceTaskStudioApplySuccessV1(command, { outcome: "prototype-imported" });
  }
  if (command.method === "pin.studio.apply") {
    const bytes = stagedPayloads.consume(command.input.payload, PIN_STUDIO_STAGED_PAYLOAD_MAX_BYTES);
    const payload = parsePinStudioStagedPayloadV1(command.input.action, bytes);
    if (command.input.action === "save") {
      if (!("patch" in payload)) throw new Error("Pin Studio save payload has the wrong shape");
      const saved = savePinStudio(workspace.pinStore, command.input.pinId, payload.patch);
      if (saved.status === "error") throw new Error(saved.message);
      onViewsChanged("pins");
      return workspacePinStudioApplySuccessV1(command, { outcome: "saved", pinId: saved.pinId });
    }
    if (command.input.action === "put-image") {
      if (!("dataBase64" in payload) || !("mediaType" in payload)) throw new Error("Pin Studio image payload has the wrong shape");
      const stored = putPinStudioImage(workspace.workspaceRoot, payload);
      return workspacePinStudioApplySuccessV1(command, { outcome: "attachment-stored", ...stored });
    }
    if (!("sceneJson" in payload)) throw new Error("Pin Studio sketch payload has the wrong shape");
    const stored = putPinStudioSketch(workspace.workspaceRoot, workspace.pinStore, command.input.pinId, payload);
    return workspacePinStudioApplySuccessV1(command, { outcome: "attachment-stored", ...stored });
  }
  if (command.method === "agent.input") {
    await sendManagedAgentInput(workspace, command.input.agent, command.input.text, command.input.submit);
    return workspaceCommandSuccessV1(command);
  }
  const agent = command.input.agent;
  switch (command.method) {
    case "agent.start":
      await startAgentWithActivity(workspace, activityLog, agent);
      break;
    case "agent.stop":
      await workspace.manager.stopGracefully(agent);
      break;
    case "agent.kill":
      await workspace.manager.kill(agent);
      break;
    case "agent.restart":
      await restartAgentWithActivity(workspace, activityLog, agent);
      break;
    case "agent.resume":
      await resumeAgentWithActivity(workspace, activityLog, agent);
      break;
  }
  return workspaceCommandSuccessV1(command);
}

class EngineProjectionCoordinator {
  private buffered: DaemonHostEvent[] = [];
  private snapshotting = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly journal: EngineEventJournal,
    private readonly engineInstanceId: string,
  ) {}

  record(event: DaemonHostEvent): void {
    if (this.snapshotting) {
      this.buffered.push(event);
      return;
    }
    appendHostEvent(this.journal, event);
  }

  snapshot(build: () => Promise<Record<string, unknown>>): Promise<WorkspaceSnapshotEnvelopeV1> {
    const result = this.tail.then(async () => {
      this.snapshotting = true;
      try {
        const snapshot: WorkspaceSnapshotEnvelopeV1 = {
          schemaVersion: 1,
          engineInstanceId: this.engineInstanceId,
          seq: this.journal.latestSeq,
          projections: await build(),
        };
        // Events raised while projection reads awaited are still buffered, so seq is a sound cursor:
        // every later state transition is replayed after this snapshot rather than silently skipped.
        snapshot.seq = this.journal.latestSeq;
        assertSnapshotBounded(snapshot);
        return snapshot;
      } finally {
        this.snapshotting = false;
        const pending = this.buffered;
        this.buffered = [];
        for (const event of pending) appendHostEvent(this.journal, event);
      }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function buildProjections(
  workspace: Workspace,
  identity: EngineServiceIdentityV1,
): Promise<WorkspaceCoreProjectionsV1 & Record<string, unknown>> {
  const agents = await workspace.manager.list();
  const tasks = workspace.taskStore.listRaw();
  const pins = workspace.pinStore.list();
  const handoff = workspace.handoffStore.snapshot(workspace.lastActivityAt());
  const schedules = workspace.scheduler.list();
  const taskList = boundedList(tasks, TASK_SNAPSHOT_LIMIT, (task) => ({
    id: task.id,
    title: boundedText(task.title, 160),
    status: task.status,
    priority: task.priority ?? null,
    kind: task.kind ? boundedText(task.kind, 64) : null,
    assignee: task.assignee ? boundedText(task.assignee, 64) : null,
    awaitingHuman: task.awaitingHuman !== undefined,
    updatedAt: task.updatedAt,
  }));
  const taskCounts = Object.fromEntries(
    ["inbox", "triaged", "active", "landed", "done", "dropped"].map((status) => [
      status,
      tasks.filter((task) => task.status === status).length,
    ]),
  );

  return {
    workspace: {
      root: workspace.workspaceRoot,
      hash: workspace.wsHash,
      folderName: workspace.folderName,
      configValid: workspace.configFailure === undefined,
      configFailure: workspace.configFailure
        ? {
            file: boundedText(workspace.configFailure.file, 160),
            errors: workspace.configFailure.errors.slice(0, 10).map((error) => boundedText(error, 500)),
            at: workspace.configFailure.at,
          }
        : null,
    },
    bridge: {
      instanceId: identity.bridge.instanceId,
      port: identity.bridge.port,
      url: workspace.bridgeUrl() ?? null,
      direct: workspace.bridge.listenerPort === identity.bridge.port,
    },
    agents: boundedList(agents, AGENT_SNAPSHOT_LIMIT, (agent) => {
      const attention = workspace.attentionOf(agent.name)?.state;
      return {
        name: boundedText(agent.name, 128),
        session: boundedText(agent.session, 256),
        kind: agent.kind,
        running: agent.running,
        stopping: agent.stopping ?? false,
        stopFailed: agent.stopFailed ?? false,
        declared: agent.declared,
        dead: agent.dead,
        crashed: agent.crashed,
        ...(attention ? { attention } : {}),
        ...(agent.exitCode !== undefined ? { exitCode: agent.exitCode } : {}),
        ...(agent.parent ? { parent: boundedText(agent.parent, 128) } : {}),
        ...(agent.delegator ? { delegator: boundedText(agent.delegator, 128) } : {}),
        ...(agent.declaredOwner ? { declaredOwner: boundedText(agent.declaredOwner, 128) } : {}),
      };
    }),
    tasks: {
      ...taskList,
      counts: taskCounts,
    },
    pins: boundedList(pins, PIN_SNAPSHOT_LIMIT, (pin) => ({
      id: pin.id,
      text: boundedText(pin.text, 180),
      by: boundedText(pin.by, 64),
      done: pin.done,
      createdAt: pin.createdAt,
      updatedAt: pin.updatedAt ?? null,
    })),
    handoff: {
      exists: handoff.exists,
      revision: handoff.revision,
      pendingCount: handoff.pendingCount,
      staleness: handoff.staleness,
      updatedAt: handoff.meta?.updated_at ?? null,
      updatedBy: handoff.meta?.updated_by ?? null,
    },
    schedules: boundedList(schedules, SCHEDULE_SNAPSHOT_LIMIT, (schedule) => ({
      name: boundedText(schedule.name, 128),
      paused: schedule.paused,
      lastRun: schedule.lastRun ?? null,
      nextRun: schedule.nextRun ?? null,
    })),
  } satisfies WorkspaceCoreProjectionsV1 & Record<string, unknown>;
}

function boundedList<T, R>(values: readonly T[], limit: number, map: (value: T) => R): {
  total: number;
  truncated: boolean;
  items: R[];
} {
  return {
    total: values.length,
    truncated: values.length > limit,
    items: values.slice(0, limit).map(map),
  };
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function appendHostEvent(journal: EngineEventJournal, event: DaemonHostEvent): void {
  const { kind, at, ...payload } = event;
  journal.append(kind, payload, at);
}

function assertSnapshotBounded(snapshot: WorkspaceSnapshotEnvelopeV1): void {
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new Error("engine bootstrap snapshot exceeds the control-channel size budget");
  }
}

function currentProcessStartIdentity(): string {
  if (process.platform !== "linux") {
    throw new Error(`persistent engine launcher is not yet supported on ${process.platform}`);
  }
  const observed = readLinuxProcessIdentity(process.pid);
  if (observed.state !== "exact") {
    const reason = observed.state === "unknown" ? observed.reason : "current process disappeared";
    throw new Error(`persistent engine process identity is unavailable: ${reason}`);
  }
  return `linux:${observed.bootId}:${observed.processStart}`;
}

function canonicalWorkspaceRoot(workspaceRoot: string): string {
  const canonical = fs.realpathSync(workspaceRoot);
  if (!fs.statSync(canonical).isDirectory()) throw new Error("engine workspace root is not a directory");
  return canonical;
}

function validateOptions(options: StartDaemonEngineServiceOptions): void {
  if (!options.appVersion.trim() || options.appVersion.length > 128) throw new Error("engine appVersion is invalid");
  if (!isSha256(options.bundleId)) throw new Error("engine bundleId must be a sha256 digest");
  if (!path.isAbsolute(options.storageRoot) || !path.isAbsolute(options.mediaRoot) || !path.isAbsolute(options.controlSocketPath)) {
    throw new Error("engine paths must be absolute");
  }
}

async function closeService(
  control: RunningEngineControlServer,
  workspace: Workspace,
  activityLog: ActivityLogManager,
  host: DaemonEngineHost,
): Promise<void> {
  const errors: unknown[] = [];
  try { await control.close(); } catch (error) { errors.push(error); }
  try { await activityLog.stop(); } catch (error) { errors.push(error); }
  try { await workspace.dispose(); } catch (error) { errors.push(error); }
  try { host.dispose(); } catch (error) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, "persistent engine shutdown failed");
}
