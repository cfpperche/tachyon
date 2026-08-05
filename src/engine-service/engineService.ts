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
import { readLinuxProcessIdentity } from "../runtime/processIdentity.js";
import { EDITOR_HUMAN_ACTOR, ENGINE_CONTROL_VALIDATION_ACTOR } from "../validations/types.js";
import { wakeValidationClosedAuthors } from "../validations/validationCloseNotify.js";
import { DaemonEngineHost, type DaemonHostEvent, type DaemonSettingsSnapshot } from "../workspace/DaemonEngineHost.js";
import type { ViewKind } from "../workspace/EngineHost.js";
import { Workspace } from "../workspace/Workspace.js";
import { sendManagedAgentInput } from "../agents/agentInputService.js";
import { openExecutionLedger } from "../executionGraph/executionLedger.js";
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
import { CodexAppServerObservationSource } from "../runtimeObservability/codexAppServerSource.js";
import { ClaudeStatusLineObservationSource } from "../runtimeObservability/claudeStatusLineSource.js";
import { ClaudeStatusLineCaptureTransport } from "../runtimeObservability/claudeStatusLineCapture.js";
import { ProviderObservationPreferences, type ProviderObservationStatePort } from "../runtimeObservability/preferences.js";
import { ProviderObservationService } from "../runtimeObservability/service.js";
import { ResourceSampler } from "../attention/resourceSample.js";
import { executeExtensionCommand, executeExtensionQuery } from "./extensionOperationService.js";
import { getEngineLogRing } from "./engineLogRing.js";
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
import { engineDaemonStateRoot } from "./daemonStateStore.js";
import { EngineEventJournal, pruneEngineEventJournals } from "./eventJournal.js";
import { StagedPayloadStore } from "./stagedPayloadStore.js";
import type { HumanInboxKind } from "../humanInbox/model.js";
import { GlobalTmuxWatchdog } from "./tmuxAuthority.js";
import {
  ENGINE_SHELL_PROTOCOL,
  isEngineServiceIdentityV1,
  isEngineReleaseChannel,
  isSha256,
  workspaceActivityContextSuccessV1,
  workspaceCommandSuccessV1,
  workspaceHandoffDistillSuccessV1,
  workspaceHandoffEnsureSuccessV1,
  workspaceHandoffViewSuccessV1,
  workspaceSidebarMutationSuccessV1,
  workspaceSidebarViewSuccessV1,
  workspaceRuntimeOpsViewSuccessV1,
  workspaceExtensionCommandSuccessV1,
  workspaceExtensionQuerySuccessV1,
  workspaceMissionControlViewSuccessV1,
  workspacePinStudioApplySuccessV1,
  workspacePinStudioViewSuccessV1,
  workspaceProbeViewSuccessV1,
  workspaceTaskDetailViewSuccessV1,
  workspaceTaskStudioApplySuccessV1,
  workspaceTaskStudioViewSuccessV1,
  type EngineServiceIdentityV1,
  type EngineReleaseChannel,
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
  channel?: EngineReleaseChannel;
  settings?: DaemonSettingsSnapshot;
}

export interface RunningDaemonEngineService {
  readonly identity: EngineServiceIdentityV1;
  readonly controlSocketPath: string;
  snapshot(): Promise<WorkspaceSnapshotEnvelopeV1>;
  shellCount(): number;
  close(): Promise<void>;
}

/** Routes a persisted approval request to the editor shell without carrying any decision authority. */
/**
 * t-8e9b5e — where "Review" takes a human, per Inbox kind.
 *
 * A `Record` over `HumanInboxKind` rather than a switch, so a FOURTH kind added to
 * `HUMAN_INBOX_KINDS` does not compile until it declares where its doorbell leads. That is the whole
 * guard: the defect this replaced was a kind that existed in the Inbox and rang nothing, and no test
 * would have caught it because nothing claimed to enumerate the kinds.
 *
 * Every kind lands on its exact Inbox item. Approval is the most important case: it blocks an agent,
 * so landing on the queue rather than the request would make the human hunt while work is stopped.
 */
const INBOX_REVIEW_TARGET: Record<HumanInboxKind, (workspaceHash: string, id: string) => [string, ...unknown[]]> = {
  approval: (workspaceHash, id) => ["tachyon.openHumanInbox", workspaceHash, { kind: "approval", id }],
  validation: (workspaceHash, id) => ["tachyon.openHumanInbox", workspaceHash, { kind: "validation", id }],
  "saved-agent-proposal": (workspaceHash, id) =>
    ["tachyon.openHumanInbox", workspaceHash, { kind: "saved-agent-proposal", id }],
  "saved-agent-removal": (workspaceHash, id) =>
    ["tachyon.openHumanInbox", workspaceHash, { kind: "saved-agent-removal", id }],
  "schedule-proposal": (workspaceHash, id) =>
    ["tachyon.openHumanInbox", workspaceHash, { kind: "schedule-proposal", id }],
};

