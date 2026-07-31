import * as vscode from "vscode";
import { sharedGlobalSettings } from "../config/globalSettings.js";
import type { CockpitGlobalSettingsState } from "../cockpit/model.js";
import * as fs from "node:fs";
import { panelIcon } from "./shared/panelIcon.js";
import { renderWebviewShell } from "./shared/shell.js";
import { resolveCockpitSection } from "../cockpit/resolveSection.js";
import {
  routes,
  routeKey,
  decodePanelState as decodeCockpitPanelState,
  navSection,
  isSection,
  type CockpitRoute,
  type CockpitNonStudioRoute,
  type CockpitPanelState,
} from "../cockpit/route.js";
import { markCockpitSingletonClaimed, clearCockpitSingletonClaim } from "./cockpitSingleton.js";
import { READY } from "./shared/ready.js";
import {
  buildCockpitModel,
  formatCockpitDiagnostics,
  type CockpitModel,
  type CockpitSectionId,
  type CockpitWorkspaceBundle,
  COLLECT_EVERYTHING,
  collectNeedsFor,
  type CockpitCollectNeeds,
} from "../cockpit/model.js";
import {
  initMessage,
  modelMessage,
  routePendingMessage,
  routeReadyMessage,
  toastMessage,
  type CockpitAction,
  type CockpitStrings,
} from "./cockpit/messages.js";
import type { WorkspaceMissionControlTarget } from "../shell/MissionControlTarget.js";
import type { WorkspacePresentationTarget, WorkspaceProbePresentationTarget, WorkspaceStudioTarget } from "../shell/WorkspacePresentation.js";
import {
  snapshotMessage,
  taskErrorMessage,
  type MissionControlAction,
} from "./mission-control/messages.js";
import { buildMissionVm, MissionAgentLists } from "../cockpit/missionVm.js";
import { buildTaskDetailVm, emptyTombstoneVm } from "../cockpit/taskDetailVm.js";
import { taskMessage, taskDetailErrorMessage, type TaskDetailAction } from "./task-detail/messages.js";
import type { WorkspaceTaskDetailTarget } from "../shell/TaskDetailTarget.js";
import { startActivityFeed, type ActivityFeed } from "../cockpit/activityFeed.js";
import type { WorkspaceActivityTarget } from "../shell/ActivityTarget.js";
import {
  activityMessage,
  imageDataMessage,
  shareAgentTargetsMessage,
  SHARE_EXTERNAL,
  COPY_SHARE_TEXT,
  SHARE_TO_AGENT,
  type ActivityWebviewMessage,
  type ExternalShareChannel,
} from "./activity/messages.js";
import { withActivityShareKeys, resolveActivityShare, internalSharePrompt } from "../activity/activityShare.js";
import type { ActivityViewModel } from "../activity/activityView.js";
import { probesMessage } from "./probes/messages.js";
import { handoffMessage, type HandoffAction } from "./handoff/messages.js";
import type { HandoffViewModel, HandoffNoteVM, HandoffDistillTargetVM } from "./handoff/handoffViewModel.js";
import { HANDOFF_DISTILL_PROFILES, normalizeAdditionalInstruction, normalizeHandoffDistillArgs } from "../handoff/distill.js";
import { parseHandoffDistillInputV1, type HandoffDistillInputV1 } from "../runtime-api/handoffCommands.js";
import type { WorkspaceHandoffTarget } from "../shell/HandoffTarget.js";
import {
  approvalsMessage,
  approvalErrorMessage,
  type ApprovalAction,
} from "./approval/messages.js";
import { buildApprovalViewModel, listPendingApprovalViewItems } from "./approval/viewModel.js";
import { buildValidationsViewModel } from "./validations/viewModel.js";
import { buildHumanInboxViewModel, buildHumanInboxItemViewModel } from "./human-inbox/viewModel.js";
import { readLiveSavedAgentProposalQueue } from "../agents/savedAgentProposalStore.js";
import { buildSavedAgentProposalReview } from "../agents/savedAgentProposalReview.js";
import { denySavedAgentProposal, type SavedAgentCommitResult } from "../agents/savedAgentProposalCommit.js";
import { workspaceConfigSha256 } from "../config/agentProfileGrants.js";
import {
  humanInboxMessage,
  humanInboxErrorMessage,
  humanInboxItemMessage,
  type HumanInboxAction,
} from "./human-inbox/messages.js";
import { makeInboxArtifactLoader } from "../humanInbox/loadArtifact.js";
import type { StaleAfter } from "../humanInbox/model.js";
import { parseCardTemplate } from "../sidebar/cardTemplate.js";
import {
  validationsMessage,
  validationErrorMessage,
  type ValidationsAction,
} from "./validations/messages.js";
import type { ApprovalDecision } from "../bridge/approvalRequest.js";
import {
  runtimeOpsSnapshotMessage,
  runtimeOpsSnapshotUnavailableMessage,
  runtimeOpsSessionInspectionMessage,
  isRuntimeOpsSetProviderObservationAction,
  isRuntimeOpsInspectSessionAction,
} from "./runtime-ops/messages.js";
import type { RuntimeOpsSnapshot, RuntimeOpsProviderV2 } from "../runtimeOps/types.js";
import type { InspectedSession } from "../runtimeOps/sessionInspection.js";
import { runtimeConfigSnapshotMessage, runtimeConfigSnapshotUnavailableMessage } from "./runtime-config/messages.js";
import type { RuntimeConfigChange, RuntimeConfigControlSnapshot, RuntimeConfigRuntime } from "../runtimeConfig/types.js";
import {
  type InspectorStrings,
  type InspectorAction,
} from "./inspector/messages.js";
import { buildInspectorModel, type InspectorModel, type TmuxServerSnapshot } from "../inspector/model.js";
import type { PaneSnapshot } from "../tmux/TmuxService.js";
import { notify, showNotification } from "../workspace/NotificationService.js";
import type { PluginsPanelManager } from "./PluginsPanel.js";
import { isStudioRoute, parentRoute } from "../cockpit/route.js";
import {
  reconcileStudioTeardown,
  stopStudioBinding,
  ensureStudioBinding,
  handleStudioMessage,
  handleStudioNavCheckpointAck,
  beginStudioNavTransaction,
  currentStudioBindingFor,
  refreshStudioReferenceData,
  sendStudioLoad,
  type StudioRoute,
} from "../cockpit/studioHost.js";
import { makeStudioAdapterFactory, makeStudioDomainDispatch, type CockpitStudios } from "../cockpit/studioRegistry.js";
import type { SealedExecutionEvent } from "../executionGraph/eventSchema.js";
import { indexExecutionDetail, projectExecutions } from "../executionGraph/executionProjection.js";
import { engineCurrencyNote, type EngineCurrency } from "../engine-service/engineCurrency.js";
import { buildExecutionGraphVm, type ExecutionGraphVm } from "../cockpit/executionGraphVm.js";
export type { CockpitStudios };

export const COCKPIT_VIEW_TYPE = "tachyonCockpit";

// t-610705 (Phase C.0) — the persisted-state shape (schemaVersion 1|2, decode boundary) now lives
// in src/cockpit/route.ts alongside the route it carries; re-exported here so extension.ts's
// `import type { CockpitPanelState } from "./webview/Cockpit.js"` stays unchanged.
export type { CockpitPanelState };
export { decodeCockpitPanelState };

/** Board wiring for Mission tab embed (same targets as MissionControlPanelManager). */
export interface CockpitMissionBoard {
  getWorkspaces: () => WorkspaceMissionControlTarget[];
  /**
   * t-610705 (Phase C.1) — Task Studio isn't migrated yet (it shares StudioPanelManagerBase with 8
   * other panels; deferred to its own design pass). "Open task" no longer routes through here — the
   * Board's openTask message navigates to the task-detail subroute directly (see
   * handleMissionAction's "openTask" case) — Task Detail is fully Control-native now.
   * Typed on the shared WorkspacePresentationTarget base (not the narrower WorkspaceMissionControlTarget)
   * since the task-detail route also calls this with its own WorkspaceTaskDetailTarget — the real
   * implementation (extension.ts) only ever needs `wsHash` to look up the underlying workspace.
   */
  openTaskStudio: (ws: WorkspacePresentationTarget, id?: string) => void;
  onTasksChanged: () => void;
}

export interface CockpitApprovals {
  getWorkspaces: () => WorkspacePresentationTarget[];
  resolve: (wsHash: string, id: string, decision: ApprovalDecision) => Promise<void>;
}

export interface CockpitValidations {
  getWorkspaces: () => WorkspaceMissionControlTarget[];
  onValidationsChanged: () => void;
}

/**
 * t-e4f662 — the Human Inbox's configured staleness threshold for ONE workspace, from that
 * workspace's own `tachyon.yml`. Per wsHash rather than per window because it is project-owned
 * config: in a multi-root window two folders can legitimately answer differently, and reading "the"
 * threshold would silently pick whichever root came first.
 *
 * Unwired, or a workspace that configured nothing, answers undefined and the projection uses the
 * product default — the same fail-quiet shape every other optional resolver here uses.
 */
export type CockpitInboxStaleAfter = (wsHash: string) => StaleAfter | undefined;

/** t-610705 (Phase C.3) — Project Handoff folds into a section (no new route kind — the plan.md
 *  distinction from Fleet's subroutes: Handoff is workspace-scoped like Approvals/Validations, not
 *  an entity with its own immutable locator). WorkspaceHandoffTarget already carries everything the
 *  host needs — same minimal-wrapper shape as CockpitTaskDetail/CockpitActivity/CockpitProbes. */
export interface CockpitHandoff {
  getWorkspaces: () => WorkspaceHandoffTarget[];
}

/** t-610705 (Phase C.1) — Task Detail's own read/mutate surface (WorkspaceTaskDetailTarget already
 *  carries loadTaskDetail/updateTask/reviewPrototype/attachment resolution — no separate VM-building
 *  interface needed, unlike CockpitMissionBoard's thinner wrapper). */
export interface CockpitTaskDetail {
  getWorkspaces: () => WorkspaceTaskDetailTarget[];
}

/** t-610705 (Phase C.2) — one agent's normalized activity feed, a subroute of Fleet. */
export interface CockpitActivity {
  getWorkspaces: () => WorkspaceActivityTarget[];
}

/** t-610705 (Phase C.2) — captured probe runs, a subroute of Fleet. */
export interface CockpitProbes {
  getWorkspaces: () => WorkspaceProbePresentationTarget[];
}

export interface CockpitRuntimeOps {
  buildSnapshot: () => RuntimeOpsSnapshot | Promise<RuntimeOpsSnapshot>;
  configureProviderObservation?: (provider: RuntimeOpsProviderV2, enabled: boolean) => void | Promise<void>;
  /**
   * t-283149 — what Tachyon handed one agent's runtime. Optional: an engine that predates the
   * `agent.session-inspection` action refuses it by name, and the panel says so on that row rather
   * than the whole section failing.
   */
  inspectAgentSession?: (workspaceKey: string, agent: string) => Promise<InspectedSession>;
}

/** Read-only native runtime-config inventory. Editing is intentionally deferred to SDD 446 B. */
export interface CockpitRuntimeConfig {
  buildSnapshot: (wsHash?: string) => RuntimeConfigControlSnapshot | undefined;
  openSource: (sourcePath: string) => Promise<void>;
  saveChanges: (input: { wsHash?: string; runtime: RuntimeConfigRuntime; documentId: string; expectedRevision?: string; changes: RuntimeConfigChange[] }) => Promise<void>;
}

export interface CockpitInspector {
  snapshot: () => Promise<PaneSnapshot[]>;
  folderByHash: () => Map<string, string>;
  cpuBusy: (rows: PaneSnapshot[]) => Map<string, boolean>;
  serverHealth: () => Promise<TmuxServerSnapshot>;
  capture: (session: string) => Promise<string>;
  open: (session: string) => void;
  kill: (session: string) => Promise<void>;
  reapDead: () => Promise<number>;
  reapOrphans: () => Promise<number>;
}

/**
 * Control — editor visual hub.
 * Embedded product surfaces: Mission, Approvals, Plugins, Runtime Ops, tmux Inspector,
 * plus rich native Fleet / Worktrees / Deliveries / Settings modules.
 * NOT embedded: Task Detail/Studio, Pins, form studios (Agent/Terminal/Command/Runbook/Schedule).
 * Schedules stay in the sidebar (not a Control tab).
 */
/**
 * SDD 480 Phase 4 — fold the ledger into the section's view-model.
 *
 * The three non-ready outcomes are kept apart on purpose, because they are different facts and a
 * shared blank surface would erase the distinction that matters most:
 *  - no reader wired, or the workspace records nothing → `no-telemetry`;
 *  - the ledger was read but could not be folded → `error`, with the reason;
 *  - it folded to nothing → the builder's own `empty`.
 */
