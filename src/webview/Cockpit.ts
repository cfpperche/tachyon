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

export const COCKPIT_VIEW_TYPE = "tachyonCockpit";

export interface CockpitPanelState {
  schemaVersion: 1;
  view: typeof COCKPIT_VIEW_TYPE;
  section?: CockpitSectionId;
}

/**
 * Tachyon Cockpit — editor-area project sysadmin.
 * Top tabs only (no webview left rail). Does not replace VS Code/Tachyon sidebar.
 * t-fe52f0 frente 1; mobile deferred.
 */
export interface CockpitDeps {
  extensionUri: vscode.Uri;
  collect: () => Promise<CockpitWorkspaceBundle[]>;
  openServerInspector: () => void;
  openMissionControl: () => void;
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
    openMissionControl: t("Open Mission Control"),
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
    missionHint: t("Work board summary. Open Mission Control for the full board."),
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

export async function openCockpit(
  deps: CockpitDeps,
  opts?: { section?: CockpitSectionId; revivedPanel?: vscode.WebviewPanel },
): Promise<void> {
  const s = strings();
  if (opts?.section) currentSection = opts.section;

  if (panel && !opts?.revivedPanel) {
    panel.reveal(vscode.ViewColumn.Active);
  } else {
    panel = opts?.revivedPanel ?? vscode.window.createWebviewPanel(COCKPIT_VIEW_TYPE, s.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, "dist", "webview")],
    });
    panel.title = s.title;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, "dist", "webview")],
    };
    panel.iconPath = panelIcon(deps.extensionUri, "pulse");
    panel.onDidDispose(() => {
      panel = undefined;
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
      live.title = s.title;
    }
  };

  live.webview.onDidReceiveMessage(async (msg: CockpitAction) => {
    if (panel !== live) return;
    switch (msg.type) {
      case READY:
        live.webview.postMessage(initMessage(s));
        await sendModel();
        return;
      case "refresh":
        await sendModel();
        return;
      case "setSection":
        currentSection = msg.section;
        await sendModel();
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
        deps.openMissionControl();
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

  const uri = (f: string): string => live.webview.asWebviewUri(vscode.Uri.joinPath(deps.extensionUri, "dist", "webview", f)).toString();
  live.webview.html = renderWebviewShell({
    cspSource: live.webview.cspSource,
    title: s.title,
    styles: [uri("codicon.css"), uri("design-system.css"), uri("cockpit.css")],
    bundle: uri("cockpit.js"),
    mode: "live",
    persistedState: {
      schemaVersion: 1,
      view: COCKPIT_VIEW_TYPE,
      section: currentSection,
    } satisfies CockpitPanelState,
  });
}
