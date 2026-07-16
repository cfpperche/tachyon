import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import { renderWebviewShell } from "./shared/shell.js";
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
import {
  snapshotMessage,
  taskErrorMessage,
  type MissionControlAction,
  type MissionControlVM,
} from "./mission-control/messages.js";

export const COCKPIT_VIEW_TYPE = "tachyonCockpit";

export interface CockpitPanelState {
  schemaVersion: 1;
  view: typeof COCKPIT_VIEW_TYPE;
  section?: CockpitSectionId;
}

/** Board wiring for Mission tab embed (same targets as MissionControlPanelManager). */
export interface CockpitMissionBoard {
  getWorkspaces: () => WorkspaceMissionControlTarget[];
  openTaskDetail: (ws: WorkspaceMissionControlTarget, id: string) => void;
  openTaskStudio: (ws: WorkspaceMissionControlTarget, id?: string) => void;
  /** Fan-out after board mutations (sidebar + detail + studio + any legacy MC panels). */
  onTasksChanged: () => void;
}

/**
 * Tachyon Control — editor-area visual hub (project sysadmin + embedded modules).
 * Top tabs only (no webview left rail). Does not replace VS Code/Tachyon sidebar.
 * POC: Mission tab hosts the full Mission Control board (same Preact App + engine path).
 */
export interface CockpitDeps {
  extensionUri: vscode.Uri;
  collect: () => Promise<CockpitWorkspaceBundle[]>;
  missionBoard: CockpitMissionBoard;
  openServerInspector: () => void;
  openPlugins: () => void;
  openSettings: () => void;
  openApprovals: () => void;
  openRuntimeOps: () => void;
  openDoctor: () => void;
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
    navMission: t("Mission"),
    navWorktrees: t("Worktrees"),
    navDeliveries: t("Deliveries"),
    navRuntime: t("Runtime"),
    navTmux: t("tmux"),
    navPlugins: t("Plugins"),
    navSchedules: t("Schedules"),
    navSettings: t("Settings"),
    refresh: t("Refresh"),
    auto: t("Auto-refresh"),
    empty: t("No Tachyon workspace attached in this window."),
    copyDiagnostics: t("Copy diagnostics"),
    openServerInspector: t("Open tmux Inspector"),
    openMissionControl: t("Mission board"),
    openPlugins: t("Open Plugins"),
    openSettings: t("Open Settings"),
    openApprovals: t("Open Approvals"),
    openRuntimeOps: t("Open Runtime Ops"),
    openDoctor: t("Run Doctor"),
    copied: t("Diagnostics copied"),
    overviewTitle: t("Overview"),
    overviewHint: t("Health snapshot and shortcuts across this workspace."),
    engineTitle: t("Engine / Bridge"),
    fleetTitle: t("Fleet"),
    fleetHint: t("Agents from the live presentation."),
    approvalsTitle: t("Approvals"),
    approvalsHint: t("Human gates that block the fleet. Open Approvals to resolve."),
    missionTitle: t("Mission Control"),
    missionHint: t("Full work board (embedded). Same board as before — opened via Control."),
    worktreesTitle: t("Managed worktrees"),
    worktreesHint: t("Tachyon-managed checkouts registered for this workspace."),
    deliveriesTitle: t("Deliveries"),
    deliveriesHint: t("Local GitDelivery records."),
    runtimeTitle: t("Runtime Ops"),
    runtimeHint: t("Usage and rate limits. Open Runtime Ops for full detail."),
    tmuxTitle: t("tmux"),
    tmuxHint: t("Socket health. Open the tmux Inspector for sessions and reap."),
    pluginsTitle: t("Plugins"),
    pluginsHint: t("Open Plugins to install or update."),
    schedulesTitle: t("Schedules"),
    schedulesHint: t("Declared schedules for this workspace."),
    settingsTitle: t("Settings"),
    settingsHint: t("Open Tachyon settings."),
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
  };
}

let panel: vscode.WebviewPanel | undefined;
let currentSection: CockpitSectionId = "overview";
let missionWsHash: string | undefined;
/** Active mission board push — called from onTasksChanged fan-out. */
let pushMissionBoard: (() => void) | undefined;
let wiredPanel: vscode.WebviewPanel | undefined;

/** Refresh embedded Mission board after task mutations (safe no-op if Control closed / not on Mission). */
export function refreshCockpitMissionBoard(): void {
  pushMissionBoard?.();
}

async function buildMissionVm(
  ws: WorkspaceMissionControlTarget,
  all: WorkspaceMissionControlTarget[],
): Promise<MissionControlVM> {
  const declared = new Set(ws.declaredAgentNames());
  let agents: Awaited<ReturnType<WorkspaceMissionControlTarget["listMissionControlAgents"]>> = [];
  let agentLiveness: NonNullable<MissionControlVM["agentLiveness"]> = { status: "available" };
  try {
    agents = await ws.listMissionControlAgents();
  } catch {
    agentLiveness = { status: "unavailable" };
  }
  const liveManaged = agents.filter((a) => a.kind === "agent" && a.running);
  const liveAdhoc = liveManaged
    .filter((a) => !a.declared && !declared.has(a.name))
    .map((a) => a.name);
  return {
    folder: ws.folderName,
    wsHash: ws.wsHash,
    workspaces: all.map((w) => ({ hash: w.wsHash, folder: w.folderName })),
    agentLiveness,
    snapshot: await ws.boardSnapshot(liveAdhoc),
  };
}