// Exported so the wiring itself is testable. The defect this closes was invisible to every test of
// the two halves — the builder took a `detailFor` and the ledger carried the keys, and both passed
// while the host handed over `undefined`. A test of a hand-assembled call would have passed too.
export function buildExecutionGraphSectionVm(
  deps: CockpitDeps,
  wsHash: string | undefined,
): ExecutionGraphVm | undefined {
  if (!deps.executionGraph) return undefined; // client renders `no-telemetry`
  try {
    const { events, available, currency } = deps.executionGraph(wsHash);
    if (!available) {
      // t-f54b62 — `no-telemetry` means two different things: this workspace records nothing, or the
      // daemon serving it predates the build that would record. Say which, when the host knows —
      // `engineCurrencyNote` yields undefined unless it actually compared and found a stale engine.
      const statusNote = currency ? engineCurrencyNote(currency) : undefined;
      return buildExecutionGraphVm({
        projection: { executions: [], edges: [], agentIds: [] },
        status: "no-telemetry",
        ...(statusNote ? { statusNote } : {}),
      });
    }
    // t-441b0f — the ledger already carries `cwd`/`worktree`/`tool`; the panel just had no way to
    // reach them, so all three rendered as absent. Index them from the SAME events the projection
    // folds, so the detail panel and the graph can never describe different runs.
    const detail = indexExecutionDetail(events);
    return buildExecutionGraphVm({
      projection: projectExecutions(events),
      detailFor: (executionId) => detail.get(executionId),
    });
  } catch (err) {
    // The message is the only detail shown, and it is a local read failure — not user content — so
    // there is nothing here to redact that the ledger's own write boundary has not already handled.
    return buildExecutionGraphVm({
      projection: { executions: [], edges: [], agentIds: [] },
      status: "error",
      errorDetail: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface CockpitDeps {
  extensionUri: vscode.Uri;
  /** t-af3eef — `needs` says which expensive slices this view consumes; omitted means everything. */
  collect: (needs?: CockpitCollectNeeds) => Promise<CockpitWorkspaceBundle[]>;
  /**
   * SDD 480 Phase 4 — read the execution ledger for the active workspace.
   *
   * Optional: a host without it leaves the section in `no-telemetry`, which is the honest answer
   * rather than an empty diagram. Read-only by contract — the ledger is single-writer (t-d5066b) and
   * this side must never open a journal that could compact.
   */
  executionGraph?: (wsHash: string | undefined) => {
    events: SealedExecutionEvent[];
    available: boolean;
    /**
     * t-f54b62 — is the daemon serving this workspace the installed build? Only the host can answer,
     * and it may not be able to: omitted rather than guessed. An empty section explained by a wrong
     * verdict sends a reader to restart production for no reason.
     */
    currency?: EngineCurrency;
  };
  missionBoard: CockpitMissionBoard;
  taskDetail: CockpitTaskDetail;
  activity: CockpitActivity;
  probes: CockpitProbes;
  handoff: CockpitHandoff;
  /** t-610705 (Phase D) — StudioPanelManagerBase-based editors migrated onto a Control route
   *  (studios-routes-design.md). D0 only wires `studio:"command"`; D1-D3 add the rest onto the SAME
   *  getWorkspaces() list (WorkspaceStudioTarget already covers command/terminal/runbook/schedule/
   *  agent uniformly — task/pin need their own narrower CockpitDeps entries when their PR lands). */
  studios: CockpitStudios;
  approvals: CockpitApprovals;
  validations: CockpitValidations;
  /** t-e4f662 — see CockpitInboxStaleAfter. Optional: absent means the product default everywhere. */
  humanInboxStaleAfter?: CockpitInboxStaleAfter;
  /**
   * SDD 482 phase 4C — commit an approved Saved Agent proposal through the canonical Studio
   * transaction. Optional so a host that has not wired it says so out loud rather than accepting a
   * click and doing nothing; supplied by the extension, never reachable from the Bridge.
   */
  approveSavedAgentProposal?: (input: {
    workspaceRoot: string;
    proposalId: string;
    approvedDigest: string;
  }) => Promise<SavedAgentCommitResult>;
  runtimeOps: CockpitRuntimeOps;
  runtimeConfig: CockpitRuntimeConfig;
  inspector: CockpitInspector;
  plugins: PluginsPanelManager;
  openSettings: () => void;
  openDoctor: () => void;
  /** Fleet lifecycle + surface openers (wsHash optional for single-root). */
  fleetStart: (name: string, wsHash?: string) => Promise<void>;
  fleetStop: (name: string, wsHash?: string) => Promise<void>;
  /** SDD 443 — continue unfinished task on another agent (webview already picked dest). */
  fleetContinueTask: (fromName: string, toName: string, wsHash?: string) => Promise<void>;
  fleetTerminal: (name: string, wsHash?: string) => Promise<void>;
  revealPath: (fsPath: string) => void;
  /** spec 444 — Worktrees hygiene actions. Engine re-validates fail-closed on every call; the
   *  returned string is a human-readable refusal reason (undefined = succeeded). */
  worktreeRemove: (id: string, deleteBranch: boolean, wsHash?: string) => Promise<string | undefined>;
  worktreeForgetRecord: (id: string, wsHash?: string) => Promise<string | undefined>;
  openConfigFile: (wsHash?: string) => Promise<void>;
  clearEngineLog: (wsHash: string) => Promise<void>;
  openEngineJournal: (wsHash: string) => void;
  /** SDD 414 — settings.companion.tabTools for one workspace engine. */
  setCompanionTabTools: (wsHash: string, enabled: boolean) => Promise<void>;
  /** t-585d5c — write the idle-notification window; `undefined` resets to the product default. */
  setIdleAfterMinutes: (wsHash: string, minutes?: number | "never") => Promise<void>;
  /** SDD 420 — settings.companion.allowedHosts for one workspace engine. */
  setCompanionAllowedHosts: (wsHash: string, hosts: string[]) => Promise<void>;
  /** SDD 414/422 — host-authoritative unpair; deviceId clears one row, omit clears all. */
  unpairCompanionDevice: (wsHash: string, deviceId?: string) => Promise<void>;
  /**
   * SDD 414 — mint short-lived pair code + baseUrl (same as tachyon.pairCompanion / companion.pair-code).
   * Result is pushed as a one-shot webview message — not polled into CockpitModel.
   */
  issueCompanionPairCode: (wsHash: string) => Promise<{
    ok: true;
    code: string;
    baseUrl: string;
    baseUrls?: string[];
    expiresAt: string;
    protocolVersion?: number;
    prefix?: string;
    qrPayload?: string;
    openUrl?: string;
    qrDataUrl?: string;
  } | { ok: false; reason: string }>;
}

function strings(): CockpitStrings {
  const t = vscode.l10n.t;
  return {
    title: t("Control"),
    subtitle: t("Project sysadmin"),
    navOverview: t("Overview"),
    navEngine: t("Engine"),
    navFleet: t("Fleet"),
    navInbox: t("Inbox"),
    navApprovals: t("Approvals"),
    navMission: t("Board"),
    navValidations: t("Validations"),
    navHandoff: t("Handoff"),
    navWorktrees: t("Worktrees"),
    navDeliveries: t("Deliveries"),
    navRuntime: t("Runtime Ops"),
    navRuntimeConfig: t("Runtime Config"),
    navTmux: t("tmux"),
    navPlugins: t("Plugins"),
    navSettings: t("Settings"),
    back: t("Back"),
    refresh: t("Refresh"),
    auto: t("Auto-refresh"),
    empty: t("No Tachyon workspace attached in this window."),
    copyDiagnostics: t("Copy diagnostics"),
    openMissionControl: t("Open Board"),
    openSettings: t("Open Settings"),
    openDoctor: t("Run Doctor"),
    copied: t("Diagnostics copied"),
    overviewTitle: t("Overview"),
    overviewHint: t("Health snapshot. Fleet = agents (sidebar); Board = work queue."),
    engineTitle: t("Engine / Bridge"),
    fleetTitle: t("Fleet"),
    fleetHint: t("Agents (runtime) — start, stop, terminal, activity. Work items are on the Board."),
    approvalsTitle: t("Approvals"),
    approvalsHint: t("Human gates that block the fleet (embedded)."),
    missionTitle: t("Board"),
    missionHint: t("Work queue — tasks and lanes. Agents live in the sidebar Fleet."),
    validationsTitle: t("Validations"),
    validationsHint: t("Validation queue — close dogfoods and checks (not on the Board)."),
    navExecutionGraph: t("Execution"),
    executionGraphTitle: t("Execution graph"),
    executionGraphHint: t("What Tachyon started, and how it knows. Read-only."),
    egCanvasLabel: t("Execution graph diagram"),
    egTableLabel: t("Execution graph, as a table"),
    egLoading: t("Loading the execution ledger…"),
    egEmpty: t("No executions match these filters."),
    // Distinct from the empty state on purpose: "nothing matched" and "nothing is recorded here"
    // mean opposite things, and a blank list cannot tell them apart.
    egNoTelemetry: t("This workspace is not recording execution telemetry yet."),
    egError: t("The execution ledger could not be read."),
    egGroupedNote: t("Some lanes are grouped to stay readable; totals below are complete."),
    egFilterTurn: t("Turn"),
    egFilterState: t("State"),
    egFilterKind: t("Type"),
    egFilterAgent: t("Agent"),
    egFilterAll: t("All"),
    egColKind: t("Type"),
    egColState: t("State"),
    egColAgents: t("Agents"),
    egColAttribution: t("Attribution"),
    egColStarted: t("Started"),
    egColDuration: t("Duration"),
    egColExit: t("Exit"),
    egDetailTitle: t("Execution detail"),
    egDetailNone: t("Select an execution to see its detail."),
    egDetailDuration: t("Duration"),
    egDetailExit: t("Exit code"),
    egDetailCwd: t("Working directory"),
    egDetailWorktree: t("Worktree"),
    egDetailTool: t("Started by tool"),
    egDetailIdentity: t("Identity proof"),
    egDetailTurn: t("Turn"),
    egDetailToolCall: t("Tool call"),
    egAttrProven: t("proven"),
    egAttrShared: t("shared"),
    egAttrUnproven: t("unproven"),
    worktreesTitle: t("Managed worktrees"),
    worktreesHint: t("Tachyon-managed checkouts — reveal and copy paths."),
    deliveriesTitle: t("Deliveries"),
    deliveriesHint: t("Local GitDelivery records — phase, branch, worktree."),
    runtimeTitle: t("Runtime Ops"),
    runtimeHint: t("Usage and rate limits (embedded)."),
    runtimeConfigTitle: t("Runtime Config"),
  runtimeConfigHint: t("Global runtime configuration, capabilities, and agent impact."),
    runtimeConfigPrototype: t("Read-only inventory"),
    runtimeConfigEditable: t("Editable measured settings"),
    runtimeConfigGlobalWarning: t("Global changes also affect the selected runtime outside Tachyon."),
    runtimeConfigUnset: t("Not set"),
    runtimeConfigDisableMcp: t("Disable from source"),
    runtimeConfigGlobal: t("Global"),
    runtimeConfigWorkspace: t("Workspace"),
    runtimeConfigRuntime: t("Runtime"),
    runtimeConfigScope: t("Scope"),
    runtimeConfigCapabilitiesTitle: t("Skills, MCPs, hooks & extensions"),
    runtimeConfigDetected: t("detected"),
    runtimeConfigKnown: t("Known settings"),
    runtimeConfigCapabilities: t("Runtime capabilities"),
    runtimeConfigOther: t("Other settings"),
    runtimeConfigOtherHint: t("Preserved in the source file even when Tachyon does not edit them visually."),
    runtimeConfigSourceFile: t("Source file"),
    runtimeConfigUsedBy: t("Used by agents"),
    runtimeConfigConfigured: t("configured"),
    runtimeConfigEnabled: t("Enabled"),
    runtimeConfigDisabled: t("Disabled"),
    runtimeConfigReload: t("Reload"),
    runtimeConfigOpenFile: t("Open file"),
    runtimeConfigSave: t("Save changes"),
    runtimeConfigViewRaw: t("View keys"),
    runtimeConfigCodex: t("OpenAI Codex"),
    runtimeConfigClaude: t("Anthropic Claude"),
    runtimeConfigGrok: t("xAI Grok"),
    runtimeConfigGlobalConfig: t("Global config"),
    runtimeConfigWorkspaceConfig: t("Workspace config"),
    runtimeConfigGlobalSettings: t("Global settings"),
    runtimeConfigWorkspaceSettings: t("Workspace settings"),
    runtimeConfigWorkspaceMcp: t("Workspace MCP"),
    runtimeConfigFolderTrust: t("Folder trust"),
    runtimeConfigTheme: t("Theme"),
    runtimeConfigReducedMotion: t("Reduced motion"),
    runtimeConfigSpinnerTips: t("Spinner tips"),
    runtimeConfigTurnDuration: t("Turn duration"),
    runtimeConfigTerminalProgress: t("Terminal progress bar"),
    runtimeConfigAlwaysThinking: t("Always thinking"),
    runtimeConfigReadOnly: t("Read only"),
    runtimeConfigReadOnlyDocument: t("This source is read-only in Control."),
    runtimeConfigHiddenRecords: t("runtime-managed records are hidden from this inventory."),
    runtimeConfigOverriddenBy: t("Overridden by"),
    runtimeConfigOpaqueSections: t("Opaque sections"),
    runtimeConfigReadError: t("Could not read this runtime configuration source"),
    runtimeConfigUnavailable: t("Runtime configuration is unavailable because this workspace configuration did not load."),
    tmuxTitle: t("tmux"),
    tmuxHint: t("Server inspector (embedded)."),
    pluginsTitle: t("Plugins"),
    pluginsHint: t("Install, update, and integrity (embedded)."),
    settingsTitle: t("Settings"),
    settingsHint: t("Personal machine preferences and shared project policy — two files, two authorities."),
    workspaces: t("Workspaces"),
    engines: t("Engines"),
    agents: t("Agents"),
    errors: t("Errors"),
    bridges: t("Bridges"),
    approvals: t("Approvals"),
    inbox: t("Waiting on you"),
    worktrees: t("Worktrees"),
    deliveries: t("Deliveries"),
    attached: t("attached"),
    error: t("error"),
    none: t("none"),
    state: t("State"),
    pid: t("PID"),
    version: t("Version"),
    instance: t("Instance"),
    started: t("Started"),
    bundle: t("Bundle"),
    protocol: t("Protocol"),
    url: t("URL"),
    port: t("Port"),
    auth: t("Auth"),
    root: t("Root"),
    hash: t("Hash"),
    running: t("running"),
    stopped: t("stopped"),
    checkedAt: t("Checked"),
    navLoading: t("Loading…"),
    navStalled: t("This is taking longer than expected."),
    navRetry: t("Retry"),
    open: t("Open"),
    noneListed: t("Nothing listed for this workspace yet."),
    kind: t("Kind"),
    branch: t("Branch"),
    status: t("Status"),
    phase: t("Phase"),
    path: t("Path"),
    name: t("Name"),
    start: t("Start"),
    stop: t("Stop"),
    openTerminal: t("Terminal"),
    openActivity: t("Activity"),
    openProbes: t("Probes"),
    editAgent: t("Edit"),
    continueTask: t("Continue task in…"),
    continueTaskPickTitle: t("Continue task from {0} in…"),
    continueTaskPickSubtitle: t(
      "Starts a new session on the destination with a focused handoff — not a native resume of the source session.",
    ),
    continueTaskPickPlaceholder: t("Filter destination agents…"),
    continueTaskPickEmpty: t("No other declared agent to continue into"),
    continueTaskDestStopped: t("stopped"),
    continueTaskDestRunning: t("running — stop first"),
    continueTaskDestDetail: t("New session with focused handoff from {0}"),
    continueTaskNoDest: t("No other declared agent to continue into (need a stopped destination)."),
    reveal: t("Reveal"),
    copyPath: t("Copy path"),
    copyId: t("Copy id"),
    openConfig: t("Open workspace settings"),
    // t-7b4bb5 — two authorities, named so the dual open buttons do not look like a split mind.
    settingsBody: t(
      "Tachyon keeps two settings files on purpose: one for you on this machine, one for the project shared with the team. They own different knobs — they are not two places for the same list.",
    ),
    settingsScopeGlobalTitle: t("Global (personal)"),
    settingsScopeGlobalHint: t(
      "Your machine preferences — agent pane, git path, Activity theme. Not committed; recovery path when Control will not open.",
    ),
    settingsScopeWorkspaceTitle: t("Workspace (project)"),
    settingsScopeWorkspaceHint: t(
      "Shared project policy in tachyon.yml — agents, schedules, limits, Companion, idle notify. Versioned with the repo for the whole team.",
    ),
    settingsFileLabel: t("File:"),
    settingsOpenTachyon: t("Open global settings"),
    settingsOpenConfig: t("Open workspace settings"),
    settingsDoctor: t("Run Doctor"),
    cardTemplateTitle: t("Agent card layout"),
    cardTemplateHint: t("Choose which elements an agent card shows, and in what order."),
    cardTemplateBody: t("Compose a layout here, watch the real card update, then paste the YAML into tachyon.yml. Nothing is saved from this block."),
    cardTemplateYamlHint: t("Paste this under your workspace's tachyon.yml. Regions you did not change are left out, so they follow the default."),
    cardTemplateCopy: t("Copy YAML"),
    cardTemplateReset: t("Reset to default"),
    cardTemplateCriticalNote: t("shown anyway when a row is in this state"),
    cardTemplateInlineNote: t("renders inside another element"),
    // SDD 479 phase 5 — ratified fork 1 made this sentence part of the feature: without it, a
    // personal override quietly contradicting the project reads as a broken project template.
    cardTemplateInEffect: t("In effect right now:"),
    cardTemplatePersonalActive: t("your personal override in your Tachyon settings file — it wins over every project template below"),
    cardTemplatePersonalRefused: t("your personal override was REFUSED and ignored; the cards fall back to each project's template"),
    cardTemplatePersonalNone: t("no personal override — each project's own template decides"),
    cardTemplateProjectNone: t("uses Tachyon's default card"),
    cardTemplateProjectConfigured: t("has its own template in tachyon.yml"),
    cardTemplateProjectRefused: t("its tachyon.yml template was refused; showing the default card"),
    cardTemplateHomeLabel: t("Write this layout to:"),
    cardTemplateHomeProject: t("This project (tachyon.yml)"),
    cardTemplateHomePersonal: t("Just me (Tachyon settings file)"),
    cardTemplateCopyJson: t("Copy JSON"),
    cardTemplateJsonHint: t("Paste this under \"sidebar\": { \"cardTemplate\": ... } in your Tachyon settings file. It applies to every project you open, and wins over their templates; regions you did not change keep whatever each project chose."),
    cardTemplateOpenSettings: t("Open settings"),
    companionTitle: t("Companion"),
    companionHint: t("Pair Tachyon Companion and opt-in first-person browser tools for agents (user_browser_*)."),
    companionBody: t(
      "When tab tools are on, agents see user_browser_* on the Bridge. Pairing Companion is still required to run them. Generate a pair code here (or via the command palette).",
    ),
    companionTabTools: t("List Companion tab tools for agents"),
    companionTabToolsHelp: t("Writes settings.companion.tabTools in tachyon.yml and refreshes the Bridge tool list."),
    companionAllowedHosts: t("Allowed hosts (optional)"),
    companionAllowedHostsHelp: t(
      "One host or glob per line (example.com, *.herokuapp.com). Empty = all hosts. Writes settings.companion.allowedHosts in tachyon.yml.",
    ),
    companionAllowedHostsPlaceholder: t("example.com\n*.herokuapp.com"),
    // t-585d5c — the unit and the bounds are IN the strings, because a bare number field is where a
    // person guesses seconds and gets minutes.
    idleNotifyTitle: t("Idle agent notifications"),
    idleNotifyHelp: t(
      "How long a child agent may sit idle before Tachyon notifies its parent. 1-10080 minutes (7 days). Writes settings.agentNotifications.idleAfterMinutes in tachyon.yml and applies on the next check — no restart.",
    ),
    idleNotifyUnit: t("minutes"),
    idleNotifyUsingDefault: t("Using the default ({0} min) — nothing written in tachyon.yml"),
    idleNotifyOff: t("Notifications are off for this workspace"),
    idleNotifyOffLabel: t("Turn notifications off"),
    idleNotifySave: t("Save"),
    idleNotifyReset: t("Back to default"),
    // t-aaad95 — Control -> Settings edits BOTH scopes now that VS Code contributes nothing.
    globalSettingsTitle: t("Your Tachyon settings"),
    globalSettingsHint: t("Per-person, per-machine. Kept in a plain file you can also edit by hand — that file is the recovery path when Control itself will not open."),
    globalSettingsFileLabel: t("File:"),
    globalSettingsOpenFile: t("Open global settings"),
    globalSettingsRefused: t("This file was refused and the last good version is in use — fix it and it reloads by itself:"),
    globalSettingsCodeTheme: t("Activity code theme"),
    globalSettingsCodeThemeHelp: t("Syntax-highlight palette for code blocks in Activity."),
    globalSettingsCodeThemeAuto: t("Follow the editor"),
    globalSettingsCodeThemeDark: t("Dark"),
    globalSettingsCodeThemeLight: t("Light"),
    globalSettingsAgentPane: t("Agent pane"),
    globalSettingsAgentPaneHelp: t("The first-party agent pane. The integrated terminal stays available either way."),
    globalSettingsGitPath: t("Path to git"),
    globalSettingsGitPathHelp: t("Leave empty to use the git extension's git.path, then common install locations, then git on PATH."),
    globalSettingsSave: t("Save"),
    globalSettingsLive: t("takes effect immediately"),
    globalSettingsNeedsReopen: t("applies the next time Control is opened"),
    workspaceSettingsTitle: t("This project's settings"),
    workspaceSettingsHint: t("Agent limit, memory cap, task notifications and worktree reveal live in tachyon.yml, so they travel with the repo and the whole team gets them."),
    companionAllowedHostsSave: t("Save allowed hosts"),
    companionPaired: t("Paired"),
    companionNotPaired: t("Not paired"),
    allWorkspaces: t("All workspaces"),
    companionPickWorkspace: t("Select a single workspace in Overview to manage Companion settings."),
    companionBaseUrl: t("Engine Base URL"),
    companionShowPairCode: t("Show pair code"),
    companionCopyBaseUrl: t("Copy URL"),
    companionPairCodeLabel: t("Code"),
    companionPairUrlLabel: t("URL"),
    companionPairExpires: t("Expires"),
    companionPairExpired: t("Code expired — generate a new one."),
    companionCopyCode: t("Copy code"),
    companionCopyUrl: t("Copy URL"),
    companionCopyAll: t("Copy all"),
    companionNewCode: t("New code"),
    companionPairUnavailable: t("Companion pairing unavailable — ensure the Bridge is listening."),
    companionPairQrLabel: t("Mobile QR"),
    companionPairQrHint: t(
      "Scan with your phone camera — opens Companion Mobile and pairs automatically. PC and phone must be on the same Tailscale tailnet (settings.companion.lanAccess: true).",
    ),
    companionPairCandidatesLabel: t("URL"),
    companionCopyPayload: t("Copy QR payload"),
    companionLanAccessHint: t(
      "Mobile uses Tailscale only (not raw Wi‑Fi IPs). Install Tailscale on PC + phone, same account/tailnet, then generate a code.",
    ),
    devicesTitle: t("Connected devices"),
    devicesHint: t("Companion devices paired to this workspace engine (browser or mobile)."),
    devicesEmpty: t("No Companion device paired. Generate a pair code above, enter it in Tachyon Companion, then refresh."),
    devicesUnpair: t("Unpair"),
    devicesLive: t("Live"),
    devicesOffline: t("Offline"),
    devicesKindBrowser: t("Browser"),
    devicesKindMobile: t("Mobile"),
    devicesPairedAt: t("Paired"),
    // SDD 482 phase 5 (`t-5e1113`) — the ratified product vocabulary; these two badges are the whole
    // user-visible surface for the distinction.
    //
    // t-4cc561 updated the claim that used to sit here. It said every OTHER occurrence of "declared"
    // or "ad-hoc" was a frozen field/config/wire value, so the rename was two lines and not a sweep.
    // That stopped being true: the species names are now gone from identifiers, comments and copy
    // across the shell and engine. What IS still frozen, deliberately, is the narrow set that crosses
    // a boundary — the sidebar wire's `adhoc` flag, the `mode: "adhoc"` handoff discriminant, and the
    // ledger's persisted shape. Those are renamed only with a protocol bump, never as nomenclature.
    saved: t("Saved"),
    temporary: t("Temporary"),
    agent: t("agent"),
    change: t("change"),
    wtReadyTitle: t("Ready to remove"),
    wtReadyDesc: t("Clean, unoccupied, and every commit is already in its base branch. Safe to delete."),
    wtReviewTitle: t("Needs review"),
    wtReviewDesc: t("Blocked from cleanup — read the reason before touching these by hand."),
    wtOccupiedTitle: t("Occupied"),
    wtOccupiedDesc: t("A live agent holds this checkout right now."),
    wtRecordTitle: t("Record-only"),
    wtRecordDesc: t("The registry row survives, but the checkout's directory is gone. Nothing to reveal — just forget the row."),
    wtRemoveCheckout: t("Remove checkout"),
    wtForgetRecord: t("Forget record"),
    wtAlsoDeleteBranch: t("Also delete local branch"),
    wtSelectAll: t("Select all"),
    wtClearSelection: t("Clear"),
    wtSelected: t("selected"),
    wtReviewConfirm: t("Review & confirm…"),
    wtConfirmTitle: t("Confirm cleanup"),
    wtConfirmBody: t("Each entry is re-checked at execution — one whose state changed is skipped with a reason, the rest proceed."),
    wtConfirmRun: t("Run cleanup"),
    wtCancel: t("Cancel"),
    wtEngineUnavailable: t("Engine unavailable — registry not shown (unverified data is never displayed)."),
    wtBlocked: t("Blocked"),
    wtOccupiedBy: t("occupied by"),
    wtShowAll: t("Show all"),
    dlvMissingRef: t("ref missing"),
    dlvLive: t("agent live"),
    dlvUnmerged: t("not in base"),
  };
}

function inspectorStrings(): InspectorStrings {
  const t = vscode.l10n.t;
  return {
    title: t("tmux Server Inspector"),
    subtitle: t("Live view of the dedicated tachyon socket — every session Tachyon owns."),
    refresh: t("Refresh"),
    auto: t("Auto-refresh"),
    empty: t("No Tachyon sessions on the socket. Start an agent, command, or runbook to populate the server."),
    summary: t("{0} sessions · {1} live", "{0}", "{1}"),
    foreignNote: t("not an open workspace — orphaned or owned by another window"),
    pid: t("pid"),
    live: t("live"),
    dead: t("exited"),
    exit: t("exit {0}", "{0}"),
    busy: t("busy"),
    idle: t("idle"),
    open: t("Open"),
    capture: t("Capture"),
    kill: t("Kill"),
    reapDead: t("Kill {0} dead", "{0}"),
    reapOrphans: t("Reap {0} orphaned", "{0}"),
    killConfirm: t("Kill session {0}? This stops the process and removes the pane.", "{0}"),
    kindSession: t("Agents & terminals"),
    kindCommand: t("Commands"),
    kindRunbook: t("Runbook steps"),
    kindAnchor: t("Engine internals"),
    kindUnknown: t("Other"),
    captureEmpty: t("(no output)"),
    ageSeconds: t("{0}s", "{0}"),
    ageMinutes: t("{0}m", "{0}"),
    ageHours: t("{0}h", "{0}"),
    ageDays: t("{0}d", "{0}"),
    overview: t("Overview"), server: t("Server"), all: t("All"), search: t("Search sessions, commands, or labels"),
    workspace: t("Workspace"), status: t("Status"), kind: t("Kind"), cpu: t("CPU"), details: t("Details"),
    fullName: t("Full session name"), hash: t("Workspace hash"), command: t("Current command"), startCommand: t("Start command"), uptime: t("Uptime"),
    total: t("Total"), orphaned: t("Orphaned"), socket: t("Socket"), path: t("Path"), health: t("Health"), version: t("tmux version"),
    serverPids: t("Server PIDs"), diagnostics: t("Process diagnostics"), noDiagnostics: t("No process diagnostics available."),
    refreshCapture: t("Refresh capture"), close: t("Close"), bulkActions: t("Bulk actions"),
  };
}

let panel: vscode.WebviewPanel | undefined;
let currentRoute: CockpitRoute = routes.section("overview");
/**
 * t-610705 (Phase D, D3) — the last COMMITTED route that was NOT itself a studio route, tracked
 * separately from `currentRoute` (design-dueto probe-43bca1cc blockers): a pin's `returnRoute` must
 * survive re-entry to the SAME pin (routeKey-based idempotent re-entry never re-derives it from
 * `currentRoute`, which would already be the pin route itself) and chained pin↔other-studio
 * navigation (an intervening studio visit must not overwrite it). Reset to the Overview default
 * whenever a panel is disposed (see the `onDidDispose` handler below) so a later fresh panel never
 * inherits a disposed panel's provenance.
 */
let lastCommittedNonStudioRoute: CockpitNonStudioRoute = routes.section("overview");
/**
 * t-610705 (Phase C.0) — bumped on every route change AND every workspace-scope change (both are
 * "the world changed" events). Async send*() functions capture this at the start and re-check it
 * after their awaits; a mismatch means a newer navigation/scope-switch has superseded this call,
 * so its result must be discarded rather than posted (closes the router design dueto's "out-of-
 * order module pushes can render data for the wrong route" finding). Replaces the old
 * mission-only `missionGeneration` counter with one mechanism shared by every section.
 */
let navEpoch = 0;

/**
 * t-610705 (Phase D, D3) — captures `lastCommittedNonStudioRoute` into a pin route's own
 * `returnRoute` slot at the moment it commits, IF one hasn't already been captured (a persisted/
 * revived pin route already carries its own real returnRoute — never overwritten). Every other
 * studio's `returnRoute` stays `null` (never read — `studioParentSection` answers their parent).
 */
function captureReturnRoute(route: CockpitRoute): CockpitRoute {
  if (!isStudioRoute(route) || route.studio !== "pin" || route.returnRoute !== null) return route;
  return { ...route, returnRoute: lastCommittedNonStudioRoute };
}

function navigate(route: CockpitRoute): void {
  reconcileActivityTeardown(route);
  reconcileStudioTeardown(route);
  currentRoute = captureReturnRoute(route);
  if (!isStudioRoute(currentRoute)) lastCommittedNonStudioRoute = currentRoute;
  navEpoch += 1;
  // t-ac79a7 — announce the committed destination BEFORE any awaited loading. This is the one
  // commit point every navigation intent reaches (requestNavigate's pass-through, the studio
  // transaction's commit closure, onCancelled/onSaved, setSection), so emitting here gives every
  // route kind the pending half of the bracket without a per-route call site to keep in sync.
  // Synchronous by construction: the model push behind it waits on deps.collect(), and the whole
  // point is that the client must not have to wait for that to know the click was accepted.
  panel?.webview.postMessage(routePendingMessage(routeKey(currentRoute)));
}

/**
 * t-610705 (Phase D, D0) — the ONE gate for a navigation intent while `currentRoute` might be a
 * dirty studio form (studios-routes-design.md's navigation-transaction FSM). Every existing
 * `navigate()` call site that represents a NAVIGATION INTENT (as opposed to `navigate()`'s use as
 * the transaction's own commit closure) goes through this instead. Off a non-studio route it's a
 * synchronous pass-through — zero behavior change for every route kind that existed before D0.
 */
async function requestNavigate(route: CockpitRoute, live: vscode.WebviewPanel, afterCommit?: () => Promise<void>): Promise<void> {
  // t-610705 (Phase D, D0) — a same-identity re-entry (reopening the route you're already on — e.g.
  // a repeat command-palette invocation, or a legacy-serializer redirect racing an already-open
  // Control) is a NO-OP for an EDIT route: nothing is actually being navigated away from (same
  // entity), so it must never trigger a dirty-form checkpoint. Matches `ensureStudioBinding`'s/
  // `navigate()`'s own idempotent-on-same-identity convention used everywhere else in this router
  // (found via a test that hung waiting on an unanswered checkpoint for exactly this case).
  //
  // round-5 fix — deliberately NOT extended to "studio-new": every "create a new X" invocation for
  // the same studio+workspace shares the identical routeKey (no entityId to distinguish them), so
  // treating that as "same identity" would silently keep a stale/dirty draft across what the user
  // may intend as a genuinely NEW creation attempt, bypassing the checkpoint entirely. A clean
  // studio-new re-invocation still commits instantly either way (no dirty form == no visible modal),
  // so this only changes behavior for the case that actually needs protecting.
  if (!isStudioRoute(currentRoute) || (route.kind === "studio-edit" && currentRoute.kind === "studio-edit" && routeKey(route) === routeKey(currentRoute))) {
    navigate(route);
    if (afterCommit) await afterCommit();
    return;
  }
  const outcome = await beginStudioNavTransaction(
    { post: (m) => live.webview.postMessage(m), isCurrent: () => panel === live },
    () => navigate(route),
  );
  if (outcome === "busy") {
    notify("Another navigation is already in progress in Control.", "warn");
    return;
  }
  if (outcome === "committed" && afterCommit) await afterCommit();
  // "aborted" (Stay, timeout, or a rejected Save) — currentRoute is untouched, the studio form is
  // still mounted and (per beginStudioNavTransaction's contract) unfrozen; nothing further to do.
}

/** t-d16a39 — the ONE shell-level workspace scope. undefined = "All workspaces" (aggregate
 *  sections aggregate; per-workspace sections fall back to the first workspace). Replaces the
 *  former per-section missionWsHash/approvalWsHash pair and Plugins' derived fallback. */
let controlWsHash: string | undefined;
let pushMissionBoard: (() => void) | undefined;
let pushApprovals: (() => void) | undefined;
let pushValidations: (() => void) | undefined;
/** t-e76acc — the unified Human Inbox re-reads on ANY approval or validation mutation, from anywhere. */
let pushInbox: (() => void) | undefined;
let pushHandoff: (() => void) | undefined;
let pushTaskDetail: (() => void) | undefined;
let pushProbes: (() => void) | undefined;
let pushStudioReferenceData: (() => void) | undefined;
let pushTaskStudioEntity: (() => void) | undefined;
let pushPinStudioEntity: (() => void) | undefined;
let doOpenActivityTranscript: (() => void) | undefined;
let wiredPanel: vscode.WebviewPanel | undefined;

/** Refresh embedded Mission board after task mutations. */
export function refreshCockpitMissionBoard(): void {
  pushMissionBoard?.();
}

/** t-610705 (Phase C.1) — refresh an open task-detail subroute after any task mutation, from ANY
 *  source (board drag/edit, detail edit, MCP tool call) — the same shared fan-out the board and
 *  sidebar already use. A no-op when the current route isn't task-detail (mirrors refreshCockpitMissionBoard). */
export function refreshCockpitTaskDetail(): void {
  pushTaskDetail?.();
}

/** t-610705 (Phase C.2) — refresh an open agent-probes/workspace-probes subroute after the probe
 *  ledger changes (wired into extension.ts's onViewsChanged("probes"), replacing the retired
 *  ProbeResultPanelManager.refreshAll()). A no-op off a probes route (mirrors refreshCockpitTaskDetail). */
export function refreshCockpitProbes(): void {
  pushProbes?.();
}

/** t-610705 (Phase D, D1a) — re-fetch reference data (catalogs, not the entity) for an open studio
 *  route after an external tachyon.yml change (wired into extension.ts's onViewsChanged("commands")/
 *  refreshAll, replacing the retired RunbookStudioPanelManager/ScheduleStudioPanelManager's
 *  `refreshReferenceData()`). A no-op off a studio route (mirrors refreshCockpitProbes); a no-op for
 *  a studio whose adapter never changes its own referenceData externally is harmless (best-effort,
 *  see studioHost.ts's refreshStudioReferenceData doc comment). */
export function refreshCockpitStudioReferenceData(): void {
  pushStudioReferenceData?.();
}

/** t-610705 (Phase D, D2) — re-send a fresh `load` for an open Task Studio binding after ANY task
 *  mutation, from ANY source (board drag/edit, detail edit, MCP tool call) — the same fan-out the
 *  retired standalone TaskStudioPanelManager wired via `base.refreshAll()` into `onTasksChanged`.
 *  Task and Pin (D3, see refreshCockpitPinStudioEntity below) are the two migrated studios whose
 *  underlying entity can change out from under an open binding through paths OTHER than Save — the
 *  other 4 studios' entities have no such external-mutation path, so they have no equivalent push.
 *  A no-op off a task studio-edit route, and best-effort (sendStudioLoad already tolerates a load
 *  failure) otherwise. */
export function refreshCockpitTaskStudioEntity(): void {
  pushTaskStudioEntity?.();
}

/** t-610705 (Phase D, D3) — Pin's equivalent of refreshCockpitTaskStudioEntity above: the retired
 *  standalone PinStudioPanelManager wired `base.refreshAll()` into the SAME broad `refreshAll()`
 *  fan-out extension.ts already calls after worktree/plugin/reference-data changes (pins can be
 *  created/deleted from the sidebar tree while a DIFFERENT pin's studio tab is open) — ported as-is,
 *  same call site, rather than narrowed to a pin-specific event that didn't exist before this port. */
export function refreshCockpitPinStudioEntity(): void {
  pushPinStudioEntity?.();
}

/** t-610705 (Phase C.2) — the palette "Open Raw Transcript" escape hatch, wired to the CURRENT
 *  route rather than a tracked "most recently active" panel (that concept doesn't survive
 *  collapsing to a single shared binding — see activityBinding's doc comment). Off an agent-activity
 *  route, notifies instead of guessing which agent the human meant. */
export function openCockpitAgentTranscript(): void {
  doOpenActivityTranscript?.();
}

/** Refresh embedded Approvals after resolve/fan-out. */
export function refreshCockpitApprovals(): void {
  pushApprovals?.();
  pushInbox?.();
}

export function refreshCockpitValidations(): void {
  pushValidations?.();
  // t-e76acc — the Inbox is a projection over the same stores: any push that refreshes one of its
  // sources refreshes the aggregate too, or the unified count silently goes stale the moment a
  // validation is closed from the Validations tab.
  pushInbox?.();
}

/** t-610705 (Phase C.3) — re-post the Handoff snapshot (wired into onViewsChanged("handoff"),
 *  replacing the retired HandoffPanelManager.refreshAll()). A no-op off the handoff section. */
export function refreshCockpitHandoff(): void {
  pushHandoff?.();
}

const PLUGIN_ACTION_TYPES = new Set([
  "checkUpdates", "checkPluginUpdate", "install", "update", "reinstall", "remove",
  "reselect", "repair", "rehydrate", "confirm", "cancel", "openConfig", "openDocs", "installExternal",
]);

const INSPECTOR_ACTION_TYPES = new Set(["open", "kill", "capture", "reapDead", "reapOrphans"]);

// t-610705 (Phase B #6) — the bounded/coalesced agent-liveness pass lives in src/cockpit/missionVm.ts
// (ported from the retired MissionControlPanelManager so the embedded board keeps the 250ms
// never-block guarantee). One shared instance for the singleton panel; the shared navEpoch (Phase
// C.0) now guards staleness — this used to be its own `missionGeneration` counter.
const missionAgentLists = new MissionAgentLists();

function resolveMissionWs(board: CockpitMissionBoard, prefer?: string): WorkspaceMissionControlTarget | undefined {
  const all = board.getWorkspaces();
  if (all.length === 0) return undefined;
  if (prefer) {
    const hit = all.find((w) => w.wsHash === prefer);
    if (hit) return hit;
  }
  if (controlWsHash) {
    const hit = all.find((w) => w.wsHash === controlWsHash);
    if (hit) return hit;
  }
  return all[0];
}

function resolveApprovalWs(appr: CockpitApprovals, prefer?: string): WorkspacePresentationTarget | undefined {
  const all = appr.getWorkspaces();
  if (all.length === 0) return undefined;
  if (prefer) {
    const hit = all.find((w) => w.wsHash === prefer);
    if (hit) return hit;
  }
  if (controlWsHash) {
    const hit = all.find((w) => w.wsHash === controlWsHash);
    if (hit) return hit;
  }
  return all[0];
}

function resolveHandoffWs(handoff: CockpitHandoff, prefer?: string): WorkspaceHandoffTarget | undefined {
  const all = handoff.getWorkspaces();
  if (all.length === 0) return undefined;
  if (prefer) {
    const hit = all.find((w) => w.wsHash === prefer);
    if (hit) return hit;
  }
  if (controlWsHash) {
    const hit = all.find((w) => w.wsHash === controlWsHash);
    if (hit) return hit;
  }
  return all[0];
}

/** Fallback-style resolver for the Fleet card's "Activity" click (mirrors resolveMissionWs/
 *  resolveApprovalWs) — used ONLY to decide which wsHash to bake into a fresh agent-activity route.
 *  Once that route exists, resolving ITS workspace is strict (see resolveActivityWs below, entity
 *  routes carry an immutable locator, same reasoning as resolveTaskDetailWs). */
function resolveFleetActivityWs(activity: CockpitActivity, prefer?: string): WorkspaceActivityTarget | undefined {
  const all = activity.getWorkspaces();
  if (all.length === 0) return undefined;
  if (prefer) {
    const hit = all.find((w) => w.wsHash === prefer);
    if (hit) return hit;
  }
  if (controlWsHash) {
    const hit = all.find((w) => w.wsHash === controlWsHash);
    if (hit) return hit;
  }
  return all[0];
}

/** t-610705 (Phase D, D1c) — same fallback-style resolver shape as resolveFleetActivityWs above, for
 *  Fleet's own "Probes" button. */
function resolveFleetProbesWs(probes: CockpitProbes, prefer?: string): WorkspaceProbePresentationTarget | undefined {
  const all = probes.getWorkspaces();
  if (all.length === 0) return undefined;
  if (prefer) {
    const hit = all.find((w) => w.wsHash === prefer);
    if (hit) return hit;
  }
  if (controlWsHash) {
    const hit = all.find((w) => w.wsHash === controlWsHash);
    if (hit) return hit;
  }
  return all[0];
}

/** t-610705 (Phase D, D1c) — same fallback-style resolver shape, for Fleet's own "Edit" button
 *  (opens the agent's definition in Agent or Terminal Studio — studios.getWorkspaces() already
 *  carries `config`, unlike CockpitActivity/CockpitProbes's narrower target shapes). */
function resolveFleetStudioWs(studios: CockpitStudios, prefer?: string): WorkspaceStudioTarget | undefined {
  const all = studios.getWorkspaces();
  if (all.length === 0) return undefined;
  if (prefer) {
    const hit = all.find((w) => w.wsHash === prefer);
    if (hit) return hit;
  }
  if (controlWsHash) {
    const hit = all.find((w) => w.wsHash === controlWsHash);
    if (hit) return hit;
  }
  return all[0];
}

/**
 * t-610705 (Phase C.2) — Control hosts AT MOST ONE active Activity feed at a time (unlike the
 * retired standalone panel's one-Map-slot-per-agent). A hardening dueto (probe-2d90286d) found that
 * navEpoch alone can't protect a live watcher's async continuations from posting into whatever feed
 * replaced it: navEpoch bumps on ANY navigation (including unrelated ones, e.g. a shell workspace-
 * scope switch, which must NOT tear down an open activity feed — same "immutable locator" reasoning
 * as task-detail). So this gets its OWN generation counter, bumped only when the activity route
 * itself starts/stops, and every callback/continuation in activityFeed.ts checks it via `isCurrent`
 * before touching the shared webview.
 */
let activityBinding: { generation: number; wsHash: string; agent: string; feed: ActivityFeed } | undefined;
let activityGeneration = 0;

function stopActivityBinding(): void {
  activityBinding?.feed.stop();
  activityBinding = undefined;
}

/**
 * Teardown ONLY — called synchronously from `navigate()` (the one place `currentRoute` changes) so
 * an orphaned watcher can never survive a route change regardless of what the caller does next
 * (closes the dueto's "lifecycle must be owned by route transition, not by rendering" finding).
 * Starting a FRESH binding needs `deps`/`live` (openCockpit's closure), so that half lives in
 * `ensureActivityBinding` below, called from sendSectionModule — same convention as task-detail's
 * sendTaskDetail, always invoked right after `sendModel()` by every existing caller.
 */
function reconcileActivityTeardown(route: CockpitRoute): void {
  if (route.kind === "agent-activity" && activityBinding && activityBinding.wsHash === route.wsHash && activityBinding.agent === route.agent) {
    return; // same feed re-entered — sendSectionModule's ensureActivityBinding will replay it, not restart it
  }
  stopActivityBinding();
}

/** Ported verbatim from the retired HandoffPanelManager. */
function parseHandoffDistillAction(m: Partial<HandoffAction>): HandoffDistillInputV1 | null {
  if (m.type !== "distill") return null;
  const instructions = normalizeAdditionalInstruction(m.instructions);
  const args = normalizeHandoffDistillArgs(m.mode === "adhoc" ? m.args : undefined);
  const candidate = m.mode === "existing" && typeof m.agent === "string"
    ? { mode: "existing", agent: m.agent.trim(), ...(instructions ? { instructions } : {}) }
    : m.mode === "adhoc" && typeof m.profileId === "string"
      ? { mode: "adhoc", profileId: m.profileId, ...(args ? { args } : {}), ...(instructions ? { instructions } : {}) }
      : undefined;
  if (!candidate) return null;
  try { return parseHandoffDistillInputV1(candidate); } catch { return null; }
}

function sectionTitle(s: CockpitStrings, section: CockpitSectionId): string {
  const map: Partial<Record<CockpitSectionId, string>> = {
    mission: s.navMission,
    validations: s.navValidations,
    approvals: s.navApprovals,
    plugins: s.navPlugins,
    runtime: s.navRuntime,
    "runtime-config": s.navRuntimeConfig,
    tmux: s.navTmux,
    engine: s.navEngine,
  };
  return map[section] ? `${s.title} — ${map[section]}` : s.title;
}

export async function openCockpit(
  deps: CockpitDeps,
  opts?: {
    section?: CockpitSectionId;
    route?: CockpitRoute;
    revivedPanel?: vscode.WebviewPanel;
    wsHash?: string;
    missionWsHash?: string;
    approvalWsHash?: string;
  },
): Promise<void> {
  const s = strings();
  const inspS = inspectorStrings();
  // t-610705 (Phase C.0) — the router design dueto's "retired-panel revive redirects can overwrite
  // a live cockpit session" finding: VS Code does not guarantee revive order across view types.
  // If a legacy shim's redirect raced ahead of the Cockpit's OWN trusted revival and already
  // created a duplicate panel, the real revival is authoritative — retire the interim duplicate.
  if (opts?.revivedPanel && panel && panel !== opts.revivedPanel) {
    const stale = panel;
    panel = undefined;
    stale.dispose();
  }
  // t-610705 (Phase D, D0) — captured BEFORE the reveal/create block below: a FRESH panel has no
  // live binding to protect (nothing to lose), so its initial route commits unguarded; REVEALING or
  // redirecting into an EXISTING panel might be interrupting a dirty studio form, so that path goes
  // through requestNavigate() once `live` exists a few lines down.
  const revealingExisting = !!panel && !opts?.revivedPanel;
  // t-d16a39 — both legacy per-section opt names feed the ONE shell scope (callers unchanged).
  if (opts?.wsHash) controlWsHash = opts.wsHash;
  if (opts?.missionWsHash) controlWsHash = opts.missionWsHash;
  if (opts?.approvalWsHash) controlWsHash = opts.approvalWsHash;

  const creating = !panel || !!opts?.revivedPanel;
  if (panel && !opts?.revivedPanel) {
    panel.reveal(vscode.ViewColumn.Active);
  } else {
    // t-4d59d3 — every localResourceRoot the panel will EVER need is granted here, once, at
    // creation: dist/webview plus each workspace's stable task-attachments parent (covers every
    // task's blob dir — read-only mapping via asWebviewUri, still confined to the attachments
    // tree). Reassigning `webview.options` later on a LIVE panel makes VS Code recreate the
    // webview's inner iframe, and that reload can wedge at the fake.html placeholder — the whole
    // Control surface went permanently blank the moment a Board card was clicked (the old
    // sendTaskDetail did exactly that per-navigation re-grant; see its comment below). A workspace
    // folder added AFTER Control opened won't have its root here — its task images degrade to
    // broken thumbnails until Control is reopened, which beats a blank panel.
    const creationResourceRoots = [
      vscode.Uri.joinPath(deps.extensionUri, "dist", "webview"),
      ...deps.taskDetail.getWorkspaces().map((w) => vscode.Uri.file(w.attachmentsRoot())),
    ];
    panel = opts?.revivedPanel ?? vscode.window.createWebviewPanel(COCKPIT_VIEW_TYPE, s.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      enableFindWidget: true,
      localResourceRoots: creationResourceRoots,
    });
    panel.title = s.title;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: creationResourceRoots,
    };
    panel.iconPath = panelIcon(deps.extensionUri, "pulse");
    markCockpitSingletonClaimed();
    // t-a632eb — this teardown belongs to THIS panel, so it must only run when THIS panel is still
    // the live one. `panel` is module-scoped and the guard used to ask `if (panel)` — "is there a
    // panel?" rather than "is the dead one mine?". VS Code does not order panel revivals (see
    // cockpitSingleton.ts), so a Control opened by a retired-panel shim can be superseded by
    // Control's own `revivedPanel` revive and dispose AFTERWARDS. Under the old guard that late
    // disposal nulled the LIVE panel's wiring, bumped navEpoch, reset the route and released the
    // singleton claim — after which the model push below is suppressed forever and every section
    // of the shell renders "No Tachyon workspace attached in this window."
    const disposingPanel = panel;
    panel.onDidDispose(() => {
      if (panel === disposingPanel) {
        panel = undefined;
        clearCockpitSingletonClaim();
        pushMissionBoard = undefined;
        pushApprovals = undefined;
        pushValidations = undefined;
        pushInbox = undefined;
        pushHandoff = undefined;
        pushTaskDetail = undefined;
        pushProbes = undefined;
        pushStudioReferenceData = undefined;
        pushTaskStudioEntity = undefined;
        pushPinStudioEntity = undefined;
        doOpenActivityTranscript = undefined;
        wiredPanel = undefined;
        navEpoch += 1;
        // t-610705 (Phase D, D3) — a later fresh panel must never inherit a disposed panel's route
        // provenance (design-dueto probe-43bca1cc: module-scoped router state outlives any one panel).
        currentRoute = routes.section("overview");
        lastCommittedNonStudioRoute = routes.section("overview");
        missionAgentLists.clear();
        stopActivityBinding();
        stopStudioBinding();
        deps.plugins.unbindControlEmbed();
      }
    });
  }
  const live = panel;

  if (opts?.route) {
    if (revealingExisting) await requestNavigate(opts.route, live);
    else navigate(opts.route);
  } else if (opts?.section) {
    const target = routes.section(resolveCockpitSection(opts.section));
    if (revealingExisting) await requestNavigate(target, live);
    else navigate(target);
  }

  /**
   * SDD 479 phase 5 — read the PERSONAL override the way the sidebar reads it, so Control's statement
   * about what is in effect cannot disagree with the cards themselves.
   *
   * Same key, same validator, same "an empty object is not an attempt to configure anything" rule as
   * `SidebarPrototype.cardTemplateFor`. What differs is only the question being asked: the sidebar
   * needs the resolved template, this needs whether one exists and whether it was honored.
   */
  /** t-aaad95 — the global file's state as Control shows it, including a refusal it must not hide. */
  const globalSettingsState = (): CockpitGlobalSettingsState => {
    const store = sharedGlobalSettings();
    const current = store.current();
    const refusal = store.refusal();
    return {
      file: store.file,
      activityCodeTheme: current.activityCodeTheme,
      agentPaneEnabled: current.agentPaneEnabled,
      gitPath: current.gitPath,
      hasCardTemplate: current.sidebarCardTemplate !== undefined,
      ...(refusal ? { refusal: refusal.errors } : {}),
    };
  };

  const personalCardTemplateState = (): { state: "none" | "active" | "refused"; errors?: string[] } => {
    const written = sharedGlobalSettings().current().sidebarCardTemplate;
    if (written === undefined || written === null) return { state: "none" };
    if (typeof written === "object" && !Array.isArray(written) && Object.keys(written as object).length === 0) {
      return { state: "none" };
    }
    const parsed = parseCardTemplate(written, "sidebar.cardTemplate");
    return parsed.config ? { state: "active" } : { state: "refused", errors: parsed.errors };
  };

  const sendModel = async () => {
    const epoch = navEpoch;
    let model: CockpitModel;
    try {
      // t-af3eef — collect only what this section reads. The section is computed once, below, and
      // reused for the needs, so there is exactly one authority for "which view is this" and the
      // needs cannot drift from the model that gets built. Navigation to a section that reads
      // neither classified slice no longer waits on either.
      const section = navSection(currentRoute) ?? "overview";
      const bundles = await deps.collect(collectNeedsFor(section));
      // t-610705 (Phase D, D3) — navSection(currentRoute) is null for pin (nav-less); "overview"
      // here is only "which background section data stays warm underneath the studio form", NOT a
      // claim that the Overview tab is active (tab highlighting is suppressed client-side instead —
      // see cockpit/App.tsx's `isNavlessStudio`).
      model = buildCockpitModel(bundles, {
        section,
        wsHash: controlWsHash,
        personalCardTemplate: personalCardTemplateState(),
        globalSettings: globalSettingsState(),
      });
      // SDD 480 Phase 4 — built only for the section that renders it. Folding the ledger on every
      // model tick would spend the projection on ~13 sections that never look at it.
      if (section === "execution-graph") {
        model.executionGraph = buildExecutionGraphSectionVm(deps, controlWsHash);
      }
    } catch (err) {
      model = buildCockpitModel(
        [
          {
            control: {
              folderName: "(cockpit)",
              workspaceRoot: "",
              wsHash: "error",
              bridgeUrl: "",
              identityError: err instanceof Error ? err.message : String(err),
            },
            agents: [],
            worktrees: [],
            deliveries: [],
            approvals: [],
          },
        ],
        { section: navSection(currentRoute) ?? "overview", wsHash: controlWsHash },
      );
    }
    // t-610705 (Phase C.1) — carries the exact route when it's a subroute; buildCockpitModel stays
    // route-shape-agnostic (see the field's doc comment on CockpitModel).
    if (currentRoute.kind !== "section") model.activeRoute = currentRoute;
    if (isStudioRoute(currentRoute)) {
      // t-610705 (Phase D, D0) — ensure-if-missing HERE too (not just in sendSectionModule): the
      // cockpit-level "ready" handler calls sendModel() BEFORE sendSectionModule(), and the client
      // needs `studioMountNonce` on THIS push to complete its own mount handshake. Idempotent on an
      // existing binding (routeKey match), so calling it from both places is safe.
      ensureStudioBinding(currentRoute, makeStudioAdapterFactory(deps.studios));
      const b = currentStudioBindingFor(currentRoute);
      if (b) {
        model.studioMountNonce = b.mountNonce;
        model.studioPersisted = b.persisted;
      }
    }
    if (panel === live && navEpoch === epoch) {
      live.webview.postMessage(modelMessage(model));
      live.title = sectionTitle(s, navSection(currentRoute) ?? "overview");
    }
  };

  const sendMission = async () => {
    if (panel !== live || !isSection(currentRoute, "mission")) return;
    const epoch = navEpoch;
    const ws = resolveMissionWs(deps.missionBoard);
    if (!ws) {
      live.webview.postMessage(taskErrorMessage("No Tachyon workspace for Mission board."));
      return;
    }
    try {
      // Trailing retry: a list that settles late (after its 250ms fallback already rendered, with
      // further refreshes coalesced behind it) re-posts once so real liveness replaces "unavailable".
      const vm = await buildMissionVm(ws, missionAgentLists, () => void sendMission());
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(snapshotMessage(vm));
    } catch (err) {
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(taskErrorMessage(err instanceof Error ? err.message : String(err)));
    }
  };

  const sendApprovals = async () => {
    if (panel !== live || !isSection(currentRoute, "approvals")) return;
    const epoch = navEpoch;
    const ws = resolveApprovalWs(deps.approvals);
    if (!ws) {
      live.webview.postMessage(approvalErrorMessage("No Tachyon workspace for Approvals."));
      return;
    }
    try {
      const vm = buildApprovalViewModel({ workspaceRoot: ws.workspaceRoot, folder: ws.folderName, wsHash: ws.wsHash });
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(approvalsMessage(vm));
    } catch (err) {
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(approvalErrorMessage(err instanceof Error ? err.message : String(err)));
    }
  };

  const sendValidations = async () => {
    if (panel !== live || !isSection(currentRoute, "validations")) return;
    const epoch = navEpoch;
    const ws = resolveMissionWs({ ...deps.missionBoard, getWorkspaces: deps.validations.getWorkspaces });
    if (!ws) {
      live.webview.postMessage(validationErrorMessage("No Tachyon workspace for Validations."));
      return;
    }
    try {
      const vm = buildValidationsViewModel({ folder: ws.folderName, wsHash: ws.wsHash, validations: ws.listValidations() });
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(validationsMessage(vm));
    } catch (err) {
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(validationErrorMessage(err instanceof Error ? err.message : String(err)));
    }
  };

  /**
   * t-e76acc — the unified Human Inbox.
   *
   * Reads BOTH stores through the SAME two functions the Approvals and Validations sections already
   * use, then projects them. There is no third read anywhere in this file, which is what keeps the
   * aggregate from being able to disagree with the surfaces it aggregates.
   *
   * A workspace that has approvals but no validations target still renders its approvals, and SAYS
   * that validations could not be read — an empty half of an inbox must never be indistinguishable
   * from a quiet one.
   */
  const inboxSources = (wsHash?: string) => {
    const approvalWs = resolveApprovalWs(deps.approvals, wsHash);
    if (!approvalWs) return undefined;
    const validationWs = deps.validations.getWorkspaces().find((w) => w.wsHash === approvalWs.wsHash);
    return { approvalWs, validationWs };
  };

  const buildInboxVm = (approvalWs: WorkspacePresentationTarget, validationWs: WorkspaceMissionControlTarget | undefined) =>
    buildHumanInboxViewModel({
      folder: approvalWs.folderName,
      wsHash: approvalWs.wsHash,
      approvals: listPendingApprovalViewItems(approvalWs.workspaceRoot),
      validations: validationWs
        ? buildValidationsViewModel({ folder: approvalWs.folderName, wsHash: approvalWs.wsHash, validations: validationWs.listValidations() }).validations
        : [],
      // SDD 482 phase 4C — Saved Agent proposals, read from the same store the Bridge writes to.
      // `unreadable` travels beside them rather than being dropped: a corrupt proposal is a thing the
      // human must SEE, and this is the only place where "someone edited this" is distinguishable
      // from "it was withdrawn".
      ...(() => {
        const queue = readLiveSavedAgentProposalQueue(approvalWs.workspaceRoot, Date.now());
        return {
          savedAgentProposals: queue.proposals.map((proposal) =>
            buildSavedAgentProposalReview({
              proposal,
              currentConfigSha256: workspaceConfigSha256(approvalWs.workspaceRoot),
              nowMs: Date.now(),
            })),
          untrustedSavedAgentProposals: queue.unreadable,
        };
      })(),
      // t-e4f662 — this workspace's own threshold; absent falls through to the product default.
      ...(() => {
        const configured = deps.humanInboxStaleAfter?.(approvalWs.wsHash);
        return configured === undefined ? {} : { staleAfterHours: configured };
      })(),
    });

  /**
   * t-e5e995 / t-00f4bc — a terminal Inbox decision removes the item from the pending projection,
   * so its detail route ceases to identify an actionable resource. Commit the parent route and
   * reload the shell + list as one navigation transaction. Callers invoke this only after their
   * own typed mutation succeeds; failures deliberately leave the detail route mounted with its
   * actionable error.
   *
   * Dogfood (t-00f4bc): staying on the dead detail route rendered a "no longer waiting" tombstone
   * after a normal Approve/Close. That tombstone is not used on the success path — navigation
   * replaces it. The host never posts `humanInboxItemMissing` after a terminal decision.
   */
  const returnToInbox = async () => {
    await requestNavigate(routes.section("inbox"), live, async () => {
      await sendModel();
      await sendSectionModule();
    });
  };

  const sendInbox = async () => {
    if (panel !== live || !isSection(currentRoute, "inbox")) return;
    const epoch = navEpoch;
    const sources = inboxSources();
    if (!sources) {
      live.webview.postMessage(humanInboxErrorMessage("No Tachyon workspace for the Human Inbox."));
      return;
    }
    try {
      const vm = buildInboxVm(sources.approvalWs, sources.validationWs);
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(humanInboxMessage(vm));
      if (!sources.validationWs) {
        live.webview.postMessage(humanInboxErrorMessage("Validations could not be read for this workspace — approvals only."));
      }
    } catch (err) {
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(humanInboxErrorMessage(err instanceof Error ? err.message : String(err)));
    }
  };

  /**
   * One opened item, with its evidence resolved for inline preview.
   *
   * The workspace comes from the ROUTE's own immutable locator, never the shell scope — the router's
   * rule for every entity route, and here it also decides which workspace root artifact paths are
   * allowed to resolve against, so getting it from the selector would be a containment bug as well as
   * a navigation one.
   */
  const sendInboxItem = async () => {
    if (panel !== live || currentRoute.kind !== "inbox-item") return;
    const route = currentRoute;
    const epoch = navEpoch;
    const sources = inboxSources(route.wsHash);
    if (!sources || sources.approvalWs.wsHash !== route.wsHash) {
      live.webview.postMessage(humanInboxErrorMessage("That workspace is no longer attached."));
      return;
    }
    try {
      const vm = buildInboxVm(sources.approvalWs, sources.validationWs);
      const item = buildHumanInboxItemViewModel(vm, route.itemKind, route.itemId, {
        workspaceRoot: sources.approvalWs.workspaceRoot,
        load: makeInboxArtifactLoader(sources.approvalWs.workspaceRoot),
      });
      if (panel !== live || navEpoch !== epoch) return;
      if (!item) {
        // The host has authoritatively re-read the queue and confirmed that this pending resource no
        // longer exists (for example, another window resolved it). Do not strand Control on a route
        // whose identity is gone; the list is both the recovery path and the truthful current state.
        await returnToInbox();
        return;
      }
      live.webview.postMessage(humanInboxItemMessage(item));
    } catch (err) {
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(humanInboxErrorMessage(err instanceof Error ? err.message : String(err)));
    }
  };

  // t-610705 (Phase C.3) — ported verbatim from the retired HandoffPanelManager's post(): a load
  // failure notifies (a toast), it does NOT post a distinct error VM — the client keeps whatever it
  // last had (or the loading state if nothing yet). Handoff's own VM already models "no file yet"
  // via `exists: false`, which isn't a failure case at all.
  const sendHandoff = async () => {
    // t-ace77f — a detail route now, so the workspace comes from the ROUTE's own immutable locator
    // (the router's rule for every entity route): switching Control's workspace scope while a
    // handoff document is open must not swap the document under the reader.
    if (panel !== live || currentRoute.kind !== "project-handoff") return;
    const epoch = navEpoch;
    const ws = resolveHandoffWs(deps.handoff, currentRoute.wsHash);
    if (!ws) return;
    try {
      const snap = await ws.loadHandoff();
      if (panel !== live || navEpoch !== epoch) return;
      const notes: HandoffNoteVM[] = snap.notes.map((note) => ({ ...note, evidence: [...note.evidence] }));
      const distillTargets: HandoffDistillTargetVM[] = snap.distillTargets.map((target) => ({ ...target }));
      const vm: HandoffViewModel = {
        folder: ws.folderName,
        exists: snap.exists,
        body: snap.body,
        staleness: snap.staleness,
        pendingCount: snap.pendingCount,
        updatedAt: snap.updatedAt,
        updatedBy: snap.updatedBy,
        revision: snap.revision,
        notes,
        distillTargets,
        distillProfiles: HANDOFF_DISTILL_PROFILES,
      };
      live.webview.postMessage(handoffMessage(vm));
    } catch (err) {
      if (panel !== live || navEpoch !== epoch) return;
      notify(`Could not refresh Project Handoff: ${err instanceof Error ? err.message : String(err)}`, "warn");
    }
  };

  const handleHandoffAction = async (m: Partial<HandoffAction>): Promise<boolean> => {
    // "refresh" is NOT handled here — it is the same wire string as the shell's own poll
    // (`case "refresh"` in the main switch below), which already calls sendSectionModule() →
    // sendHandoff() for the active section. Only Handoff's OWN action types need a dedicated
    // handler. ("ready" used to need the same warning; t-6ced6f answers it above this chain, so it
    // can no longer arrive here at all.)
    if (!m?.type || currentRoute.kind !== "project-handoff") return false;
    const routeWsHash = currentRoute.wsHash;
    if (m.type === "openFile") {
      const ws = resolveHandoffWs(deps.handoff, routeWsHash);
      if (ws) {
        try {
          const filePath = await ws.ensureHandoffFile();
          await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false, viewColumn: vscode.ViewColumn.Beside });
          await sendHandoff();
        } catch (err) {
          notify(`Could not open Project Handoff: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
      }
      return true;
    }
    if (m.type === "distill") {
      const ws = resolveHandoffWs(deps.handoff, routeWsHash);
      const action = parseHandoffDistillAction(m);
      if (!action) {
        notify("Invalid handoff distillation request.", "warn");
        return true;
      }
      if (ws) {
        try {
          const result = await ws.startHandoffDistill(action);
          notify(result.mode === "existing"
            ? `Handoff distillation task sent to '${result.agent}'.`
            : `Handoff distillation agent '${result.agent}' started.`);
        } catch (err) {
          notify(`Could not start handoff distillation: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
      }
      return true;
    }
    return false;
  };

  // t-527767 — shared by onCancelled (every studio) and onSaved (Pin/Task only — see onSaved's own
  // scoping comment below) since the "where does this studio route's exit land" computation is
  // IDENTICAL for both triggers; only whether-to-navigate-at-all differs.
  // t-c3c819 — task-detail is only a valid exit destination for a REAL, already-saved task; Task
  // Studio's staged-create pattern opens a brand-new task straight into studio-edit with a
  // pre-minted, still-unsaved id, and task-detail(id) for that id 404s ("never found on disk"). Fall
  // back to the studio's own section instead — "mission" (Board) is correct unconditionally here:
  // task-detail is task-only, parentRoute never produces it for any other studio (route.ts's
  // parentRoute switch), so this branch can't misfire for one.
  const studioExitTarget = (route: StudioRoute, persisted: boolean): CockpitRoute => {
    const parent = parentRoute(route);
    return parent?.kind === "task-detail" && !persisted ? routes.section("mission") : parent ?? routes.section("overview");
  };

  // t-610705 (Phase D, D0) — studio-envelope dispatch (ready/patch/dirty/save/cancel/domain). The
  // io/hooks capabilities are the SAME injected-capability shape activityFeed.ts established (post +
  // isCurrent), so a torn-down/replaced binding's in-flight work can never post into whatever
  // replaced it — see studioHost.ts's module doc for the full nav-transaction rationale.
  const studioIo = { post: (m: unknown) => live.webview.postMessage(m), isCurrent: () => panel === live };
  const studioDomainDispatch = makeStudioDomainDispatch(deps.studios);
  const dispatchStudioMessage = (raw: unknown): Promise<boolean> =>
    handleStudioMessage(studioIo, raw, {
      onChanged: deps.studios.onChanged,
      notify,
      handleDomainMessage: (ctx, message) => {
        if (isStudioRoute(currentRoute)) studioDomainDispatch(currentRoute, ctx, message);
      },
      // t-cdd4e1 — Cancel discards the draft server-side but never navigated anywhere; the studio
      // route just sat there with no visible effect. Navigate to the SAME destination the route's
      // own breadcrumb would (parentRoute already resolves pin's captured returnRoute vs every other
      // studio's flat/task-detail parent generically — no separate branching needed here, same as
      // "setSection"/"navigateReturn" below reuse it). Calls navigate() DIRECTLY, not requestNavigate
      // — Cancel is designed as an unconfirmed direct discard (see the "cancel" case's own comment in
      // studioHost.ts), so it must bypass beginStudioNavTransaction's checkpoint entirely rather than
      // re-prompt a dialog the user just explicitly opted out of by clicking Cancel.
      onCancelled: (persisted) => {
        if (!isStudioRoute(currentRoute)) return;
        navigate(studioExitTarget(currentRoute, persisted));
        void (async () => {
          await sendModel();
          await sendSectionModule();
        })();
      },
      // t-527767 — maintainer directive 2026-07-23: Pin/Task Studio read as "create/edit → return to
      // the list" — Save should navigate away automatically, same destination Cancel/Back already
      // use. Deliberately scoped to just these two: the other 5 studios (command/terminal/runbook/
      // schedule/agent) read more like config editors, where staying open to keep tweaking is the
      // better default — a maintainer decision, not an oversight (can extend later if it proves
      // wanted). Calls navigate() DIRECTLY, same as onCancelled — a save that just succeeded has
      // nothing left to confirm-discard, so this bypasses beginStudioNavTransaction's checkpoint the
      // same way Cancel does.
      onSaved: (persisted) => {
        if (!isStudioRoute(currentRoute)) return;
        if (currentRoute.studio !== "pin" && currentRoute.studio !== "task") return;
        navigate(studioExitTarget(currentRoute, persisted));
        void (async () => {
          await sendModel();
          await sendSectionModule();
        })();
      },
    });

  const sendRuntime = async () => {
    if (panel !== live || !isSection(currentRoute, "runtime")) return;
    const epoch = navEpoch;
    try {
      const snap = await deps.runtimeOps.buildSnapshot();
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(runtimeOpsSnapshotMessage(snap));
    } catch {
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(runtimeOpsSnapshotUnavailableMessage());
    }
  };

  let runtimeConfigKnownPaths = new Set<string>();
  const sendRuntimeConfig = async () => {
    if (panel !== live || !isSection(currentRoute, "runtime-config")) return;
    const epoch = navEpoch;
    const snapshot = deps.runtimeConfig.buildSnapshot(controlWsHash);
    if (panel !== live || navEpoch !== epoch) return;
    if (!snapshot) {
      live.webview.postMessage(runtimeConfigSnapshotUnavailableMessage());
      return;
    }
    runtimeConfigKnownPaths = new Set(snapshot.runtimes.flatMap((runtime) => runtime.documents.map((document) => document.path)));
    live.webview.postMessage(runtimeConfigSnapshotMessage(snapshot));
  };

  const sendInspector = async () => {
    if (panel !== live || !isSection(currentRoute, "tmux")) return;
    const epoch = navEpoch;
    let model: InspectorModel;
    try {
      const [snap, server] = await Promise.all([deps.inspector.snapshot(), deps.inspector.serverHealth()]);
      const busy = deps.inspector.cpuBusy(snap);
      model = buildInspectorModel(snap, deps.inspector.folderByHash(), busy, server);
    } catch {
      model = { groups: [], totalSessions: 0, liveSessions: 0, deadSessions: 0, orphanSessions: 0, busySessions: 0 };
    }
    if (panel !== live || navEpoch !== epoch) return;
    // Namespaced to avoid colliding with Control's own `init`/`model` messages.
    live.webview.postMessage({ type: "inspectorInit", strings: inspS });
    live.webview.postMessage({ type: "inspectorModel", model });
  };

  const bindPluginsIfNeeded = () => {
    if (isSection(currentRoute, "plugins")) {
      deps.plugins.bindControlEmbed(live.webview, controlWsHash);
    } else {
      deps.plugins.unbindControlEmbed();
    }
  };

  // t-610705 (Phase C.1) — the LAST KNOWN good projection for the task-detail route currently open,
  // keyed by task id (reset the moment the route changes to a different task or away entirely).
  // Ported verbatim from TaskDetailPanel.ts's tombstone contract (dueto F8): a task that disappears
  // or becomes unparseable renders from this cache instead of an empty/error screen. Control is a
  // singleton — at most one task-detail route is ever open, so a single slot (not a Map) suffices.
  let lastKnownTaskDetail: { taskId: string; wsHash: string; detail: import("../runtime-api/taskDetailProjection.js").TaskDetailProjectionV1 } | undefined;

  const resolveTaskDetailWs = (wsHash: string): WorkspaceTaskDetailTarget | undefined =>
    deps.taskDetail.getWorkspaces().find((w) => w.wsHash === wsHash);

  const sendTaskDetail = async () => {
    if (panel !== live || currentRoute.kind !== "task-detail") return;
    const route = currentRoute;
    const epoch = navEpoch;
    const ws = resolveTaskDetailWs(route.wsHash);
    const resolveBlobUri = (localPath: string): string => live.webview.asWebviewUri(vscode.Uri.file(localPath)).toString();
    if (!ws) {
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(taskMessage(emptyTombstoneVm(route.wsHash, route.taskId)));
      return;
    }
    // t-4d59d3 — the blob root must be an allowed local resource root before asWebviewUri() below
    // can resolve `attachment:<id>` refs. The per-navigation `live.webview.options` re-grant this
    // ported from TaskDetailPanel.ts (dogfood round 1 #5, spec 339) is GONE: reassigning options on
    // a live panel recreates the inner iframe, and that reload wedged at the fake.html placeholder,
    // blanking all of Control the moment a Board card was clicked. The standalone panel got away
    // with it because it re-set its own html around every open; Control sets html once. The grant
    // now happens ONCE at panel creation (each workspace's stable attachments parent — see the
    // creationResourceRoots comment above), which covers every task's blob dir.
    try {
      const detail = await ws.loadTaskDetail(route.taskId);
      if (panel !== live || navEpoch !== epoch) return;
      lastKnownTaskDetail = { taskId: route.taskId, wsHash: route.wsHash, detail };
      live.webview.postMessage(taskMessage(buildTaskDetailVm(ws, route.taskId, detail, false, resolveBlobUri)));
    } catch {
      if (panel !== live || navEpoch !== epoch) return;
      // the file disappeared or became unparseable — render a tombstone from the LAST KNOWN state,
      // never an empty screen (dueto F8); this task-detail route never redirects away on its own.
      if (lastKnownTaskDetail && lastKnownTaskDetail.taskId === route.taskId && lastKnownTaskDetail.wsHash === route.wsHash) {
        live.webview.postMessage(taskMessage(buildTaskDetailVm(ws, route.taskId, lastKnownTaskDetail.detail, true, resolveBlobUri)));
      } else {
        live.webview.postMessage(taskMessage(emptyTombstoneVm(route.wsHash, route.taskId)));
      }
    }
  };

  const handleTaskDetailAction = async (m: Partial<TaskDetailAction>): Promise<boolean> => {
    if (!m?.type || currentRoute.kind !== "task-detail") return false;
    const route = currentRoute;
    // t-2f6cdd — `requestSnapshot` is THIS route's action and is answered here. READY is NOT: it is
    // the Control SHELL's one-and-only handshake, and this handler runs first in the dispatch chain,
    // so consuming it here meant a panel whose FIRST route is task-detail — precisely what the
    // Attention card's "Open" creates — never got `initMessage(s)`. The client's `strings` stayed
    // undefined, and cockpit/App.tsx's `if (!s)` rendered `<div class="ds-empty" />`: an entirely
    // blank Control, with the detail's own render states (loading / never-found / tombstone) all
    // unreachable because the shell never mounted the route at all.
    //
    // t-6ced6f closed the class: READY is answered above this chain, so no handler here is offered
    // it. This comment stays as the record of why — the shape of the mistake is easy to repeat.
    if (m.type === "requestSnapshot") {
      await sendTaskDetail();
      return true;
    }
    const ws = resolveTaskDetailWs(route.wsHash);
    if (m.type === "updateTask" && m.patch) {
      if (ws) {
        try {
          await ws.updateTask(route.taskId, m.patch);
          // dogfood round 1 (#1) — the shared fan-out: re-posts this route, the Board, and the sidebar.
          deps.missionBoard.onTasksChanged();
        } catch (err) {
          live.webview.postMessage(taskDetailErrorMessage(err instanceof Error ? err.message : String(err)));
        }
      }
      return true;
    }
    if (m.type === "openTask" && typeof m.id === "string") {
      // in-place navigate to another task in the SAME workspace (a dep/related-task link) — a
      // subroute of a subroute stays a single active route, not a stack (the accepted multi-
      // instance trade-off applies here too). requestNavigate is a no-op guard here in practice
      // (currentRoute is already task-detail, never a studio route, at this call site) — used
      // anyway so every navigate-away call site is uniformly guarded, not "safe by an invariant a
      // future refactor could silently break."
      await requestNavigate(routes.taskDetail(route.wsHash, m.id), live, async () => {
        lastKnownTaskDetail = undefined;
        await sendModel();
        await sendSectionModule();
      });
      return true;
    }
    if ((m.type === "approvePrototype" || m.type === "rejectPrototype" || m.type === "notePrototype") &&
        typeof m.prototypeId === "string" && typeof m.expectUpdatedAt === "string") {
      if (ws) {
        try {
          const action = m.type === "approvePrototype" ? "approve" : m.type === "rejectPrototype" ? "reject" : "note";
          await ws.reviewPrototype(route.taskId, {
            prototypeId: m.prototypeId,
            action,
            expectUpdatedAt: m.expectUpdatedAt,
            ...(m.review ? { review: m.review } : {}),
          });
          deps.missionBoard.onTasksChanged();
        } catch (err) {
          live.webview.postMessage(taskDetailErrorMessage(err instanceof Error ? err.message : String(err)));
        }
      }
      return true;
    }
    if (m.type === "openTaskStudio") {
      // Task Studio isn't migrated yet (t-610705 Phase C.1 note on CockpitMissionBoard) — falls
      // through to the still-standalone TaskStudioPanelManager via the same deps hook the Board uses.
      if (ws) deps.missionBoard.openTaskStudio(ws, route.taskId);
      return true;
    }
    return false;
  };

  const resolveActivityWs = (wsHash: string): WorkspaceActivityTarget | undefined =>
    deps.activity.getWorkspaces().find((w) => w.wsHash === wsHash);

  // t-610705 (Phase C.2) — action-resolution bookkeeping for the CURRENT activity binding (openFile's
  // allow-list, share/transcript resolution). Deliberately host-side state distinct from
  // activityFeed.ts's own closure: that module owns feed MECHANICS only, this owns what a webview
  // ACTION is allowed to touch — same split TaskDetailPanel's tombstone cache keeps from taskDetailVm.ts.
  let activityKnownPaths = new Set<string>();
  let activityLatestVm: ActivityViewModel | undefined;
  let activityTranscriptPath: string | undefined;

  /**
   * Start-if-missing only. `navigate()` already tore down any MISMATCHED binding synchronously
   * (reconcileActivityTeardown) — by the time this runs, either a binding for the CURRENT identity
   * already exists (re-entry / cockpit READY on an unchanged route: nothing to do, the live watcher
   * already covers it) or none exists at all (fresh entry: start one). Called from sendSectionModule,
   * same convention every other route's content-push already follows (always right after sendModel()).
   */
  const ensureActivityBinding = () => {
    if (currentRoute.kind !== "agent-activity") return;
    const route = currentRoute;
    if (activityBinding && activityBinding.wsHash === route.wsHash && activityBinding.agent === route.agent) return;
    const ws = resolveActivityWs(route.wsHash);
    if (!ws) return; // a stale revive/deep-link — no matching workspace; the route stays open, empty.
    const generation = ++activityGeneration;
    const capturedPanel = live;
    const isCurrent = () => panel === capturedPanel && activityBinding?.generation === generation;
    const feed = startActivityFeed(ws, route.agent, {
      isCurrent,
      post: (vm, prepended) => {
        if (!isCurrent()) return;
        const shareVm = withActivityShareKeys(route.agent, vm);
        activityLatestVm = shareVm;
        activityKnownPaths = new Set([...shareVm.summary.filesChanged, ...shareVm.summary.filesReferenced]);
        activityTranscriptPath = shareVm.sourcePath;
        capturedPanel.webview.postMessage(activityMessage(route.wsHash, route.agent, shareVm, prepended));
      },
      postImage: (id, dataUri) => {
        if (!isCurrent()) return;
        capturedPanel.webview.postMessage(imageDataMessage(route.wsHash, route.agent, id, dataUri));
      },
    });
    activityBinding = { generation, wsHash: route.wsHash, agent: route.agent, feed };
  };

  const resolveActivityShareOrNotify = (agent: string, sequence: unknown, key: unknown) => {
    const resolved = resolveActivityShare(agent, activityLatestVm, sequence, key);
    if (!resolved.ok) {
      notify("That Activity item is no longer available. Refresh the Activity view and try again.", "warn");
      return undefined;
    }
    return resolved.payload;
  };

  const copyActivityShareText = async (agent: string, sequence: unknown, key: unknown): Promise<void> => {
    const payload = resolveActivityShareOrNotify(agent, sequence, key);
    if (!payload) return;
    await vscode.env.clipboard.writeText(payload.text);
    notify("Activity share text copied.");
  };

  // t-a983e1 — channel chosen in-webview product QuickPicker (no vscode.showQuickPick).
  const shareActivityExternal = async (
    agent: string,
    sequence: unknown,
    key: unknown,
    channel: ExternalShareChannel,
  ): Promise<void> => {
    const payload = resolveActivityShareOrNotify(agent, sequence, key);
    if (!payload) return;
    const label = channel === "email" ? "Email" : "WhatsApp";
    const preview = payload.text.length > 1400 ? `${payload.text.slice(0, 1400).trimEnd()}\n\n[preview truncated]` : payload.text;
    const ok = await showNotification(`Share this Activity item via ${label}?`, "info", ["Open"], { modal: true, detail: preview });
    if (ok !== "Open") return;
    if (channel === "email") {
      const subject = encodeURIComponent(`Tachyon Activity from ${agent}`);
      const body = encodeURIComponent(payload.urlText);
      await vscode.env.openExternal(vscode.Uri.parse(`mailto:?subject=${subject}&body=${body}`));
    } else {
      await vscode.env.openExternal(vscode.Uri.parse(`https://wa.me/?text=${encodeURIComponent(payload.urlText)}`));
    }
  };

  const runningActivityAgentTargets = async (ws: WorkspaceActivityTarget, sourceAgent: string): Promise<Array<{ name: string; description: string }>> => {
    const context = await ws.activityContext(sourceAgent);
    return context.targets.items.map((target) => ({
      name: target.name,
      description: target.lifetime === "saved" ? "Saved Agent" : "Temporary Agent",
    }));
  };

  /** Prepare path: list targets → post SHARE_AGENT_TARGETS for in-webview QuickPicker. */
  const prepareShareActivityToAgent = async (
    wsHash: string,
    sourceAgent: string,
    sequence: unknown,
    key: unknown,
  ): Promise<void> => {
    if (typeof sequence !== "number" || typeof key !== "string" || !key) return;
    // Ensure the share payload still resolves (same warn as execute path).
    if (!resolveActivityShareOrNotify(sourceAgent, sequence, key)) return;
    const ws = resolveActivityWs(wsHash);
    if (!ws) return;
    const targets = await runningActivityAgentTargets(ws, sourceAgent);
    if (targets.length === 0) {
      notify("No other running Tachyon agent is available for this Activity share.");
      return;
    }
    live.webview.postMessage(shareAgentTargetsMessage(sequence, key, targets));
  };

  // t-a983e1 — destination already chosen in-webview; host revalidates + modal confirm + paste.
  const shareActivityToAgent = async (
    wsHash: string,
    sourceAgent: string,
    sequence: unknown,
    key: unknown,
    toAgent: string,
  ): Promise<void> => {
    const payload = resolveActivityShareOrNotify(sourceAgent, sequence, key);
    if (!payload) return;
    const ws = resolveActivityWs(wsHash);
    if (!ws) return;
    // t-610705 (Phase C.2, hardening dueto probe-2d90286d MAJOR) — this flow spans a user-paced
    // QuickPicker + modal confirm; capture the binding generation now and recheck before the
    // actual side effect (ws.sendAgentInput) so navigating away mid-flow silently abandons the
    // paste instead of sending it into whatever agent/workspace is now on screen.
    const myGeneration = activityBinding?.generation;
    if (activityBinding?.generation !== myGeneration) return;
    const stillLive = (await runningActivityAgentTargets(ws, sourceAgent)).some((t) => t.name === toAgent);
    if (!stillLive) {
      notify(`Agent '${toAgent}' is no longer available.`, "warn");
      return;
    }
    const prompt = internalSharePrompt(payload);
    const preview = prompt.length > 1400 ? `${prompt.slice(0, 1400).trimEnd()}\n\n[preview truncated]` : prompt;
    const ok = await showNotification(`Paste Activity context into '${toAgent}'?`, "info", ["Paste"], { modal: true, detail: preview });
    if (ok !== "Paste") return;
    if (activityBinding?.generation !== myGeneration) return;
    await ws.sendAgentInput(toAgent, prompt, false);
    notify(`Activity context pasted into '${toAgent}' (not submitted).`);
  };

  const handleActivityAction = async (m: Partial<ActivityWebviewMessage>): Promise<boolean> => {
    if (!m?.type || currentRoute.kind !== "agent-activity") return false;
    const route = currentRoute;
    if (m.type === "openFile" && typeof m.path === "string" && activityKnownPaths.has(m.path)) {
      void vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true, viewColumn: vscode.ViewColumn.Beside });
      return true;
    }
    if (m.type === "terminal") {
      void vscode.commands.executeCommand("tachyon.openAgentTerminalItem", route.agent, route.wsHash);
      return true;
    }
    if (m.type === "loadOlder") {
      activityBinding?.feed.loadOlder();
      return true;
    }
    if (m.type === COPY_SHARE_TEXT) {
      void copyActivityShareText(route.agent, m.sequence, m.key);
      return true;
    }
    if (m.type === SHARE_EXTERNAL) {
      const channel = m.channel === "email" || m.channel === "whatsapp" ? m.channel : undefined;
      if (!channel) {
        notify("Share channel missing — pick Email or WhatsApp in the Activity picker.", "warn");
        return true;
      }
      void shareActivityExternal(route.agent, m.sequence, m.key, channel);
      return true;
    }
    if (m.type === SHARE_TO_AGENT) {
      if (typeof m.toAgent === "string" && m.toAgent) {
        void shareActivityToAgent(route.wsHash, route.agent, m.sequence, m.key, m.toAgent);
      } else {
        // Prepare: push targets for product QuickPicker (t-a983e1).
        void prepareShareActivityToAgent(route.wsHash, route.agent, m.sequence, m.key);
      }
      return true;
    }
    return false;
  };

  const resolveProbesWs = (wsHash: string): WorkspaceProbePresentationTarget | undefined =>
    deps.probes.getWorkspaces().find((w) => w.wsHash === wsHash);

  // t-610705 (Phase C.2) — mirrors the retired ProbeResultPanelManager's renderToken (same-route
  // double-call ordering guard) — deliberately a SEPARATE counter from navEpoch/activityGeneration,
  // since two sendProbes() calls for the SAME route+epoch can legitimately overlap (e.g. cockpit
  // READY racing the refreshCockpitProbes fan-out).
  let probesRequestToken = 0;

  const sendProbes = async () => {
    if (panel !== live) return;
    if (currentRoute.kind !== "agent-probes" && currentRoute.kind !== "workspace-probes") return;
    const route = currentRoute;
    const epoch = navEpoch;
    const myToken = ++probesRequestToken;
    const ws = resolveProbesWs(route.wsHash);
    if (!ws) {
      if (panel !== live || navEpoch !== epoch || myToken !== probesRequestToken) return;
      live.webview.postMessage(probesMessage({ folder: "", error: "No Tachyon workspace for Probes." }));
      return;
    }
    const caller = route.kind === "agent-probes" ? route.agent : undefined;
    try {
      const view = await ws.probeView(caller);
      if (panel !== live || navEpoch !== epoch || myToken !== probesRequestToken) return;
      live.webview.postMessage(probesMessage({ folder: ws.folderName, view }));
    } catch (err) {
      if (panel !== live || navEpoch !== epoch || myToken !== probesRequestToken) return;
      live.webview.postMessage(probesMessage({ folder: ws.folderName, error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const sendSectionModule = async () => {
    // t-ac79a7 — the ready half of the navigation bracket. Captured here (not after the awaits)
    // because `currentRoute` can be superseded while a module loads; the client matches this key
    // against its pending one and ignores a stale ready instead of clearing a newer navigation's
    // pending state.
    const readyEpoch = navEpoch;
    const readyKey = routeKey(currentRoute);
    bindPluginsIfNeeded();
    if (isSection(currentRoute, "mission")) await sendMission();
    else if (isSection(currentRoute, "validations")) await sendValidations();
    else if (currentRoute.kind === "project-handoff") await sendHandoff();
    else if (isSection(currentRoute, "approvals")) await sendApprovals();
    else if (isSection(currentRoute, "inbox")) await sendInbox();
    else if (currentRoute.kind === "inbox-item") await sendInboxItem();
    else if (isSection(currentRoute, "runtime")) await sendRuntime();
    else if (isSection(currentRoute, "runtime-config")) await sendRuntimeConfig();
    else if (isSection(currentRoute, "tmux")) await sendInspector();
    else if (isSection(currentRoute, "plugins")) deps.plugins.refreshControlEmbed();
    else if (currentRoute.kind === "task-detail") await sendTaskDetail();
    else if (currentRoute.kind === "agent-activity") ensureActivityBinding();
    else if (currentRoute.kind === "agent-probes" || currentRoute.kind === "workspace-probes") await sendProbes();
    else if (isStudioRoute(currentRoute)) {
      // t-610705 (Phase D, D0) — start-if-missing only, same idempotent-on-same-identity convention
      // as ensureActivityBinding: the actual content push happens once the mounted studio App's OWN
      // "ready" (studio-envelope) handshake matches this binding's routeKey+mountNonce (round-2 F3).
      ensureStudioBinding(currentRoute, makeStudioAdapterFactory(deps.studios));
    }
    // t-ac79a7 — same liveness guard every send*() above uses: a module that finished loading for a
    // route the user already navigated away from must not report itself ready.
    if (panel === live && navEpoch === readyEpoch) live.webview.postMessage(routeReadyMessage(readyKey));
  };

  pushMissionBoard = () => { void sendMission(); };
  pushApprovals = () => { void sendApprovals(); };
  pushValidations = () => { void sendValidations(); };
  // t-e76acc — one slot drives BOTH inbox surfaces; each sender no-ops off its own route.
  pushInbox = () => { void sendInbox(); void sendInboxItem(); };
  pushHandoff = () => { void sendHandoff(); };
  pushTaskDetail = () => { void sendTaskDetail(); };
  pushProbes = () => { void sendProbes(); };
  // t-610705 (Phase D, D1a) — no "sendX" wrapper needed: refreshStudioReferenceData already takes
  // the io capability directly (same studioIo the studio-envelope dispatch above uses), and is a
  // no-op with no binding — the isStudioRoute guard here just avoids the pointless call off-route.
  pushStudioReferenceData = () => { if (isStudioRoute(currentRoute)) void refreshStudioReferenceData(studioIo); };
  pushTaskStudioEntity = () => { if (isStudioRoute(currentRoute) && currentRoute.studio === "task") void sendStudioLoad(studioIo); };
  pushPinStudioEntity = () => { if (isStudioRoute(currentRoute) && currentRoute.studio === "pin") void sendStudioLoad(studioIo); };
  doOpenActivityTranscript = () => {
    if (currentRoute.kind !== "agent-activity") {
      notify("Open an agent's Activity view first, then run “Open Raw Transcript”.");
      return;
    }
    if (activityTranscriptPath && fs.existsSync(activityTranscriptPath)) {
      void vscode.window.showTextDocument(vscode.Uri.file(activityTranscriptPath), { preview: true, viewColumn: vscode.ViewColumn.Beside });
    } else {
      notify("Source transcript is no longer on disk — the rendered activity is preserved in Tachyon's durable log.");
    }
  };

  const handleMissionAction = async (m: Partial<MissionControlAction>): Promise<boolean> => {
    if (!m?.type) return false;
    if (m.type === "requestSnapshot") {
      await sendMission();
      return true;
    }
    if (m.type === "updateTask" && typeof m.id === "string" && m.patch) {
      const ws = resolveMissionWs(deps.missionBoard);
      if (!ws) return true;
      try {
        await ws.updateTask(m.id, m.patch);
        deps.missionBoard.onTasksChanged();
      } catch (err) {
        live.webview.postMessage(taskErrorMessage(err instanceof Error ? err.message : String(err), m.id));
      }
      return true;
    }
    if (m.type === "reorderLane" && typeof m.status === "string" && Array.isArray(m.orderedIds) && m.expect) {
      const ws = resolveMissionWs(deps.missionBoard);
      if (!ws) return true;
      try {
        await ws.reorderLane(m.status, m.priority, { orderedIds: m.orderedIds, expect: m.expect });
        deps.missionBoard.onTasksChanged();
      } catch (err) {
        live.webview.postMessage(taskErrorMessage(err instanceof Error ? err.message : String(err)));
      }
      return true;
    }
    if (m.type === "closeValidation" && typeof m.id === "string" && typeof m.result_note === "string" && m.outcome) {
      const ws = resolveMissionWs(deps.missionBoard);
      if (!ws) return true;
      try {
        await ws.closeValidation(m.id, { outcome: m.outcome, result_note: m.result_note });
        deps.missionBoard.onTasksChanged();
      } catch (err) {
        live.webview.postMessage(taskErrorMessage(err instanceof Error ? err.message : String(err), m.id));
      }
      return true;
    }
    if (m.type === "openTask" && typeof m.id === "string") {
      // t-610705 (Phase C.1) — Task Detail is a Control subroute now: navigate in place instead of
      // opening a standalone panel. The board card's own workspace resolves the entity's wsHash
      // (the route's immutable locator — independent of the shell's workspace-scope selector).
      const ws = resolveMissionWs(deps.missionBoard);
      if (ws) {
        await requestNavigate(routes.taskDetail(ws.wsHash, m.id), live, async () => {
          lastKnownTaskDetail = undefined;
          await sendModel();
          await sendSectionModule();
        });
      }
      return true;
    }
    if (m.type === "copyTaskId" && typeof m.id === "string") {
      await vscode.env.clipboard.writeText(m.id);
      return true;
    }
    if (m.type === "openTaskStudio") {
      const ws = resolveMissionWs(deps.missionBoard);
      if (ws) deps.missionBoard.openTaskStudio(ws, typeof m.id === "string" ? m.id : undefined);
      return true;
    }
    return false;
  };

  const handleApprovalAction = async (m: Partial<ApprovalAction>): Promise<boolean> => {
    if (!m?.type) return false;
    if (m.type === "resolve" && typeof m.id === "string" && (m.decision === "approved" || m.decision === "denied")) {
      const ws = resolveApprovalWs(deps.approvals);
      if (!ws) return true;
      try {
        await deps.approvals.resolve(ws.wsHash, m.id, m.decision);
        await sendApprovals();
      } catch (err) {
        live.webview.postMessage(approvalErrorMessage(err instanceof Error ? err.message : String(err), m.id));
      }
      return true;
    }
    return false;
  };

  const handleValidationsAction = async (m: Partial<ValidationsAction>): Promise<boolean> => {
    if (!m?.type) return false;
    if (m.type === "refreshValidations") {
      await sendValidations();
      return true;
    }
    // t-3990c3 — this handler used to resolve a workspace (and short-circuit `return true`) for
    // EVERY inbound message reaching it, not just its own action types: when
    // deps.validations.getWorkspaces() was empty, `if (!ws) return true` swallowed ANY message —
    // including "ready" — so Control never initialized at all with zero validations-capable
    // workspaces attached (discovered via t-610705 Phase C.2's cockpitActivity tests, which send a
    // bare "ready" through the full chain instead of a route that intercepts it earlier).
    if (m.type !== "closeValidationItem" && m.type !== "assignValidation") return false;
    const ws = resolveMissionWs({ ...deps.missionBoard, getWorkspaces: deps.validations.getWorkspaces });
    if (!ws) return true;
    try {
      if (m.type === "closeValidationItem" && typeof m.id === "string" && typeof m.note === "string" && m.outcome) {
        await ws.closeValidation(m.id, { outcome: m.outcome, result_note: m.note });
      } else if (m.type === "assignValidation" && typeof m.id === "string" && typeof m.assignee === "string" && m.expect) {
        await ws.assignValidation(m.id, m.assignee, m.expect);
      } else {
        return false;
      }
      deps.validations.onValidationsChanged();
      await sendValidations();
    } catch (err) {
      const actionId = "id" in m && typeof m.id === "string" ? m.id : undefined;
      live.webview.postMessage(validationErrorMessage(err instanceof Error ? err.message : String(err), actionId));
    }
    return true;
  };

  /**
   * t-e76acc — acting on an inbox row.
   *
   * Every branch dispatches into the SAME typed path that row's own section already uses, with that
   * path's own authority checks — `deps.approvals.resolve` for an approval, the workspace target's
   * `closeValidation`/`assignValidation` for a validation. Nothing here resolves anything itself, and
   * there is deliberately no shared "resolve this row" branch the two kinds pass through: the ratified
   * rule is that a validation can never be redeemed as an authorization, and the way to keep a rule
   * like that is to leave no code path that could express it.
   *
   * Route-gated, like every other handler in this chain: these action types are unique to the Inbox,
   * and off an inbox route the handler returns false so `ready`/`refresh` reach the shell.
   */
  const handleInboxAction = async (m: Partial<HumanInboxAction>): Promise<boolean> => {
    if (!m?.type) return false;
    if (m.type === "refreshInbox") {
      await sendInbox();
      await sendInboxItem();
      return true;
    }
    if (m.type === "openInboxItem" && typeof m.id === "string" && (m.kind === "approval" || m.kind === "validation" || m.kind === "saved-agent-proposal")) {
      const sources = inboxSources();
      if (!sources) return true;
      const kind = m.kind;
      const id = m.id;
      await requestNavigate(routes.inboxItem(sources.approvalWs.wsHash, kind, id), live, async () => {
        await sendModel();
        await sendSectionModule();
      });
      return true;
    }
    if (m.type === "resolveInboxApproval" && typeof m.id === "string" && (m.decision === "approved" || m.decision === "denied")) {
      // The approval capability path, unchanged and unshared: same call the Approvals section makes.
      const wsHash = currentRoute.kind === "inbox-item" ? currentRoute.wsHash : inboxSources()?.approvalWs.wsHash;
      if (!wsHash) return true;
      try {
        await deps.approvals.resolve(wsHash, m.id, m.decision);
        await returnToInbox();
      } catch (err) {
        live.webview.postMessage(humanInboxErrorMessage(err instanceof Error ? err.message : String(err)));
      }
      return true;
    }
    /**
     * SDD 482 phase 4C — the human decision that creates a Saved Agent.
     *
     * The DIGEST arrives from the pane and is passed straight through to the commit path, which
     * compares it against the stored proposal. That is what makes an approval bind to one exact
     * proposal: if the file changed between render and click, this refuses instead of creating
     * something the human never saw. Nothing here is reachable from the Bridge — an approval an agent
     * could reach is not an approval.
     */
    if (m.type === "decideSavedAgentProposal" && typeof m.id === "string" && typeof m.digest === "string") {
      const wsHash = currentRoute.kind === "inbox-item" ? currentRoute.wsHash : undefined;
      const sources = inboxSources(wsHash);
      if (!sources) {
        live.webview.postMessage(humanInboxErrorMessage("Saved Agent proposals are not available for this workspace."));
        return true;
      }
      const workspaceRoot = sources.approvalWs.workspaceRoot;
      try {
        if (m.decision === "deny") {
          denySavedAgentProposal({
            workspaceRoot, proposalId: m.id, deniedBy: "human",
            reason: typeof m.reason === "string" && m.reason.trim() ? m.reason.trim() : "no reason given",
            nowMs: Date.now(),
          });
        } else if (m.decision === "approve") {
          const result = await deps.approveSavedAgentProposal?.({ workspaceRoot, proposalId: m.id, approvedDigest: m.digest });
          // A host without the port wired must say so rather than silently doing nothing — the shape
          // of failure that teaches a human their approval is decorative.
          if (!result) {
            live.webview.postMessage(humanInboxErrorMessage("This window cannot commit Saved Agent proposals."));
            return true;
          }
          if (!result.ok) {
            live.webview.postMessage(humanInboxErrorMessage(`${result.code}: ${result.reason}`));
            return true;
          }
        } else {
          return true;
        }
        await returnToInbox();
      } catch (err) {
        live.webview.postMessage(humanInboxErrorMessage(err instanceof Error ? err.message : String(err)));
      }
      return true;
    }
    if (m.type === "closeInboxValidation" || m.type === "assignInboxValidation") {
      const wsHash = currentRoute.kind === "inbox-item" ? currentRoute.wsHash : inboxSources()?.approvalWs.wsHash;
      const ws = wsHash ? deps.validations.getWorkspaces().find((w) => w.wsHash === wsHash) : undefined;
      if (!ws) {
        live.webview.postMessage(humanInboxErrorMessage("Validations are not available for this workspace."));
        return true;
      }
      try {
        if (m.type === "closeInboxValidation" && typeof m.id === "string" && typeof m.note === "string" && m.outcome) {
          await ws.closeValidation(m.id, { outcome: m.outcome, result_note: m.note });
        } else if (m.type === "assignInboxValidation" && typeof m.id === "string" && typeof m.assignee === "string" && m.expect) {
          await ws.assignValidation(m.id, m.assignee, m.expect);
        } else {
          return true;
        }
        deps.validations.onValidationsChanged();
        if (m.type === "closeInboxValidation") {
          await returnToInbox();
        } else {
          await sendInbox();
          await sendInboxItem();
        }
      } catch (err) {
        live.webview.postMessage(humanInboxErrorMessage(err instanceof Error ? err.message : String(err)));
      }
      return true;
    }
    return false;
  };

  const handleInspectorAction = async (m: Partial<InspectorAction>): Promise<boolean> => {
    if (!m?.type || !INSPECTOR_ACTION_TYPES.has(m.type)) return false;
    if (!isSection(currentRoute, "tmux")) return false;
    switch (m.type) {
      case "open":
        if (m.session) deps.inspector.open(m.session);
        return true;
      case "reapDead":
        await deps.inspector.reapDead();
        await sendInspector();
        return true;
      case "reapOrphans":
        await deps.inspector.reapOrphans();
        await sendInspector();
        return true;
      case "capture": {
        if (!m.session) return true;
        let text = "";
        try {
          text = await deps.inspector.capture(m.session);
        } catch {
          text = "";
        }
        live.webview.postMessage({ type: "inspectorCapture", session: m.session, text });
        return true;
      }
      case "kill": {
        if (!m.session) return true;
        const ok = await showNotification(
          vscode.l10n.t("Kill session {0}? This stops the process and removes the pane.", m.session),
          "warn",
          [vscode.l10n.t("Kill")],
          { modal: true },
        );
        if (ok) {
          try {
            await deps.inspector.kill(m.session);
          } catch {
            /* gone */
          }
          await sendInspector();
        }
        return true;
      }
      default:
        return false;
    }
  };

  if (wiredPanel !== live) {
    wiredPanel = live;
    live.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      if (panel !== live || !msg || typeof msg !== "object" || typeof msg.type !== "string") return;
      const type = msg.type;

      /**
       * t-6ced6f — READY is answered HERE, above the per-route chain, and never reaches it.
       *
       * READY is the SHELL's handshake (spec 278), not any route's action: it is the only source of
       * the `init` that carries `strings`, and without it cockpit/App.tsx renders
       * `if (!s) return <div class="ds-empty" />` — an entirely blank Control tab. It used to be
       * answered at the BOTTOM of this listener, behind nine handlers that each get to `return true`
       * and end dispatch, so any one of them could consume the panel's one handshake and leave the
       * shell unmounted.
       *
       * Three did, through three different doors: t-3990c3 (`handleValidationsAction` swallowed EVERY
       * message when no workspace had validations), `handleHandoffAction` (carries a comment warning
       * that it must not), and t-2f6cdd (`handleTaskDetailAction` answered READY deliberately, so a
       * panel opened straight onto task-detail — what the Attention card's "Open" creates — never
       * initialized). Each was fixed alone; nothing stopped a fourth.
       *
       * Hoisting it makes the whole class unreachable instead of forbidden by convention: no route
       * handler can swallow a message it is never offered. `cockpitReadyHandshake.test.ts` asserts
       * this for every route kind the Control can open.
       *
       * The `studioProtocolVersion` guard is NOT incidental, and "no handler has a legitimate reason
       * to see READY" is too strong a claim without it. The studio protocol reuses this exact wire
       * string for its OWN per-mount handshake — `envelope({ type: "ready", routeKey, mountNonce })`
       * — which `dispatchStudioMessage` must receive to bind the mount and post the `load`. Matching
       * on `type` alone starved every studio of it, committing this very bug in the other direction
       * (cockpitStudio.test.ts caught it, 7 failures). The SHELL's ready is the BARE one; an
       * enveloped ready is the studio's and falls through to its dispatcher below.
       */
      if (type === READY && msg.studioProtocolVersion === undefined) {
        live.webview.postMessage(initMessage(s));
        await sendModel();
        await sendSectionModule();
        // t-610705 (Phase C.2) — a (re)loaded cockpit webview's client-side image cache is empty;
        // ensureActivityBinding() above is a no-op when the binding already exists (the shared 3s
        // poll must never touch it — see route.ts's refreshPolicy doc), so THIS is the one place
        // that explicitly recovers a still-live feed's images after a reload.
        if (currentRoute.kind === "agent-activity") activityBinding?.feed.replayImages();
        return;
      }

      // t-610705 (Phase C.1) — MUST run before handleMissionAction: TaskDetailAction's "openTask"
      // is the same {type,id} shape as MissionControlAction's, and would otherwise be misrouted to
      // the Board's handler (wrong workspace resolution — task-detail pins its own wsHash, not the
      // shell scope). handleTaskDetailAction itself no-ops (returns false) off a task-detail route.
      if (await handleTaskDetailAction(msg as Partial<TaskDetailAction>)) return;
      if (await handleMissionAction(msg as Partial<MissionControlAction>)) return;
      if (await handleApprovalAction(msg as Partial<ApprovalAction>)) return;
      if (await handleValidationsAction(msg as Partial<ValidationsAction>)) return;
      // t-e76acc — the Inbox's action types are its own ("refreshInbox"/"openInboxItem"/…), so there
      // is no shape collision with the two handlers above; it still runs after them, matching the
      // chain's existing most-specific-first ordering.
      if (await handleInboxAction(msg as Partial<HumanInboxAction>)) return;
      if (await handleInspectorAction(msg as Partial<InspectorAction>)) return;
      // t-610705 (Phase C.2) — no shape collision with any registry above (openFile/terminal/
      // loadOlder/shareExternal/copyShareText/shareToAgent are unique to Activity); route-gated
      // (route.kind !== "agent-activity" → false) same as every other handler in this chain.
      if (await handleActivityAction(msg as Partial<ActivityWebviewMessage>)) return;
      // t-610705 (Phase C.3) — "openFile"/"distill" are unique to Handoff; route-gated the same way.
      if (await handleHandoffAction(msg as Partial<HandoffAction>)) return;
      // t-610705 (Phase D, D0) — studio-envelope messages carry `studioProtocolVersion`, a field no
      // other action in this chain has; `handleStudioMessage` returns false (falls through) when
      // there's no current binding or the message doesn't decode, so this is safe unconditionally.
      if (await dispatchStudioMessage(msg)) return;

      if (isRuntimeOpsSetProviderObservationAction(msg)) {
        try {
          await deps.runtimeOps.configureProviderObservation?.(msg.provider, msg.enabled);
        } catch {
          /* next snapshot wins */
        }
        await sendRuntime();
        return;
      }

      if (isRuntimeOpsInspectSessionAction(msg)) {
        // t-283149 — no navEpoch guard: the reply is addressed to an agentKey, so a row that is gone
        // simply has nowhere to land. Dropping it on nav would instead leave a row spinning forever.
        const agentKey = `${msg.workspaceKey}:${msg.agent}`;
        try {
          const inspect = deps.runtimeOps.inspectAgentSession;
          if (!inspect) throw new Error("This engine does not expose session inspection.");
          const inspection = await inspect(msg.workspaceKey, msg.agent);
          if (panel === live) live.webview.postMessage(runtimeOpsSessionInspectionMessage(agentKey, { inspection }));
        } catch (error) {
          if (panel === live) {
            live.webview.postMessage(
              runtimeOpsSessionInspectionMessage(agentKey, { error: error instanceof Error ? error.message : String(error) }),
            );
          }
        }
        return;
      }

      // Plugin product actions only (install/update/…). Never steal cockpit `ready`/`refresh` —
      // those must always run the Control shell init/model + sendSectionModule path (which binds the embed).
      if (PLUGIN_ACTION_TYPES.has(type) && isSection(currentRoute, "plugins")) {
        if (deps.plugins.handleControlEmbedMessage(msg as never)) return;
      }

      const c = msg as unknown as CockpitAction;
      switch (c.type) {
        case "studioNavCheckpointAck":
          if (typeof c.txnId === "string") handleStudioNavCheckpointAck(c);
          return;
        // t-6ced6f — no `case READY:` here. It is answered at the TOP of this listener, before the
        // per-route chain, and returns there; a second site would be a second thing to keep in sync.
        case "refresh":
          await sendModel();
          await sendSectionModule();
          return;
        case "setSection":
          // t-610705 (Phase C.0) — sugar over navigate(); C.1+ adds a "navigate" message carrying
          // real subroute params once there's a subroute to send. Bumps navEpoch, so any in-flight
          // send*() from the section being left discards its result instead of posting it late.
          // t-610705 (Phase D, D0) — the load-bearing requestNavigate call site: a nav-tab click
          // while a dirty studio route is active goes through the navigation-transaction FSM.
          await requestNavigate(routes.section(resolveCockpitSection(c.section)), live, async () => {
            await sendModel();
            await sendSectionModule();
          });
          return;
        case "openProjectHandoff": {
          // t-ace77f — same resolve-then-navigate shape as fleetActivity: pick the workspace ONCE
          // at dispatch time (Control's current scope, falling back like every other action), then
          // bake that hash into the route as the document's immutable locator.
          const ws = resolveHandoffWs(deps.handoff);
          if (ws) {
            await requestNavigate(routes.projectHandoff(ws.wsHash), live, async () => {
              await sendModel();
              await sendSectionModule();
            });
          }
          return;
        }
        case "navigateReturn":
          // t-610705 (Phase D, D3) — pin's ONLY breadcrumb action. The DESTINATION is deliberately
          // never client-sent (design-dueto probe-43bca1cc: a client-sent route payload widens the
          // trust boundary from "pick one of N enum values" to "send back an arbitrary route object"
          // for no real benefit) — the host is the sole authority on where "back" goes, reading its
          // OWN already-sanitized `currentRoute.returnRoute`. `c.routeKey` is the client's identity
          // snapshot of the pin route it was showing when clicked — checked against the CURRENT
          // route before acting (design-dueto probe-12f603f3 major finding: without this, a delayed
          // click from a pin the user already navigated away from could fire against whatever pin is
          // current by the time this handler runs, navigating to the WRONG pin's returnRoute — a
          // stale-message confused-deputy bug, not route-payload injection, but still a real navigate-
          // to-the-wrong-place bug).
          if (!isStudioRoute(currentRoute) || currentRoute.studio !== "pin" || routeKey(currentRoute) !== c.routeKey) return;
          await requestNavigate(currentRoute.returnRoute ?? routes.section("overview"), live, async () => {
            await sendModel();
            await sendSectionModule();
          });
          return;
        case "switchControlWorkspace":
          // t-d16a39 — "" = All workspaces. Re-send model (aggregate sections re-scope) AND the
          // active section's module (per-workspace sections re-resolve; plugins embed re-binds).
          // t-610705 (Phase C.0) — a scope switch also bumps navEpoch: it's the same "the world
          // changed" event class as navigation (a slow response built for the old scope must not
          // land after the switch).
          controlWsHash = c.wsHash || undefined;
          navEpoch += 1;
          await sendModel();
          await sendSectionModule();
          return;
        case "copyDiagnostics": {
          try {
            // A diagnostics dump is explicitly a full picture of the world, so it pays for both
            // classified reads on purpose — the one place where the old always-collect cost is right.
            const bundles = await deps.collect(COLLECT_EVERYTHING);
            const text = formatCockpitDiagnostics(buildCockpitModel(bundles, { section: navSection(currentRoute) ?? "overview" }));
            await vscode.env.clipboard.writeText(text);
            live.webview.postMessage(toastMessage(s.copied, "ok"));
          } catch (err) {
            live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
          }
          return;
        }
        case "openSettings":
          deps.openSettings();
          return;
        // t-aaad95 — Control writes the global Tachyon file directly. It is a shell-owned, per-person
        // file: routing it through the engine would put a machine-local preference on the workspace
        // wire for no gain. `update` re-validates through the same parser a hand edit goes through,
        // so Control cannot write a document the loader would then refuse.
        case "setGlobalSettings":
          try {
            sharedGlobalSettings().update(c.patch);
            await sendModel();
          } catch (err) {
            live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
          }
          return;
        case "openGlobalSettingsFile":
          await vscode.commands.executeCommand("tachyon.openGlobalSettings");
          return;
        // t-aaad95 — the personal override's home is the global Tachyon file now, and opening it is
        // also the documented recovery path when Control itself will not open.
        case "openPersonalCardTemplate":
          await vscode.commands.executeCommand("tachyon.openGlobalSettings");
          return;
        case "openDoctor":
          deps.openDoctor();
          return;
        case "fleetStart":
          if (typeof c.name === "string") {
            try {
              await deps.fleetStart(c.name, typeof c.wsHash === "string" ? c.wsHash : undefined);
              await sendModel();
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        case "fleetStop":
          if (typeof c.name === "string") {
            try {
              await deps.fleetStop(c.name, typeof c.wsHash === "string" ? c.wsHash : undefined);
              await sendModel();
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        // spec 444 — Worktrees hygiene. The engine re-validates every call fail-closed; a refusal
        // (state changed since render) surfaces as a toast, never a forced removal.
        case "worktreeRemove":
          if (typeof c.id === "string") {
            try {
              const refusal = await deps.worktreeRemove(c.id, c.deleteBranch === true, typeof c.wsHash === "string" ? c.wsHash : undefined);
              if (refusal) live.webview.postMessage(toastMessage(refusal, "warn"));
              await sendModel();
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        case "worktreeForgetRecord":
          if (typeof c.id === "string") {
            try {
              const refusal = await deps.worktreeForgetRecord(c.id, typeof c.wsHash === "string" ? c.wsHash : undefined);
              if (refusal) live.webview.postMessage(toastMessage(refusal, "warn"));
              await sendModel();
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        case "worktreeBatchCleanup": {
          // Each item re-validates independently engine-side — a refused item drops out of the
          // batch with its reason; the rest proceed (spec 444's preview/confirm concurrency rule).
          const items = Array.isArray(c.items) ? c.items : [];
          const skipped: string[] = [];
          let done = 0;
          for (const item of items) {
            if (!item || typeof item !== "object") continue;
            const { id, op, wsHash } = item as { id?: unknown; op?: unknown; wsHash?: unknown };
            if (typeof id !== "string" || (op !== "remove" && op !== "forget")) continue;
            try {
              const refusal = op === "remove"
                ? await deps.worktreeRemove(id, false, typeof wsHash === "string" ? wsHash : undefined)
                : await deps.worktreeForgetRecord(id, typeof wsHash === "string" ? wsHash : undefined);
              if (refusal) skipped.push(`${id}: ${refusal}`);
              else done += 1;
            } catch (err) {
              skipped.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          const summary = skipped.length > 0
            ? vscode.l10n.t("Cleanup: {0} done, {1} skipped — {2}", done, skipped.length, skipped.join("; "))
            : vscode.l10n.t("Cleanup: {0} done", done);
          live.webview.postMessage(toastMessage(summary, "info"));
          await sendModel();
          return;
        }
        case "fleetTerminal":
          if (typeof c.name === "string") {
            try {
              await deps.fleetTerminal(c.name, typeof c.wsHash === "string" ? c.wsHash : undefined);
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        case "fleetActivity":
          // t-610705 (Phase C.2) — navigates in place, same pattern as the Board's "openTask" case
          // in C.1: resolve the workspace ONCE at dispatch time (fallback-style, mirrors every other
          // Fleet action), then bake the resolved wsHash into the route as its immutable locator.
          if (typeof c.name === "string") {
            const ws = resolveFleetActivityWs(deps.activity, typeof c.wsHash === "string" ? c.wsHash : undefined);
            if (ws) {
              await requestNavigate(routes.agentActivity(ws.wsHash, c.name), live, async () => {
                await sendModel();
                await sendSectionModule();
              });
            }
          }
          return;
        case "fleetProbes":
          // t-610705 (Phase D, D1c) — same fallback-resolve-then-navigate pattern as fleetActivity
          // above; the agent-probes route existed since C.2 but was only reachable via the
          // agent-less `tachyon.openProbes` command until Fleet grew its own button.
          if (typeof c.name === "string") {
            const ws = resolveFleetProbesWs(deps.probes, typeof c.wsHash === "string" ? c.wsHash : undefined);
            if (ws) {
              await requestNavigate(routes.agentProbes(ws.wsHash, c.name), live, async () => {
                await sendModel();
                await sendSectionModule();
              });
            }
          }
          return;
        case "fleetAgentStudio":
          // t-610705 (Phase D, D1c) — same kind-routed dispatch as the sidebar's
          // `tachyon.editAgentStudioItem` (extension.ts): a Temporary (undeclared) agent has no stored
          // definition to edit — the client already hides this button for those rows (`a.declared
          // !== false`), this re-checks authoritatively rather than trusting that client-side gate.
          if (typeof c.name === "string") {
            const ws = resolveFleetStudioWs(deps.studios, typeof c.wsHash === "string" ? c.wsHash : undefined);
            // t-610705 (Phase D, D1c code-review finding) — Object.hasOwn, not a plain index read:
            // `c.name` is an attacker-reachable webview-message field, and `agents[c.name]` for a
            // name like "constructor"/"__proto__"/"toString" would otherwise resolve an INHERITED
            // Object.prototype property instead of `undefined` — truthy, so it would slip past the
            // "not declared" guard and navigate to a bogus studio-edit route for a nonexistent
            // entity instead of warning.
            const def = ws?.config && Object.hasOwn(ws.config.agents, c.name) ? ws.config.agents[c.name] : undefined;
            if (ws && def) {
              const studio = def.kind === "terminal" ? "terminal" : "agent";
              await requestNavigate(routes.studioEdit(studio, ws.wsHash, c.name), live, async () => {
                await sendModel();
                await sendSectionModule();
              });
            } else if (ws) {
              notify(`'${c.name}' is not saved in tachyon.yml (a Temporary instance has no stored definition)`, "warn");
            }
          }
          return;
        case "fleetContinueTask":
          if (typeof c.name === "string" && typeof c.toName === "string") {
            try {
              await deps.fleetContinueTask(
                c.name,
                c.toName,
                typeof c.wsHash === "string" ? c.wsHash : undefined,
              );
              await sendModel();
              live.webview.postMessage(toastMessage(vscode.l10n.t("Continue task started"), "ok"));
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        case "revealPath":
          if (typeof c.path === "string" && c.path) deps.revealPath(c.path);
          return;
        case "openRuntimeConfigSource":
          if (typeof c.path === "string" && runtimeConfigKnownPaths.has(c.path) && isSection(currentRoute, "runtime-config")) {
            try {
              await deps.runtimeConfig.openSource(c.path);
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err)));
            }
          }
          return;
        case "saveRuntimeConfigChanges":
          if ((c.runtime === "codex" || c.runtime === "claude") && typeof c.documentId === "string" && Array.isArray(c.changes) && isSection(currentRoute, "runtime-config")) {
            try {
              await deps.runtimeConfig.saveChanges({
                wsHash: controlWsHash,
                runtime: c.runtime,
                documentId: c.documentId,
                expectedRevision: typeof c.expectedRevision === "string" ? c.expectedRevision : undefined,
                changes: c.changes,
              });
              await sendRuntimeConfig();
              live.webview.postMessage(toastMessage("Runtime configuration saved."));
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err)));
            }
          }
          return;
        case "copyText":
          if (typeof c.text === "string") {
            await vscode.env.clipboard.writeText(c.text);
            live.webview.postMessage(toastMessage(s.copied, "ok"));
          }
          return;
        case "openConfigFile":
          try {
            await deps.openConfigFile(typeof c.wsHash === "string" ? c.wsHash : undefined);
          } catch (err) {
            live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
          }
          return;
        case "engineLogClear":
          if (typeof c.wsHash === "string" && c.wsHash) {
            try {
              await deps.clearEngineLog(c.wsHash);
              await sendModel();
              live.webview.postMessage(toastMessage("Log cleared", "ok"));
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        case "engineLogJournal":
          if (typeof c.wsHash === "string" && c.wsHash) {
            try {
              deps.openEngineJournal(c.wsHash);
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        case "setIdleAfterMinutes":
          // t-585d5c — the value was already validated by the runtime-api schema this calls into, so
          // the only check here is the shape the wire could malform.
          if (typeof c.wsHash === "string" && c.wsHash) {
            try {
              await deps.setIdleAfterMinutes(c.wsHash, c.minutes);
              await sendModel();
              live.webview.postMessage(
                toastMessage(
                  c.minutes === undefined
                    ? vscode.l10n.t("Idle notifications back to the default")
                    : c.minutes === "never"
                      ? vscode.l10n.t("Idle notifications turned off")
                      : vscode.l10n.t("Idle notifications after {0} min", String(c.minutes)),
                  "ok",
                ),
              );
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        case "setCompanionTabTools":
          if (typeof c.wsHash === "string" && c.wsHash && typeof c.enabled === "boolean") {
            try {
              await deps.setCompanionTabTools(c.wsHash, c.enabled);
              await sendModel();
              live.webview.postMessage(
                toastMessage(
                  c.enabled
                    ? vscode.l10n.t("Companion tab tools listed for agents")
                    : vscode.l10n.t("Companion tab tools hidden from agents"),
                "ok",
                ),
              );
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        case "setCompanionAllowedHosts":
          if (typeof c.wsHash === "string" && c.wsHash && Array.isArray(c.hosts)) {
            try {
              const hosts = c.hosts.filter((h): h is string => typeof h === "string");
              await deps.setCompanionAllowedHosts(c.wsHash, hosts);
              await sendModel();
              live.webview.postMessage(
                toastMessage(
                  hosts.length === 0
                    ? vscode.l10n.t("Companion allowed hosts cleared (all hosts)")
                    : vscode.l10n.t("Companion allowed hosts updated ({0})", String(hosts.length)),
                "ok",
                ),
              );
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        case "unpairCompanionDevice":
          if (typeof c.wsHash === "string" && c.wsHash) {
            try {
              const deviceId = typeof c.deviceId === "string" && c.deviceId ? c.deviceId : undefined;
              await deps.unpairCompanionDevice(c.wsHash, deviceId);
              await sendModel();
              live.webview.postMessage(toastMessage(vscode.l10n.t("Companion device unpaired"), "ok"));
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        case "issueCompanionPairCode":
          if (typeof c.wsHash === "string" && c.wsHash) {
            try {
              const offer = await deps.issueCompanionPairCode(c.wsHash);
              live.webview.postMessage({ type: "companionPairOffer", offer });
              if (offer.ok) {
                live.webview.postMessage(
                  toastMessage(vscode.l10n.t("Companion pair code ready (expires soon)"), "ok"),
                );
              }
            } catch (err) {
              live.webview.postMessage({
                type: "companionPairOffer",
                offer: { ok: false, reason: err instanceof Error ? err.message : String(err) },
              });
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
      }
    });
  }

  if (creating) {
    const uri = (f: string): string => live.webview.asWebviewUri(vscode.Uri.joinPath(deps.extensionUri, "dist", "webview", f)).toString();
    // t-610705 (SDD 410 Phase B) — CSS co-load: a section's sheet only loads eagerly in the shell
    // when it's the opening section (flash-free first paint); otherwise its URI ships via a
    // bootstrap global and the client injects it when the lazy section body loads
    // (src/webview/shared/lazySectionStyles.ts). Each Phase B PR moves one more surface's sheet
    // from always-eager to this scheme; sheets not yet migrated stay eager unconditionally.
    const approvalsIsActive = isSection(currentRoute, "approvals");
    // t-e76acc — ONE condition covers the section and its item subroute: they share a stylesheet, and
    // a panel opened straight onto an item (revived/deep link) must paint styled too.
    const inboxIsActive = isSection(currentRoute, "inbox") || currentRoute.kind === "inbox-item";
    const runtimeIsActive = isSection(currentRoute, "runtime");
    const validationsIsActive = isSection(currentRoute, "validations");
    const pluginsIsActive = isSection(currentRoute, "plugins");
    const tmuxIsActive = isSection(currentRoute, "tmux");
    const missionIsActive = isSection(currentRoute, "mission");
    const taskDetailIsActive = currentRoute.kind === "task-detail";
    const activityIsActive = currentRoute.kind === "agent-activity";
    const probesIsActive = currentRoute.kind === "agent-probes" || currentRoute.kind === "workspace-probes";
    const handoffIsActive = currentRoute.kind === "project-handoff";
    // t-610705 (Phase D, D0/D1a) — studio-frame.css is shared by every StudioPanelManagerBase-based
    // studio (StudioFrame.tsx); each studio's OWN sheet is a separate conditional (D1b/D2/D3 add
    // theirs alongside command/terminal/runbook/schedule here, one `studioX ? uri(...) : undefined`
    // per StudioId — no shared/combined conditional the way mermaid-block.css above is, since each
    // studio's own sheet is genuinely distinct content, not the same href under a different
    // bootstrap-global key).
    const studioIsActive = isStudioRoute(currentRoute);
    const commandStudioIsActive = isStudioRoute(currentRoute) && currentRoute.studio === "command";
    const terminalStudioIsActive = isStudioRoute(currentRoute) && currentRoute.studio === "terminal";
    const runbookStudioIsActive = isStudioRoute(currentRoute) && currentRoute.studio === "runbook";
    const scheduleStudioIsActive = isStudioRoute(currentRoute) && currentRoute.studio === "schedule";
    const agentStudioIsActive = isStudioRoute(currentRoute) && currentRoute.studio === "agent";
    const taskStudioIsActive = isStudioRoute(currentRoute) && currentRoute.studio === "task";
    const pinStudioIsActive = isStudioRoute(currentRoute) && currentRoute.studio === "pin";
    // t-610705 (Phase C.2) — ported from the retired standalone ActivityPanel.ts: mermaid/katex load
    // ON DEMAND client-side (activity/markdown.tsx), gated on these globals being present at all —
    // never previously wired into Cockpit.ts's shell (Task Detail's C.1 migration also uses
    // MarkdownView but never needed these either; unrelated pre-existing gap, out of scope here).
    // Static bundle URIs are harmless to include even on a route that never triggers them.
    // t-aaad95 — the global Tachyon file, not VS Code settings. It always resolves a value (the
    // parser fills every field, and a refused document falls back to the last known good), so the
    // defensive `?? "auto"` the old getConfiguration read needed is gone with it.
    const codeTheme = sharedGlobalSettings().current().activityCodeTheme;
    const activityThemeClass = codeTheme === "dark" ? "tac-theme-dark" : codeTheme === "light" ? "tac-theme-light" : "";
    live.webview.html = renderWebviewShell({
      cspSource: live.webview.cspSource,
      title: s.title,
      bodyClass: activityThemeClass || undefined,
      // t-610705 (Phase C.1) — task-detail needs frame-src 'self' for PrototypePreview's sandboxed
      // srcdoc iframe (the standalone TaskDetailPanel.ts set this too); purely additive to the CSP,
      // no effect on any other already-embedded section.
      frameSrc: "self",
      // t-610705 (Phase D, D2) — the CSP tranche the design doc's security-probe requirement exists
      // to gate. Verified against the actual code paths (not copied blind from the retired
      // TaskStudioPanel.ts config), per probe-6a55db50's adversarial review:
      //  - imgBlob: pasted-image blob: URLs rendered inline in the rich-doc editor.
      //  - connectSrc: rich-doc/VisualsPanel.tsx's uriToDataURL() does `fetch(att.uri)` on a same-
      //    origin asWebviewUri resource (the "annotate an existing image" flow) — without this,
      //    that fetch is blocked outright (falls back to default-src 'none').
      //  - workerSrc: "blob" — Excalidraw's own vendor bundle constructs a Worker via
      //    `new Worker(URL.createObjectURL(...))`; confirmed by grepping
      //    node_modules/@excalidraw/excalidraw/dist for the literal `new Worker(` call.
      //  - childSrc: "blob" was DROPPED (present in the old standalone panel's config, copied
      //    forward into the first cut of this diff) — the probe's adversarial pass caught that it's
      //    INERT here: CSP only falls back to child-src for frame/worker loads when frame-src/
      //    worker-src are ABSENT, and this shell always sets frame-src ('self', for the unrelated
      //    PrototypePreview iframe) and worker-src (blob:, above) explicitly — so child-src's blob:
      //    token is never consulted for either. No blob-iframe usage exists in rich-doc/excalidraw
      //    to justify it either way. Removing it shrinks the grant to only what's provably load-
      //    bearing.
      //
      // t-610705 (Phase D, D3) — "CSP tranche 2" (studios-routes-design.md's sequencing table) turns
      // out to add NOTHING new: Pin Studio's attachment/Excalidraw needs are a strict subset of Task
      // Studio's (same putXStudioImage/putXStudioSketch base64-in, dataUri-out pattern — see
      // PinStudioTarget.ts's D3 port of TaskStudioTarget.ts's D2 fix — no CAS, no prototype iframe).
      // The grants below already cover it; re-verified against Pin's actual diff by its own
      // pre-landing adversarial probe rather than assumed. See D2's comment immediately below for
      // each grant's own justification (still accurate, now serving 2 studios instead of 1).
      //
      // Emitted ONCE at panel creation for Control's whole lifetime (this `<meta>` isn't re-rendered
      // per route) — a PERMANENT grant across the entire Cockpit surface, not scoped to when a Task
      // Studio route is actually active. The probe's verdict (SHIP WITH CONDITIONS) and the
      // maintainer's recorded acceptance of the panel-wide-CSP trade-off are in t-610705's journal.
      imgBlob: true,
      connectSrc: true,
      workerSrc: "blob",
      // No nested `[...]` inside this literal — test/unit/cockpitCssParity.test.ts source-scans this
      // exact array via a non-greedy `styles:\s*\[([\s\S]*?)\]` regex, so an inline array literal
      // (e.g. a `...(cond ? [x] : [])` spread) closes the match early at ITS `]` and silently
      // truncates everything after. Ternary-to-undefined + filter keeps the block bracket-free.
      styles: [
        uri("codicon.css"),
        uri("design-system.css"),
        uri("vscode-theme.css"),
        missionIsActive ? uri("mission-control.tailwind.css") : undefined,
        missionIsActive ? uri("mission-control.css") : undefined,
        pluginsIsActive ? uri("plugins.tailwind.css") : undefined,
        pluginsIsActive ? uri("plugins.css") : undefined,
        approvalsIsActive ? uri("approval.css") : undefined,
        inboxIsActive ? uri("human-inbox.css") : undefined,
        validationsIsActive ? uri("validations.css") : undefined,
        runtimeIsActive ? uri("runtime-ops.css") : undefined,
        tmuxIsActive ? uri("inspector.css") : undefined,
        // one shared conditional for the mermaid stylesheet — task-detail and activity both render
        // markdown that can carry mermaid blocks; a second, separately-gated call for that same file
        // would duplicate the link and fail cockpitCssParity's no-duplicate-link check (its source
        // scan can't tell a real call from one merely mentioned in a comment, so don't write it here).
        (taskDetailIsActive || activityIsActive || handoffIsActive) ? uri("mermaid-block.css") : undefined,
        taskDetailIsActive ? uri("task-detail.css") : undefined,
        activityIsActive ? uri("activity.css") : undefined,
        probesIsActive ? uri("probes.css") : undefined,
        handoffIsActive ? uri("handoff.css") : undefined,
        // t-610705 (Phase D, D1b) — Agent Studio's Tailwind utilities sheet loads BEFORE studio-frame.css
        // (not alongside its own surface sheet below) — matches the retired standalone panel's
        // styleFiles order exactly (vscode-theme.css → agent-studio-shell.tailwind.css → studio-frame.css
        // → agent-studio-shell.css), so studio-frame.css's own rules still win the cascade over any
        // Tailwind utility class at equal specificity, same as it always has for this surface.
        agentStudioIsActive ? uri("agent-studio-shell.tailwind.css") : undefined,
        // t-610705 (Phase D, D2) — same Tailwind-before-studio-frame ordering as Agent Studio above;
        // rich-doc.css (entity-neutral editor styles, shared with the retired standalone panel + the
        // dev preview harness) loads BEFORE studio-frame.css too — matches the old standalone panel's
        // `styleFiles` order exactly (codicon, design-system, vscode-theme, task-studio.tailwind,
        // rich-doc, studio-frame, task-studio), so studio-frame.css's shell-chrome rules still win the
        // cascade over rich-doc.css at equal specificity, same as they always have for this surface.
        taskStudioIsActive ? uri("task-studio.tailwind.css") : undefined,
        // t-610705 (Phase D, D3) — Pin Studio shares Task Studio's rich-doc.css (same entity-neutral
        // editor sheet, no Tailwind sheet of its own) — one shared conditional, same reasoning as the
        // "*-mermaid" shared conditionals above (a second, separately-gated call for the identical
        // file would duplicate the <link> and fail cockpitCssParity's no-duplicate-link check).
        (taskStudioIsActive || pinStudioIsActive) ? uri("rich-doc.css") : undefined,
        studioIsActive ? uri("studio-frame.css") : undefined,
        commandStudioIsActive ? uri("command-studio-shell.css") : undefined,
        terminalStudioIsActive ? uri("terminal-studio-shell.css") : undefined,
        runbookStudioIsActive ? uri("runbook-studio-shell.css") : undefined,
        scheduleStudioIsActive ? uri("schedule-studio-shell.css") : undefined,
        agentStudioIsActive ? uri("agent-studio-shell.css") : undefined,
        taskStudioIsActive ? uri("task-studio.css") : undefined,
        pinStudioIsActive ? uri("pin-studio.css") : undefined,
        uri("cockpit.css"),
      ].filter((href): href is string => href !== undefined),
      bundle: uri("cockpit.js"),
      module: true,
      mode: "live",
      // t-610705 (Phase C.0) — always PERSIST v2 (route, not section); decodePanelState still
      // understands a v1 disk record for the restore boundary of a panel closed before this PR.
      persistedState: {
        schemaVersion: 2,
        view: COCKPIT_VIEW_TYPE,
        route: currentRoute,
        ...(controlWsHash ? { wsHash: controlWsHash } : {}),
      } satisfies CockpitPanelState,
      bootstrapGlobals: {
        /**
         * SDD 479 phase 4 — the sidebar stylesheet, for the card preview's SHADOW ROOT only.
         *
         * Deliberately NOT a `__tachyonSectionStyles` entry: every key in that map is co-loaded into
         * `<head>` by `loadSectionStylesheet` (and `cockpitCssParity.test.ts` enforces that pairing).
         * `sidebar.css` is a global sheet — it styles `body`, `#root`, `.row` — so reaching this page's
         * head would restyle Control. It travels alone, and only the shadow root links it.
         */
        __tachyonCardPreviewCss: uri("sidebar.css"),
        __tachyonSectionStyles: {
          approvals: uri("approval.css"),
          inbox: uri("human-inbox.css"),
          // t-e76acc — own key, same href: the item route is reachable by deep link without the list
          // block ever running (see cockpit/App.tsx's lazy blocks for the convention).
          "inbox-item": uri("human-inbox.css"),
          runtime: uri("runtime-ops.css"),
          validations: uri("validations.css"),
          "plugins-tailwind": uri("plugins.tailwind.css"),
          plugins: uri("plugins.css"),
          tmux: uri("inspector.css"),
          "mission-tailwind": uri("mission-control.tailwind.css"),
          mission: uri("mission-control.css"),
          "task-detail-mermaid": uri("mermaid-block.css"),
          "task-detail": uri("task-detail.css"),
          "activity-mermaid": uri("mermaid-block.css"),
          activity: uri("activity.css"),
          probes: uri("probes.css"),
          "handoff-mermaid": uri("mermaid-block.css"),
          handoff: uri("handoff.css"),
          // per-studio "studio-frame-<id>" keys (not one shared "studio-frame") — see
          // cockpit/App.tsx's doc comment on the lazy studio blocks for why: same convention as the
          // 3 "*-mermaid" keys above, one distinct key per client call site even though every key
          // resolves to the same studio-frame.css href.
          "studio-frame-command": uri("studio-frame.css"),
          "studio-command": uri("command-studio-shell.css"),
          "studio-frame-terminal": uri("studio-frame.css"),
          "studio-terminal": uri("terminal-studio-shell.css"),
          "studio-frame-runbook": uri("studio-frame.css"),
          "studio-runbook": uri("runbook-studio-shell.css"),
          "studio-frame-schedule": uri("studio-frame.css"),
          "studio-schedule": uri("schedule-studio-shell.css"),
          "studio-frame-agent": uri("studio-frame.css"),
          "studio-agent-tailwind": uri("agent-studio-shell.tailwind.css"),
          "studio-agent": uri("agent-studio-shell.css"),
          "studio-frame-task": uri("studio-frame.css"),
          "studio-task-tailwind": uri("task-studio.tailwind.css"),
          "studio-task-richdoc": uri("rich-doc.css"),
          "studio-task": uri("task-studio.css"),
          // t-610705 (Phase D, D3) — own key even though it resolves to the SAME rich-doc.css href as
          // "studio-task-richdoc" — matches the per-studio-key convention "studio-frame-<id>" already
          // uses (one distinct key per client call site, not a shared key across two lazy blocks).
          "studio-frame-pin": uri("studio-frame.css"),
          "studio-pin-richdoc": uri("rich-doc.css"),
          "studio-pin": uri("pin-studio.css"),
        },
        __mermaidSrc: uri("mermaid.js"),
        __katexSrc: uri("katex.js"),
        __katexCssUri: uri("katex.min.css"),
        __codeThemeForced: codeTheme,
        // t-610705 (Phase D, D2) — Task Studio's VisualsPanel/SketchModal read these three
        // `window.*` globals (task-studio/App.tsx's `readAssets()`) to locate the Excalidraw bundle —
        // same shape TaskStudioPanel.ts's (retired) standalone `bootstrapGlobals` already provided,
        // now emitted unconditionally like every other bootstrap global here (harmless on a route
        // that never mounts Task Studio — same reasoning Phase C.2's mermaid/katex URIs already use).
        EXCALIDRAW_SCRIPT_URI: uri("excalidraw.js"),
        EXCALIDRAW_CSS_URI: uri("excalidraw.css"),
        EXCALIDRAW_ASSET_PATH: uri("").replace(/\/?$/, "/"),
      },
    });
  } else {
    await sendModel();
    await sendSectionModule();
  }
}
