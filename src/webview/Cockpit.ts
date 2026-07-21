import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import { renderWebviewShell } from "./shared/shell.js";
import { resolveCockpitSection } from "../cockpit/resolveSection.js";
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

export interface CockpitPanelState {
  schemaVersion: 1;
  view: typeof COCKPIT_VIEW_TYPE;
  section?: CockpitSectionId;
  /** t-d16a39 — the shell-level workspace scope at open time; absent = All workspaces. */
  wsHash?: string;
}

/** Board wiring for Mission tab embed (same targets as MissionControlPanelManager). */
export interface CockpitMissionBoard {
  getWorkspaces: () => WorkspaceMissionControlTarget[];
  openTaskDetail: (ws: WorkspaceMissionControlTarget, id: string) => void;
  openTaskStudio: (ws: WorkspaceMissionControlTarget, id?: string) => void;
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
let currentSection: CockpitSectionId = "overview";
/** t-d16a39 — the ONE shell-level workspace scope. undefined = "All workspaces" (aggregate
 *  sections aggregate; per-workspace sections fall back to the first workspace). Replaces the
 *  former per-section missionWsHash/approvalWsHash pair and Plugins' derived fallback. */
let controlWsHash: string | undefined;
let pushMissionBoard: (() => void) | undefined;
let pushApprovals: (() => void) | undefined;
let pushValidations: (() => void) | undefined;
let wiredPanel: vscode.WebviewPanel | undefined;

/** Refresh embedded Mission board after task mutations. */
export function refreshCockpitMissionBoard(): void {
  pushMissionBoard?.();
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
// never-block guarantee). One shared instance for the singleton panel; generation guards staleness.
const missionAgentLists = new MissionAgentLists();
let missionGeneration = 0;

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
  opts?: { section?: CockpitSectionId; revivedPanel?: vscode.WebviewPanel; wsHash?: string; missionWsHash?: string; approvalWsHash?: string },
): Promise<void> {
  const s = strings();
  const inspS = inspectorStrings();
  if (opts?.section) currentSection = resolveCockpitSection(opts.section);
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
    panel.onDidDispose(() => {
      if (panel) {
        panel = undefined;
        pushMissionBoard = undefined;
        pushApprovals = undefined;
        pushValidations = undefined;
        wiredPanel = undefined;
        missionGeneration += 1;
        missionAgentLists.clear();
        deps.plugins.unbindControlEmbed();
      }
    });
  }
  const live = panel;