function resolveMissionWs(board: CockpitMissionBoard, prefer?: string): WorkspaceMissionControlTarget | undefined {
  const all = board.getWorkspaces();
  if (all.length === 0) return undefined;
  if (prefer) {
    const hit = all.find((w) => w.wsHash === prefer);
    if (hit) return hit;
  }
  if (missionWsHash) {
    const hit = all.find((w) => w.wsHash === missionWsHash);
    if (hit) return hit;
  }
  return all[0];
}

export async function openCockpit(
  deps: CockpitDeps,
  opts?: { section?: CockpitSectionId; revivedPanel?: vscode.WebviewPanel; missionWsHash?: string },
): Promise<void> {
  const s = strings();
  if (opts?.section) currentSection = opts.section;
  if (opts?.missionWsHash) missionWsHash = opts.missionWsHash;

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
        wiredPanel = undefined;
      }
    });
  }
  const live = panel;

  const sendModel = async () => {
    let model: CockpitModel;
    try {
      const bundles = await deps.collect();
      model = buildCockpitModel(bundles, { section: currentSection });
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
            schedules: [],
          },
        ],
        { section: currentSection },
      );
    }
    if (panel === live) {
      live.webview.postMessage(modelMessage(model));
      live.title = currentSection === "mission" ? `${s.title} — ${s.navMission}` : s.title;
    }
  };

  const sendMission = async () => {
    if (panel !== live) return;
    if (currentSection !== "mission") return;
    const all = deps.missionBoard.getWorkspaces();
    const ws = resolveMissionWs(deps.missionBoard);
    if (!ws) {
      live.webview.postMessage(taskErrorMessage("No Tachyon workspace for Mission board."));
      return;
    }
    missionWsHash = ws.wsHash;
    try {
      const vm = await buildMissionVm(ws, all);
      if (panel !== live || currentSection !== "mission") return;
      live.webview.postMessage(snapshotMessage(vm));
    } catch (err) {
      if (panel !== live) return;
      live.webview.postMessage(taskErrorMessage(err instanceof Error ? err.message : String(err)));
    }
  };

  pushMissionBoard = () => {
    void sendMission();
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
      const ws = resolveMissionWs(deps.missionBoard);
      if (ws) deps.missionBoard.openTaskDetail(ws, m.id);
      return true;
    }
    if (m.type === "copyTaskId" && typeof m.id === "string") {
      await vscode.env.clipboard.writeText(m.id);
      return true;
    }
    if (m.type === "switchWorkspace" && typeof m.wsHash === "string") {
      missionWsHash = m.wsHash;
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

  // Wire message handler once per panel instance (avoid stacking on re-open).
  if (wiredPanel !== live) {
    wiredPanel = live;
    live.webview.onDidReceiveMessage(async (msg: CockpitAction | Partial<MissionControlAction>) => {
      if (panel !== live || !msg || typeof msg !== "object" || !("type" in msg)) return;

      if (await handleMissionAction(msg as Partial<MissionControlAction>)) return;

      const c = msg as CockpitAction;
      switch (c.type) {
        case READY:
          live.webview.postMessage(initMessage(s));
          await sendModel();
          if (currentSection === "mission") await sendMission();
          return;
        case "refresh":
          await sendModel();
          if (currentSection === "mission") await sendMission();
          return;
        case "setSection":
          currentSection = c.section;
          await sendModel();
          if (currentSection === "mission") await sendMission();
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
        case "openServerInspector":
          deps.openServerInspector();
          return;
        case "openMissionControl":
          // Monolith: Mission is a Control tab, not a separate panel.
          currentSection = "mission";
          await sendModel();
          await sendMission();
          return;
        case "openPlugins":
          deps.openPlugins();
          return;
        case "openSettings":
          deps.openSettings();
          return;
        case "openApprovals":
          deps.openApprovals();
          return;
        case "openRuntimeOps":
          deps.openRuntimeOps();
          return;
        case "openDoctor":
          deps.openDoctor();
          return;
      }
    });
  }

  if (creating) {
    const uri = (f: string): string => live.webview.asWebviewUri(vscode.Uri.joinPath(deps.extensionUri, "dist", "webview", f)).toString();
    live.webview.html = renderWebviewShell({
      cspSource: live.webview.cspSource,
      title: s.title,
      // Board CSS + kit tailwind so embedded Mission Control looks/behaves as the standalone panel.
      styles: [
        uri("codicon.css"),
        uri("design-system.css"),
        uri("vscode-theme.css"),
        uri("mission-control.tailwind.css"),
        uri("mission-control.css"),
        uri("cockpit.css"),
      ],
      bundle: uri("cockpit.js"),
      mode: "live",
      persistedState: {
        schemaVersion: 1,
        view: COCKPIT_VIEW_TYPE,
        section: currentSection,
      } satisfies CockpitPanelState,
    });
  } else {
    await sendModel();
    if (currentSection === "mission") await sendMission();
  }
}