/**
 * t-8e9b5e — one doorbell for every Human Inbox kind.
 *
 * There were two near-identical routers, one per kind, and a third kind with none: a Saved Agent
 * proposal landed in the Inbox as a first-class item (`HUMAN_INBOX_KINDS` lists it) and rang nothing.
 * A human only found it by going to look, and proposals expire in 24h — so one nobody saw did not
 * wait, it died.
 *
 * The shape is t-b4a799's: two paths to the same product effect ("a human must decide something"),
 * one of them missing. The fix is not a third copy — it is the one thing all three share.
 */
export function routeHumanInboxItem(
  host: Pick<DaemonEngineHost, "t" | "notify" | "executeCommand">,
  workspaceHash: string,
  item: { kind: HumanInboxKind; id: string; message: string },
): void {
  const [command, ...args] = INBOX_REVIEW_TARGET[item.kind](workspaceHash, item.id);
  host.notify(item.message, "info", [{
    label: host.t("Review"),
    // t-ee2f19 — the same destination, as data, so the doorbell still rings after a reload. These
    // items are exactly the ones that must not be lost to a restart: an approval or a proposal expires
    // while it waits, so a notice that survives with a dead button is a decision quietly running out.
    route: { command, args },
    run: async () => {
      // t-5ca73a — a Review that cannot open its window must SAY so.
      //
      // Invoking dismisses the notice before the action runs, so a silent failure costs the human the
      // only pointer they had: the attention vanishes, no screen opens, and the sole record is an
      // `ui-unavailable` line in the engine journal. That silence is what turned a one-line deadlock
      // into hours of measuring — the deadlock itself is fixed in WorkspaceClient, but a shell can
      // still be absent or closing, and then this is the difference between a dead end and a fact.
      try {
        await host.executeCommand(command, ...args);
      } catch (error) {
        host.notify(
          host.t(
            "Could not open '{0}' — the editor did not respond. It is still waiting for you in the Inbox: {1} {2}",
            command,
            item.kind,
            item.id,
          ),
          "error",
        );
        throw error;
      }
    },
  }]);
}

export function routeHumanApprovalRequest(
  host: Pick<DaemonEngineHost, "t" | "notify" | "executeCommand">,
  workspaceHash: string,
  request: { id: string; requester: string },
): void {
  routeHumanInboxItem(host, workspaceHash, {
    kind: "approval",
    id: request.id,
    message: host.t("Approval request {0} from '{1}'", request.id, request.requester),
  });
}

/** t-8e9b5e — the third kind, which had no doorbell at all until this. */
export function routeSavedAgentProposal(
  host: Pick<DaemonEngineHost, "t" | "notify" | "executeCommand">,
  workspaceHash: string,
  proposal: { id: string; name: string; proposer: string },
): void {
  routeHumanInboxItem(host, workspaceHash, {
    kind: "saved-agent-proposal",
    id: proposal.id,
    message: host.t(
      "Saved Agent proposal {0} — '{1}' proposed by '{2}'",
      proposal.id,
      proposal.name,
      proposal.proposer,
    ),
  });
}

/** t-afe120 — removal proposals share the create proposal's doorbell doctrine. */
export function routeSavedAgentRemovalProposal(
  host: Pick<DaemonEngineHost, "t" | "notify" | "executeCommand">,
  workspaceHash: string,
  proposal: { id: string; name: string; proposer: string },
): void {
  routeHumanInboxItem(host, workspaceHash, {
    kind: "saved-agent-removal",
    id: proposal.id,
    message: host.t(
      "Saved Agent removal proposal {0} — retire '{1}' (from '{2}')",
      proposal.id,
      proposal.name,
      proposal.proposer,
    ),
  });
}

export function routeScheduleProposal(
  host: Pick<DaemonEngineHost, "t" | "notify" | "executeCommand">,
  workspaceHash: string,
  proposal: { id: string; name: string; proposer: string },
): void {
  routeHumanInboxItem(host, workspaceHash, {
    kind: "schedule-proposal",
    id: proposal.id,
    message: host.t("Schedule proposal {0} — '{1}' proposed by '{2}'", proposal.id, proposal.name, proposal.proposer),
  });
}

