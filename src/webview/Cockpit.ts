import * as vscode from "vscode";
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
} from "../cockpit/model.js";
import {
  initMessage,
  modelMessage,
  toastMessage,
  type CockpitAction,
  type CockpitStrings,
} from "./cockpit/messages.js";
import type { WorkspaceMissionControlTarget } from "../shell/MissionControlTarget.js";
import type { WorkspacePresentationTarget, WorkspaceProbePresentationTarget } from "../shell/WorkspacePresentation.js";
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
  SHARE_EXTERNAL,
  COPY_SHARE_TEXT,
  SHARE_TO_AGENT,
  type ActivityWebviewMessage,
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
import { buildApprovalViewModel } from "./approval/viewModel.js";
import { buildValidationsViewModel } from "./validations/viewModel.js";
import {
  validationsMessage,
  validationErrorMessage,
  type ValidationsAction,
} from "./validations/messages.js";
import type { ApprovalDecision } from "../bridge/approvalRequest.js";
import {
  runtimeOpsSnapshotMessage,
  runtimeOpsSnapshotUnavailableMessage,
  isRuntimeOpsSetProviderObservationAction,
} from "./runtime-ops/messages.js";
import type { RuntimeOpsSnapshot, RuntimeOpsProviderV2 } from "../runtimeOps/types.js";
import {
  type InspectorStrings,
  type InspectorAction,
} from "./inspector/messages.js";
import { buildInspectorModel, type InspectorModel, type TmuxServerSnapshot } from "../inspector/model.js";
import type { PaneSnapshot } from "../tmux/TmuxService.js";
import { notify, showNotification } from "../workspace/NotificationService.js";
import type { PluginsPanelManager } from "./PluginsPanel.js";
import { isStudioRoute } from "../cockpit/route.js";
import {
  reconcileStudioTeardown,
  stopStudioBinding,
  ensureStudioBinding,
  handleStudioMessage,
  handleStudioNavCheckpointAck,
  beginStudioNavTransaction,
  currentStudioBindingFor,
  refreshStudioReferenceData,
} from "../cockpit/studioHost.js";
import { makeStudioAdapterFactory, makeStudioDomainDispatch, type CockpitStudios } from "../cockpit/studioRegistry.js";
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
export interface CockpitDeps {
  extensionUri: vscode.Uri;
  collect: () => Promise<CockpitWorkspaceBundle[]>;
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
  runtimeOps: CockpitRuntimeOps;
  inspector: CockpitInspector;
  plugins: PluginsPanelManager;
  openSettings: () => void;
  openDoctor: () => void;
  /** Fleet lifecycle + surface openers (wsHash optional for single-root). */
  fleetStart: (name: string, wsHash?: string) => Promise<void>;
  fleetStop: (name: string, wsHash?: string) => Promise<void>;
  fleetTerminal: (name: string, wsHash?: string) => Promise<void>;
  revealPath: (fsPath: string) => void;
  openConfigFile: (wsHash?: string) => Promise<void>;
  clearEngineLog: (wsHash: string) => Promise<void>;
  openEngineJournal: (wsHash: string) => void;
  /** SDD 414 — settings.companion.tabTools for one workspace engine. */
  setCompanionTabTools: (wsHash: string, enabled: boolean) => Promise<void>;
  /** SDD 420 — settings.companion.allowedHosts for one workspace engine. */
  setCompanionAllowedHosts: (wsHash: string, hosts: string[]) => Promise<void>;
  /** SDD 414 — host-authoritative unpair of the active Companion device. */
  unpairCompanionDevice: (wsHash: string) => Promise<void>;
  /**
   * SDD 414 — mint short-lived pair code + baseUrl (same as tachyon.pairCompanion / companion.pair-code).
   * Result is pushed as a one-shot webview message — not polled into CockpitModel.
   */
  issueCompanionPairCode: (wsHash: string) => Promise<{
    ok: true;
    code: string;
    baseUrl: string;
    expiresAt: string;
    protocolVersion?: number;
    prefix?: string;
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
    navApprovals: t("Approvals"),
    navMission: t("Board"),
    navValidations: t("Validations"),
    navHandoff: t("Handoff"),
    navWorktrees: t("Worktrees"),
    navDeliveries: t("Deliveries"),
    navRuntime: t("Runtime"),
    navTmux: t("tmux"),
    navPlugins: t("Plugins"),
    navSettings: t("Settings"),
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
    handoffTitle: t("Project Handoff"),
    handoffHint: t("Shared, curated project state — the doc a fresh agent reads first (embedded)."),
    worktreesTitle: t("Managed worktrees"),
    worktreesHint: t("Tachyon-managed checkouts — reveal and copy paths."),
    deliveriesTitle: t("Deliveries"),
    deliveriesHint: t("Local GitDelivery records — phase, branch, worktree."),
    runtimeTitle: t("Runtime Ops"),
    runtimeHint: t("Usage and rate limits (embedded)."),
    tmuxTitle: t("tmux"),
    tmuxHint: t("Server inspector (embedded)."),
    pluginsTitle: t("Plugins"),
    pluginsHint: t("Install, update, and integrity (embedded)."),
    settingsTitle: t("Settings"),
    settingsHint: t("Tachyon settings and workspace config."),
    workspaces: t("Workspaces"),
    engines: t("Engines"),
    agents: t("Agents"),
    errors: t("Errors"),
    bridges: t("Bridges"),
    approvals: t("Approvals"),
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
    reveal: t("Reveal"),
    copyPath: t("Copy path"),
    copyId: t("Copy id"),
    openConfig: t("Open tachyon.yml"),
    settingsBody: t(
      "Tachyon product settings live in the VS Code Settings UI. Workspace agents and schedules are declared in tachyon.yml at the workspace root.",
    ),
    settingsOpenTachyon: t("Open Tachyon settings"),
    settingsOpenConfig: t("Open tachyon.yml"),
    settingsDoctor: t("Run Doctor"),
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
    companionAllowedHostsSave: t("Save allowed hosts"),
    companionPaired: t("Paired"),
    companionNotPaired: t("Not paired"),
    companionPickWorkspace: t("Select a single workspace in the header to manage Companion settings."),
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
    devicesTitle: t("Connected devices"),
    devicesHint: t("Companion browsers paired to this workspace engine."),
    devicesEmpty: t("No Companion device paired. Generate a pair code above, enter it in Tachyon Companion, then refresh."),
    devicesUnpair: t("Unpair"),
    devicesLive: t("Live"),
    devicesOffline: t("Offline"),
    devicesKindBrowser: t("Browser"),
    devicesKindMobile: t("Mobile"),
    devicesPairedAt: t("Paired"),
    declared: t("declared"),
    adhoc: t("ad-hoc"),
    agent: t("agent"),
    change: t("change"),
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
 * t-610705 (Phase C.0) — bumped on every route change AND every workspace-scope change (both are
 * "the world changed" events). Async send*() functions capture this at the start and re-check it
 * after their awaits; a mismatch means a newer navigation/scope-switch has superseded this call,
 * so its result must be discarded rather than posted (closes the router design dueto's "out-of-
 * order module pushes can render data for the wrong route" finding). Replaces the old
 * mission-only `missionGeneration` counter with one mechanism shared by every section.
 */
let navEpoch = 0;

function navigate(route: CockpitRoute): void {
  reconcileActivityTeardown(route);
  reconcileStudioTeardown(route);
  currentRoute = route;
  navEpoch += 1;
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
let pushHandoff: (() => void) | undefined;
let pushTaskDetail: (() => void) | undefined;
let pushProbes: (() => void) | undefined;
let pushStudioReferenceData: (() => void) | undefined;
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
}

export function refreshCockpitValidations(): void {
  pushValidations?.();
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
    handoff: s.navHandoff,
    approvals: s.navApprovals,
    plugins: s.navPlugins,
    runtime: s.navRuntime,
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
    panel = opts?.revivedPanel ?? vscode.window.createWebviewPanel(COCKPIT_VIEW_TYPE, s.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      enableFindWidget: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, "dist", "webview")],
    });
    panel.title = s.title;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, "dist", "webview")],
    };
    panel.iconPath = panelIcon(deps.extensionUri, "pulse");
    markCockpitSingletonClaimed();
    panel.onDidDispose(() => {
      if (panel) {
        panel = undefined;
        clearCockpitSingletonClaim();
        pushMissionBoard = undefined;
        pushApprovals = undefined;
        pushValidations = undefined;
        pushHandoff = undefined;
        pushTaskDetail = undefined;
        pushProbes = undefined;
        pushStudioReferenceData = undefined;
        doOpenActivityTranscript = undefined;
        wiredPanel = undefined;
        navEpoch += 1;
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

  const sendModel = async () => {
    const epoch = navEpoch;
    let model: CockpitModel;
    try {
      const bundles = await deps.collect();
      model = buildCockpitModel(bundles, { section: navSection(currentRoute), wsHash: controlWsHash });
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
        { section: navSection(currentRoute), wsHash: controlWsHash },
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
      if (b) model.studioMountNonce = b.mountNonce;
    }
    if (panel === live && navEpoch === epoch) {
      live.webview.postMessage(modelMessage(model));
      live.title = sectionTitle(s, navSection(currentRoute));
    }
  };

  const sendMission = async () => {
    if (panel !== live || !isSection(currentRoute, "mission")) return;
    const epoch = navEpoch;
    const all = deps.missionBoard.getWorkspaces();
    const ws = resolveMissionWs(deps.missionBoard);
    if (!ws) {
      live.webview.postMessage(taskErrorMessage("No Tachyon workspace for Mission board."));
      return;
    }
    try {
      // Trailing retry: a list that settles late (after its 250ms fallback already rendered, with
      // further refreshes coalesced behind it) re-posts once so real liveness replaces "unavailable".
      const vm = await buildMissionVm(ws, all, missionAgentLists, () => void sendMission());
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

  // t-610705 (Phase C.3) — ported verbatim from the retired HandoffPanelManager's post(): a load
  // failure notifies (a toast), it does NOT post a distinct error VM — the client keeps whatever it
  // last had (or the loading state if nothing yet). Handoff's own VM already models "no file yet"
  // via `exists: false`, which isn't a failure case at all.
  const sendHandoff = async () => {
    if (panel !== live || !isSection(currentRoute, "handoff")) return;
    const epoch = navEpoch;
    const ws = resolveHandoffWs(deps.handoff);
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
    // "ready"/"refresh" are NOT handled here — they're the same wire strings as the shell's own
    // handshake/poll (case READY/"refresh" in the main switch below), which already calls
    // sendSectionModule() → sendHandoff() for the active section. Only Handoff's OWN action types
    // need a dedicated handler.
    if (!m?.type || !isSection(currentRoute, "handoff")) return false;
    if (m.type === "openFile") {
      const ws = resolveHandoffWs(deps.handoff);
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
      const ws = resolveHandoffWs(deps.handoff);
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
    // dogfood round 1 (#5, spec 339, ported from TaskDetailPanel.ts) — the blob root must be an
    // allowed local resource root before asWebviewUri() below can resolve `attachment:<id>` refs.
    // Least-privilege: only the CURRENT task's root is allowed (Control is single-instance, so a
    // prior task's images simply stop resolving once navigated away — nothing still displays them).
    live.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(deps.extensionUri, "dist", "webview"),
        vscode.Uri.file(ws.attachmentBlobRoot(route.taskId)),
      ],
    };
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
    if (m.type === READY || m.type === "requestSnapshot") {
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

  const shareActivityExternal = async (agent: string, sequence: unknown, key: unknown): Promise<void> => {
    const payload = resolveActivityShareOrNotify(agent, sequence, key);
    if (!payload) return;
    const picked = await vscode.window.showQuickPick([
      { label: "Email", id: "email" as const, description: "Open a mail draft" },
      { label: "WhatsApp", id: "whatsapp" as const, description: "Open WhatsApp Web" },
    ], { placeHolder: "Share Activity item" });
    if (!picked) return;
    const preview = payload.text.length > 1400 ? `${payload.text.slice(0, 1400).trimEnd()}\n\n[preview truncated]` : payload.text;
    const ok = await showNotification(`Share this Activity item via ${picked.label}?`, "info", ["Open"], { modal: true, detail: preview });
    if (ok !== "Open") return;
    if (picked.id === "email") {
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
      description: target.declared ? "declared agent" : "ad-hoc agent",
    }));
  };

  const shareActivityToAgent = async (wsHash: string, sourceAgent: string, sequence: unknown, key: unknown): Promise<void> => {
    const payload = resolveActivityShareOrNotify(sourceAgent, sequence, key);
    if (!payload) return;
    const ws = resolveActivityWs(wsHash);
    if (!ws) return;
    // t-610705 (Phase C.2, hardening dueto probe-2d90286d MAJOR) — this flow spans a QuickPick + a
    // modal confirm, both genuinely user-paced; capture the binding generation now and recheck
    // before the actual side effect (ws.sendAgentInput) so navigating away mid-flow silently
    // abandons the paste instead of sending it into whatever agent/workspace is now on screen.
    const myGeneration = activityBinding?.generation;
    const targets = await runningActivityAgentTargets(ws, sourceAgent);
    if (targets.length === 0) {
      notify("No other running Tachyon agent is available for this Activity share.");
      return;
    }
    const picked = await vscode.window.showQuickPick(targets.map((t) => ({ label: t.name, description: t.description })), { placeHolder: "Send Activity item to agent" });
    if (!picked) return;
    if (activityBinding?.generation !== myGeneration) return;
    const stillLive = (await runningActivityAgentTargets(ws, sourceAgent)).some((t) => t.name === picked.label);
    if (!stillLive) {
      notify(`Agent '${picked.label}' is no longer available.`, "warn");
      return;
    }
    const prompt = internalSharePrompt(payload);
    const preview = prompt.length > 1400 ? `${prompt.slice(0, 1400).trimEnd()}\n\n[preview truncated]` : prompt;
    const ok = await showNotification(`Paste Activity context into '${picked.label}'?`, "info", ["Paste"], { modal: true, detail: preview });
    if (ok !== "Paste") return;
    if (activityBinding?.generation !== myGeneration) return;
    await ws.sendAgentInput(picked.label, prompt, false);
    notify(`Activity context pasted into '${picked.label}' (not submitted).`);
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
      void shareActivityExternal(route.agent, m.sequence, m.key);
      return true;
    }
    if (m.type === SHARE_TO_AGENT) {
      void shareActivityToAgent(route.wsHash, route.agent, m.sequence, m.key);
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
    bindPluginsIfNeeded();
    if (isSection(currentRoute, "mission")) await sendMission();
    else if (isSection(currentRoute, "validations")) await sendValidations();
    else if (isSection(currentRoute, "handoff")) await sendHandoff();
    else if (isSection(currentRoute, "approvals")) await sendApprovals();
    else if (isSection(currentRoute, "runtime")) await sendRuntime();
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
  };

  pushMissionBoard = () => { void sendMission(); };
  pushApprovals = () => { void sendApprovals(); };
  pushValidations = () => { void sendValidations(); };
  pushHandoff = () => { void sendHandoff(); };
  pushTaskDetail = () => { void sendTaskDetail(); };
  pushProbes = () => { void sendProbes(); };
  // t-610705 (Phase D, D1a) — no "sendX" wrapper needed: refreshStudioReferenceData already takes
  // the io capability directly (same studioIo the studio-envelope dispatch above uses), and is a
  // no-op with no binding — the isStudioRoute guard here just avoids the pointless call off-route.
  pushStudioReferenceData = () => { if (isStudioRoute(currentRoute)) void refreshStudioReferenceData(studioIo); };
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
    if (m.type === "switchWorkspace" && typeof m.wsHash === "string") {
      controlWsHash = m.wsHash;
      await sendMission();
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

      // t-610705 (Phase C.1) — MUST run before handleMissionAction: TaskDetailAction's "openTask"
      // is the same {type,id} shape as MissionControlAction's, and would otherwise be misrouted to
      // the Board's handler (wrong workspace resolution — task-detail pins its own wsHash, not the
      // shell scope). handleTaskDetailAction itself no-ops (returns false) off a task-detail route.
      if (await handleTaskDetailAction(msg as Partial<TaskDetailAction>)) return;
      if (await handleMissionAction(msg as Partial<MissionControlAction>)) return;
      if (await handleApprovalAction(msg as Partial<ApprovalAction>)) return;
      if (await handleValidationsAction(msg as Partial<ValidationsAction>)) return;
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
        case READY:
          live.webview.postMessage(initMessage(s));
          await sendModel();
          await sendSectionModule();
          // t-610705 (Phase C.2) — a (re)loaded cockpit webview's client-side image cache is empty;
          // ensureActivityBinding() above is a no-op when the binding already exists (the shared 3s
          // poll must never touch it — see route.ts's refreshPolicy doc), so THIS is the one place
          // that explicitly recovers a still-live feed's images after a reload.
          if (currentRoute.kind === "agent-activity") activityBinding?.feed.replayImages();
          return;
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
            const bundles = await deps.collect();
            const text = formatCockpitDiagnostics(buildCockpitModel(bundles, { section: navSection(currentRoute) }));
            await vscode.env.clipboard.writeText(text);
            live.webview.postMessage(toastMessage(s.copied));
          } catch (err) {
            live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err)));
          }
          return;
        }
        case "openSettings":
          deps.openSettings();
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
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err)));
            }
          }
          return;
        case "fleetStop":
          if (typeof c.name === "string") {
            try {
              await deps.fleetStop(c.name, typeof c.wsHash === "string" ? c.wsHash : undefined);
              await sendModel();
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err)));
            }
          }
          return;
        case "fleetTerminal":
          if (typeof c.name === "string") {
            try {
              await deps.fleetTerminal(c.name, typeof c.wsHash === "string" ? c.wsHash : undefined);
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err)));
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
        case "revealPath":
          if (typeof c.path === "string" && c.path) deps.revealPath(c.path);
          return;
        case "copyText":
          if (typeof c.text === "string") {
            await vscode.env.clipboard.writeText(c.text);
            live.webview.postMessage(toastMessage(s.copied));
          }
          return;
        case "openConfigFile":
          try {
            await deps.openConfigFile(typeof c.wsHash === "string" ? c.wsHash : undefined);
          } catch (err) {
            live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err)));
          }
          return;
        case "engineLogClear":
          if (typeof c.wsHash === "string" && c.wsHash) {
            try {
              await deps.clearEngineLog(c.wsHash);
              await sendModel();
              live.webview.postMessage(toastMessage("Log cleared"));
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err)));
            }
          }
          return;
        case "engineLogJournal":
          if (typeof c.wsHash === "string" && c.wsHash) {
            try {
              deps.openEngineJournal(c.wsHash);
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err)));
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
                ),
              );
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err)));
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
                ),
              );
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err)));
            }
          }
          return;
        case "unpairCompanionDevice":
          if (typeof c.wsHash === "string" && c.wsHash) {
            try {
              await deps.unpairCompanionDevice(c.wsHash);
              await sendModel();
              live.webview.postMessage(toastMessage(vscode.l10n.t("Companion device unpaired")));
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err)));
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
                  toastMessage(vscode.l10n.t("Companion pair code ready (expires soon)")),
                );
              }
            } catch (err) {
              live.webview.postMessage({
                type: "companionPairOffer",
                offer: { ok: false, reason: err instanceof Error ? err.message : String(err) },
              });
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err)));
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
    const runtimeIsActive = isSection(currentRoute, "runtime");
    const validationsIsActive = isSection(currentRoute, "validations");
    const pluginsIsActive = isSection(currentRoute, "plugins");
    const tmuxIsActive = isSection(currentRoute, "tmux");
    const missionIsActive = isSection(currentRoute, "mission");
    const taskDetailIsActive = currentRoute.kind === "task-detail";
    const activityIsActive = currentRoute.kind === "agent-activity";
    const probesIsActive = currentRoute.kind === "agent-probes" || currentRoute.kind === "workspace-probes";
    const handoffIsActive = isSection(currentRoute, "handoff");
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
    // t-610705 (Phase C.2) — ported from the retired standalone ActivityPanel.ts: mermaid/katex load
    // ON DEMAND client-side (activity/markdown.tsx), gated on these globals being present at all —
    // never previously wired into Cockpit.ts's shell (Task Detail's C.1 migration also uses
    // MarkdownView but never needed these either; unrelated pre-existing gap, out of scope here).
    // Static bundle URIs are harmless to include even on a route that never triggers them.
    // ?? "auto" (not just the getConfiguration default param) — test/mocks/vscode.ts's naive
    // getConfiguration().get() always returns undefined, ignoring the default entirely; without this
    // fallback, __codeThemeForced below serializes to JSON `undefined` (not the string "undefined"),
    // and jsonInline's JSON.stringify(...).replace(...) throws on every openCockpit() call in tests.
    const codeTheme = vscode.workspace.getConfiguration("tachyon").get<string>("activity.codeTheme", "auto") ?? "auto";
    const activityThemeClass = codeTheme === "dark" ? "tac-theme-dark" : codeTheme === "light" ? "tac-theme-light" : "";
    live.webview.html = renderWebviewShell({
      cspSource: live.webview.cspSource,
      title: s.title,
      bodyClass: activityThemeClass || undefined,
      // t-610705 (Phase C.1) — task-detail needs frame-src 'self' for PrototypePreview's sandboxed
      // srcdoc iframe (the standalone TaskDetailPanel.ts set this too); purely additive to the CSP,
      // no effect on any other already-embedded section.
      frameSrc: "self",
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
        studioIsActive ? uri("studio-frame.css") : undefined,
        commandStudioIsActive ? uri("command-studio-shell.css") : undefined,
        terminalStudioIsActive ? uri("terminal-studio-shell.css") : undefined,
        runbookStudioIsActive ? uri("runbook-studio-shell.css") : undefined,
        scheduleStudioIsActive ? uri("schedule-studio-shell.css") : undefined,
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
        __tachyonSectionStyles: {
          approvals: uri("approval.css"),
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
        },
        __mermaidSrc: uri("mermaid.js"),
        __katexSrc: uri("katex.js"),
        __katexCssUri: uri("katex.min.css"),
        __codeThemeForced: codeTheme,
      },
    });
  } else {
    await sendModel();
    await sendSectionModule();
  }
}
