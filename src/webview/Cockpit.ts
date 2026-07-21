import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import { renderWebviewShell } from "./shared/shell.js";
import { resolveCockpitSection } from "../cockpit/resolveSection.js";
import {
  routes,
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
import type { WorkspacePresentationTarget } from "../shell/WorkspacePresentation.js";
import {
  snapshotMessage,
  taskErrorMessage,
  type MissionControlAction,
} from "./mission-control/messages.js";
import { buildMissionVm, MissionAgentLists } from "../cockpit/missionVm.js";
import { buildTaskDetailVm, emptyTombstoneVm } from "../cockpit/taskDetailVm.js";
import { taskMessage, taskDetailErrorMessage, type TaskDetailAction } from "./task-detail/messages.js";
import type { WorkspaceTaskDetailTarget } from "../shell/TaskDetailTarget.js";
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
import { showNotification } from "../workspace/NotificationService.js";
import type { PluginsPanelManager } from "./PluginsPanel.js";

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

/** t-610705 (Phase C.1) — Task Detail's own read/mutate surface (WorkspaceTaskDetailTarget already
 *  carries loadTaskDetail/updateTask/reviewPrototype/attachment resolution — no separate VM-building
 *  interface needed, unlike CockpitMissionBoard's thinner wrapper). */
export interface CockpitTaskDetail {
  getWorkspaces: () => WorkspaceTaskDetailTarget[];
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
  fleetActivity: (name: string, wsHash?: string) => void;
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
  currentRoute = route;
  navEpoch += 1;
}

/** t-d16a39 — the ONE shell-level workspace scope. undefined = "All workspaces" (aggregate
 *  sections aggregate; per-workspace sections fall back to the first workspace). Replaces the
 *  former per-section missionWsHash/approvalWsHash pair and Plugins' derived fallback. */
let controlWsHash: string | undefined;
let pushMissionBoard: (() => void) | undefined;
let pushApprovals: (() => void) | undefined;
let pushValidations: (() => void) | undefined;
let pushTaskDetail: (() => void) | undefined;
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

/** Refresh embedded Approvals after resolve/fan-out. */
export function refreshCockpitApprovals(): void {
  pushApprovals?.();
}

export function refreshCockpitValidations(): void {
  pushValidations?.();
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

function sectionTitle(s: CockpitStrings, section: CockpitSectionId): string {
  const map: Partial<Record<CockpitSectionId, string>> = {
    mission: s.navMission,
    validations: s.navValidations,
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
  if (opts?.route) navigate(opts.route);
  else if (opts?.section) navigate(routes.section(resolveCockpitSection(opts.section)));
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
        pushTaskDetail = undefined;
        wiredPanel = undefined;
        navEpoch += 1;
        missionAgentLists.clear();
        deps.plugins.unbindControlEmbed();
      }
    });
  }
  const live = panel;

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
      // instance trade-off applies here too).
      navigate(routes.taskDetail(route.wsHash, m.id));
      lastKnownTaskDetail = undefined;
      await sendModel();
      await sendSectionModule();
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

  const sendSectionModule = async () => {
    bindPluginsIfNeeded();
    if (isSection(currentRoute, "mission")) await sendMission();
    else if (isSection(currentRoute, "validations")) await sendValidations();
    else if (isSection(currentRoute, "approvals")) await sendApprovals();
    else if (isSection(currentRoute, "runtime")) await sendRuntime();
    else if (isSection(currentRoute, "tmux")) await sendInspector();
    else if (isSection(currentRoute, "plugins")) deps.plugins.refreshControlEmbed();
    else if (currentRoute.kind === "task-detail") await sendTaskDetail();
  };

  pushMissionBoard = () => { void sendMission(); };
  pushApprovals = () => { void sendApprovals(); };
  pushValidations = () => { void sendValidations(); };
  pushTaskDetail = () => { void sendTaskDetail(); };

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
        navigate(routes.taskDetail(ws.wsHash, m.id));
        lastKnownTaskDetail = undefined;
        await sendModel();
        await sendSectionModule();
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
        case READY:
          live.webview.postMessage(initMessage(s));
          await sendModel();
          await sendSectionModule();
          return;
        case "refresh":
          await sendModel();
          await sendSectionModule();
          return;
        case "setSection":
          // t-610705 (Phase C.0) — sugar over navigate(); C.1+ adds a "navigate" message carrying
          // real subroute params once there's a subroute to send. Bumps navEpoch, so any in-flight
          // send*() from the section being left discards its result instead of posting it late.
          navigate(routes.section(resolveCockpitSection(c.section)));
          await sendModel();
          await sendSectionModule();
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
          if (typeof c.name === "string") {
            deps.fleetActivity(c.name, typeof c.wsHash === "string" ? c.wsHash : undefined);
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
    live.webview.html = renderWebviewShell({
      cspSource: live.webview.cspSource,
      title: s.title,
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
        taskDetailIsActive ? uri("mermaid-block.css") : undefined,
        taskDetailIsActive ? uri("task-detail.css") : undefined,
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
        },
      },
    });
  } else {
    await sendModel();
    await sendSectionModule();
  }
}