  const sendModel = async () => {
    let model: CockpitModel;
    try {
      const bundles = await deps.collect();
      model = buildCockpitModel(bundles, { section: currentSection, wsHash: controlWsHash });
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
        { section: currentSection, wsHash: controlWsHash },
      );
    }
    if (panel === live) {
      live.webview.postMessage(modelMessage(model));
      live.title = sectionTitle(s, currentSection);
    }
  };

  const sendMission = async () => {
    if (panel !== live || currentSection !== "mission") return;
    const all = deps.missionBoard.getWorkspaces();
    const ws = resolveMissionWs(deps.missionBoard);
    if (!ws) {
      live.webview.postMessage(taskErrorMessage("No Tachyon workspace for Mission board."));
      return;
    }
    const generation = ++missionGeneration;
    try {
      // Trailing retry: a list that settles late (after its 250ms fallback already rendered, with
      // further refreshes coalesced behind it) re-posts once so real liveness replaces "unavailable".
      const vm = await buildMissionVm(ws, all, missionAgentLists, () => void sendMission());
      if (panel !== live || currentSection !== "mission" || missionGeneration !== generation) return;
      live.webview.postMessage(snapshotMessage(vm));
    } catch (err) {
      if (panel !== live || missionGeneration !== generation) return;
      live.webview.postMessage(taskErrorMessage(err instanceof Error ? err.message : String(err)));
    }
  };

  const sendApprovals = async () => {
    if (panel !== live || currentSection !== "approvals") return;
    const ws = resolveApprovalWs(deps.approvals);
    if (!ws) {
      live.webview.postMessage(approvalErrorMessage("No Tachyon workspace for Approvals."));
      return;
    }
    try {
      const vm = buildApprovalViewModel({ workspaceRoot: ws.workspaceRoot, folder: ws.folderName, wsHash: ws.wsHash });
      if (panel !== live || currentSection !== "approvals") return;
      live.webview.postMessage(approvalsMessage(vm));
    } catch (err) {
      if (panel !== live) return;
      live.webview.postMessage(approvalErrorMessage(err instanceof Error ? err.message : String(err)));
    }
  };

  const sendValidations = async () => {
    if (panel !== live || currentSection !== "validations") return;
    const ws = resolveMissionWs({ ...deps.missionBoard, getWorkspaces: deps.validations.getWorkspaces });
    if (!ws) {
      live.webview.postMessage(validationErrorMessage("No Tachyon workspace for Validations."));
      return;
    }
    try {
      const vm = buildValidationsViewModel({ folder: ws.folderName, wsHash: ws.wsHash, validations: ws.listValidations() });
      if (panel !== live || currentSection !== "validations") return;
      live.webview.postMessage(validationsMessage(vm));
    } catch (err) {
      if (panel !== live) return;
      live.webview.postMessage(validationErrorMessage(err instanceof Error ? err.message : String(err)));
    }
  };

  const sendRuntime = async () => {
    if (panel !== live || currentSection !== "runtime") return;
    try {
      const snap = await deps.runtimeOps.buildSnapshot();
      if (panel !== live || currentSection !== "runtime") return;
      live.webview.postMessage(runtimeOpsSnapshotMessage(snap));
    } catch {
      if (panel !== live) return;
      live.webview.postMessage(runtimeOpsSnapshotUnavailableMessage());
    }
  };

  const sendInspector = async () => {
    if (panel !== live || currentSection !== "tmux") return;
    let model: InspectorModel;
    try {
      const [snap, server] = await Promise.all([deps.inspector.snapshot(), deps.inspector.serverHealth()]);
      const busy = deps.inspector.cpuBusy(snap);
      model = buildInspectorModel(snap, deps.inspector.folderByHash(), busy, server);
    } catch {
      model = { groups: [], totalSessions: 0, liveSessions: 0, deadSessions: 0, orphanSessions: 0, busySessions: 0 };
    }
    if (panel !== live || currentSection !== "tmux") return;
    // Namespaced to avoid colliding with Control's own `init`/`model` messages.
    live.webview.postMessage({ type: "inspectorInit", strings: inspS });
    live.webview.postMessage({ type: "inspectorModel", model });
  };

  const bindPluginsIfNeeded = () => {
    if (currentSection === "plugins") {
      deps.plugins.bindControlEmbed(live.webview, controlWsHash);
    } else {
      deps.plugins.unbindControlEmbed();
    }
  };

  const sendSectionModule = async () => {
    bindPluginsIfNeeded();
    if (currentSection === "mission") await sendMission();
    else if (currentSection === "validations") await sendValidations();
    else if (currentSection === "approvals") await sendApprovals();
    else if (currentSection === "runtime") await sendRuntime();
    else if (currentSection === "tmux") await sendInspector();
    else if (currentSection === "plugins") deps.plugins.refreshControlEmbed();
  };

  pushMissionBoard = () => { void sendMission(); };
  pushApprovals = () => { void sendApprovals(); };
  pushValidations = () => { void sendValidations(); };

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
      const ws = resolveMissionWs(deps.missionBoard);
      if (ws) deps.missionBoard.openTaskDetail(ws, m.id);
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
    if (currentSection !== "tmux") return false;
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
      if (PLUGIN_ACTION_TYPES.has(type) && currentSection === "plugins") {
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
          currentSection = resolveCockpitSection(c.section);
          await sendModel();
          await sendSectionModule();
          return;
        case "switchControlWorkspace":
          // t-d16a39 — "" = All workspaces. Re-send model (aggregate sections re-scope) AND the
          // active section's module (per-workspace sections re-resolve; plugins embed re-binds).
          controlWsHash = c.wsHash || undefined;
          await sendModel();
          await sendSectionModule();
          return;
        case "copyDiagnostics": {
          try {
            const bundles = await deps.collect();
            const text = formatCockpitDiagnostics(buildCockpitModel(bundles, { section: currentSection }));
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
    const approvalsIsActive = currentSection === "approvals";
    const runtimeIsActive = currentSection === "runtime";
    const validationsIsActive = currentSection === "validations";
    const pluginsIsActive = currentSection === "plugins";
    const tmuxIsActive = currentSection === "tmux";
    const missionIsActive = currentSection === "mission";
    live.webview.html = renderWebviewShell({
      cspSource: live.webview.cspSource,
      title: s.title,
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
        uri("cockpit.css"),
      ].filter((href): href is string => href !== undefined),
      bundle: uri("cockpit.js"),
      module: true,
      mode: "live",
      persistedState: {
        schemaVersion: 1,
        view: COCKPIT_VIEW_TYPE,
        section: currentSection,
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
        },
      },
    });
  } else {
    await sendModel();
    await sendSectionModule();
  }
}