/**
 * t-e76acc — the validation-side twin of `routeHumanApprovalRequest`. Same notice, same Review
 * affordance, and the same total absence of decision authority; it opens the Human Inbox rather than
 * the per-kind section, because "what is waiting on me" is now one queue. It deliberately does NOT
 * write into any agent's session: nothing is blocked on this the way an agent is blocked on an
 * approval.
 *
 * t-1f6d02 — Review deep-links the **exact** validation's inbox-item route (not the bare inbox list).
 * A gone/stale item still lands on the list via the existing Control handshake fallback.
 */
export function routeHumanValidationPending(
  host: Pick<DaemonEngineHost, "t" | "notify" | "executeCommand">,
  workspaceHash: string,
  validation: { id: string; title: string; author: string },
): void {
  routeHumanInboxItem(host, workspaceHash, {
    kind: "validation",
    id: validation.id,
    message: host.t(
      "Validation {0} needs a human — '{1}' (from '{2}')",
      validation.id,
      validation.title,
      validation.author,
    ),
  });
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
  pruneEngineEventJournals(path.join(options.storageRoot, "events"), instanceId);
  const projections = new EngineProjectionCoordinator(journal, instanceId);
  // SDD 480 Phase 2 — deliberately NOT `journal` above. That one is keyed to `instanceId`, a fresh
  // uuid per start, so hanging the execution graph off it would discard the graph on every restart —
  // the exact opposite of the criterion that a restarted Control rebuilds the same graph. This opens
  // its own journal on a stable, workspace-scoped stream and keeps every guarantee that primitive was
  // chosen for.
  const executionLedger = openExecutionLedger({ storageRoot: options.storageRoot, workspaceHash: hash });
  const stagedPayloads = new StagedPayloadStore(path.dirname(options.controlSocketPath));
  stagedPayloads.cleanupStale();
  let workspace: Workspace | undefined;
  let control: RunningEngineControlServer | undefined;
  let activityLog: ActivityLogManager | undefined;
  let providerObservations: ProviderObservationService | undefined;
  let providerObservationSubscription: { dispose(): void } | undefined;
  let tmuxWatchdog: GlobalTmuxWatchdog | undefined;
  const host = new DaemonEngineHost({
    storageRoot: engineDaemonStateRoot(options.storageRoot),
    mediaRoot: options.mediaRoot,
    appVersion: options.appVersion,
    settings: options.settings,
    emit: (event) => projections.record(event),
    requestUi: (request) => control?.requestUi(request)
      ?? Promise.reject(new Error("no capable Tachyon editor shell is attached")),
  });
  try {
    tmuxWatchdog = new GlobalTmuxWatchdog({
      onRecovered: (outcome) => {
        console.warn(`[tachyon] wedged tmux server recovered by persistent engine:\n${outcome.diagnostics}`);
        host.notify("the tmux server was wedged — auto-recovered. Restart your agents to continue.", "warn");
      },
      onError: (error) => {
        host.notify(`tmux watchdog failed: ${error instanceof Error ? error.message : String(error)}`, "warn");
      },
    });
    await tmuxWatchdog.start();
    const runningTmuxWatchdog = tmuxWatchdog;
    const providerState: ProviderObservationStatePort = {
      get: <T>(key: string) => host.getState<T>(key),
      update: (key, value) => host.setState(key, value),
    };
    const providerPreferences = new ProviderObservationPreferences(providerState);
    const claudeStatusLineCapture = new ClaudeStatusLineCaptureTransport(host.globalStoragePath(), providerPreferences);
    providerObservations = new ProviderObservationService(
      providerPreferences,
      [
        new CodexAppServerObservationSource(),
        new ClaudeStatusLineObservationSource({ readCapture: claudeStatusLineCapture.readCapture }),
      ],
      {
        state: providerState,
        onPreferenceChanged: (provider) => {
          if (provider === "claude" || provider === "codex") {
            claudeStatusLineCapture.clearProvider(provider);
          }
        },
      },
    );
    const observationsForCondition = providerObservations;
    workspace = await Workspace.createDaemon(canonicalRoot, {
      host,
      // t-458497 — the cached provider-observation state the runtime-condition projection reads. The
      // channel inventory comes from the sources registered just above, so "grok has no quota
      // channel" is the ABSENCE of a grok source here rather than a name written down somewhere.
      runtimeQuotaObservations: () => ({
        channels: observationsForCondition.describeChannels(),
        preferences: providerPreferences.all(),
        observations: observationsForCondition.snapshot(),
      }),
      onViewsChanged: (view) => host.onViewsChanged(view),
      onApprovalRequested: (approvalWorkspace, request) => {
        routeHumanApprovalRequest(host, approvalWorkspace.wsHash, request);
      },
      onSavedAgentProposed: (proposalWorkspace, proposal) => {
        routeSavedAgentProposal(host, proposalWorkspace.wsHash, proposal);
      },
      onSavedAgentRemovalProposed: (proposalWorkspace, proposal) => {
        routeSavedAgentRemovalProposal(host, proposalWorkspace.wsHash, proposal);
      },
      onScheduleProposed: (proposalWorkspace, proposal) => {
        routeScheduleProposal(host, proposalWorkspace.wsHash, proposal);
      },
      onHumanValidationPending: (validationWorkspace, validation) => {
        routeHumanValidationPending(host, validationWorkspace.wsHash, validation);
      },
      claudeStatusLineCapture,
      piBridgeExtensionPath: path.join(__dirname, "pi-bridge-extension.mjs"),
      // SDD 480 Phase 2 — the line that turns the graph from two tested halves into a real record:
      // every seam's sealed event now reaches a durable, sanitized, byte-bounded ledger. Refusals are
      // counted rather than silent, but recording must never throw into a spawn path, so the guard is
      // here as well as inside each seam.
      recordExecution: (event) => { try { executionLedger.record(event); } catch { /* observation only */ } },
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
    const runningProviderObservations = providerObservations;
    providerObservationSubscription = runningProviderObservations.onDidChange(() => host.onViewsChanged("agents"));
    runningProviderObservations.start();
    const sidebarResources = new ResourceSampler();
    const runtimeOpsSnapshots = new RuntimeOpsSnapshotService(() => [runningWorkspace], {
      providerObservations: () => ({
        preferences: providerPreferences.all(),
        observations: runningProviderObservations.snapshot(),
      }),
      resourceSampler: sidebarResources,
    });

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
      ...(options.channel === undefined ? {} : { channel: options.channel }),
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
      onShellAttached: () => host.replayUiRequests(),
      query: (query) => executeWorkspaceQuery(
        runningWorkspace,
        query,
        runtimeOpsSnapshots,
        runningProviderObservations,
        sidebarResources,
      ),
      invoke: (command) => executeWorkspaceCommand(
        runningWorkspace,
        runningActivityLog,
        stagedPayloads,
        command,
        (view) => host.onViewsChanged(view),
        runningProviderObservations,
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
        closing ??= closeService(
          runningControl,
          runningWorkspace,
          runningActivityLog,
          runningProviderObservations,
          providerObservationSubscription,
          runningTmuxWatchdog,
          host,
        );
        return closing;
      },
    };
  } catch (error) {
    await control?.close().catch(() => undefined);
    await activityLog?.stop().catch(() => undefined);
    providerObservationSubscription?.dispose();
    providerObservations?.dispose();
    tmuxWatchdog?.close();
    await workspace?.dispose().catch(() => undefined);
    host.dispose();
    throw error;
  }
}

async function executeWorkspaceQuery(
  workspace: Workspace,
  query: WorkspaceQueryV1,
  runtimeOpsSnapshots: RuntimeOpsSnapshotService,
  providerObservations: ProviderObservationService,
  sidebarResources: ResourceSampler,
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
      resourceSampler: sidebarResources,
      // t-aa2780 — the sidebar's engine-error dot reads the SAME ring the control server's `health` op
      // reports `logHasError` from, in the same process that owns it. Not a second source of truth:
      // one ring, two readers. No ring installed (a host that never called installEngineLogRing) stays
      // `undefined`, so the field is omitted rather than asserting "no errors" about a ring nobody read.
      engineLogHasError: () => getEngineLogRing()?.hasError(),
    }));
  }
  if (query.method === "runtime-ops.view") {
    if (query.input.refreshDetection === true) {
      runtimeOpsSnapshots.invalidateDetection();
      await providerObservations.refreshAll();
    }
    return workspaceRuntimeOpsViewSuccessV1(await runtimeOpsSnapshots.snapshot());
  }
  if (query.method === "extension.query") {
    return workspaceExtensionQuerySuccessV1(query, await executeExtensionQuery({ workspace }, query.input));
  }
  if (query.method === "task.board") {
    return workspaceMissionControlViewSuccessV1({
      schemaVersion: 1,
      board: projectMissionControlBoard(buildBoardSnapshot({
        store: workspace.taskStore,
        declaredAgents: Object.keys(workspace.config?.agents ?? {}),
        liveTemporaryAgents: query.input.liveTemporaryAgents,
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
  providerObservations: ProviderObservationService,
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
    const result = await applySidebarMutation(workspace, command.input, onViewsChanged);
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
    // t-ebde5f — this command is also reachable by a raw same-uid control-socket speaker. The attach
    // hello is self-asserted, so the daemon can prove the channel but no human or other actor behind it.
    const closed = await workspace.validationStore.closeRound(command.input.id, {
      actor: ENGINE_CONTROL_VALIDATION_ACTOR,
      outcome: command.input.outcome,
      result_note: command.input.result_note,
    });
    // t-c6c4ad — durable close first (never undone). Best-effort FIXED inject into author/assignee
    // live sessions mirrors approval resolve; offline agents re-read the closed validation on resume.
    // Inbox + legacy Validations UI both route through this single command, so the wake fires once.
    await wakeValidationClosedAuthors({
      validation: closed,
      outcome: command.input.outcome,
      listEntries: () => workspace.manager.list(),
      inject: async (session, text) => {
        await workspace.tmux.sendSubmittedLine(session, text);
        return { receipt: `tmux:${session}` };
      },
    });
    return workspaceCommandSuccessV1(command);
  }
  if (command.method === "validation.assign") {
    await workspace.validationStore.update(command.input.id, {
      actor: EDITOR_HUMAN_ACTOR,
      assignee: command.input.assignee,
      ...(command.input.expect ? { expect: command.input.expect } : {}),
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
      if (saved.status === "conflict") throw new Error(saved.message);
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
    // t-348c9a — refuse submitted input when a fresh composer probe sees a human draft
    // (cached attention.list alone is too stale for write guards; see AttentionMonitor.probeComposerOccupied).
    if (command.input.submit) {
      const probe = await workspace.monitor.probeComposerOccupied(command.input.agent);
      const occupied =
        probe === true
        || (probe === undefined && workspace.attentionOf(command.input.agent)?.composerOccupied === true);
      if (occupied) {
        throw new Error(
          `agent '${command.input.agent}' has a non-empty composer draft — refused-composer: clear or submit the terminal draft first`,
        );
      }
    }
    await sendManagedAgentInput(workspace, command.input.agent, command.input.text, command.input.submit);
    return workspaceCommandSuccessV1(command);
  }
  if (command.method === "extension.invoke") {
    const value = await executeExtensionCommand(
      { workspace, activityLog, providerObservations, stagedPayloads, onViewsChanged },
      command.input,
    );
    return workspaceExtensionCommandSuccessV1(command, value);
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
    case "agent.restart": {
      const stop = "stop" in command.input ? command.input.stop : undefined;
      const session = "session" in command.input ? command.input.session : undefined;
      await restartAgentWithActivity(workspace, activityLog, agent, {
        ...(stop !== undefined ? { stop } : {}),
        ...(session !== undefined ? { session } : {}),
      });
      break;
    }
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
      const live = workspace.attentionOf(agent.name);
      const attention = live?.state;
      return {
        name: boundedText(agent.name, 128),
        session: boundedText(agent.session, 256),
        kind: agent.kind,
        running: agent.running,
        stopping: agent.stopping ?? false,
        stopFailed: agent.stopFailed ?? false,
        lifetime: agent.lifetime,
        dead: agent.dead,
        crashed: agent.crashed,
        ...(attention ? { attention } : {}),
        ...(live?.unseen ? { unseen: true } : {}),
        ...(workspace.runtimeConfigPendingAgents().includes(agent.name) ? { configurationPending: true } : {}),
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
  if (options.channel !== undefined && !isEngineReleaseChannel(options.channel)) throw new Error("engine channel is invalid");
  if (!path.isAbsolute(options.storageRoot) || !path.isAbsolute(options.mediaRoot) || !path.isAbsolute(options.controlSocketPath)) {
    throw new Error("engine paths must be absolute");
  }
}

async function closeService(
  control: RunningEngineControlServer,
  workspace: Workspace,
  activityLog: ActivityLogManager,
  providerObservations: ProviderObservationService,
  providerObservationSubscription: { dispose(): void } | undefined,
  tmuxWatchdog: GlobalTmuxWatchdog,
  host: DaemonEngineHost,
): Promise<void> {
  const errors: unknown[] = [];
  try { await control.close(); } catch (error) { errors.push(error); }
  try { await activityLog.stop(); } catch (error) { errors.push(error); }
  try { providerObservationSubscription?.dispose(); } catch (error) { errors.push(error); }
  try { providerObservations.dispose(); } catch (error) { errors.push(error); }
  try { tmuxWatchdog.close(); } catch (error) { errors.push(error); }
  try { await workspace.dispose(); } catch (error) { errors.push(error); }
  try { host.dispose(); } catch (error) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, "persistent engine shutdown failed");
}
