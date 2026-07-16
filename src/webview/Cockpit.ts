import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import {
  buildCockpitModel,
  formatCockpitDiagnostics,
  type CockpitModel,
  type CockpitSectionId,
  type ControlInspectorWorkspaceInput,
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
 * Tachyon Cockpit (desktop POC) — editor-area project sysadmin.
 * Does NOT replace the sidebar. Composes control-plane modules (Engine/Bridge first).
 * Related product intent: t-fe52f0 frente (1); mobile deferred.
 */
export interface CockpitDeps {
  extensionUri: vscode.Uri;
  collect: () => Promise<ControlInspectorWorkspaceInput[]>;
  openServerInspector: () => void;
  openMissionControl: () => void;
}

function strings(): CockpitStrings {
  const t = vscode.l10n.t;
  return {
    title: t("Cockpit"),
    subtitle: t("Project sysadmin — editor panel"),
    pocBanner: t(
      "POC desktop Cockpit (t-fe52f0 frente 1). Does NOT replace the sidebar. Mobile/companion deferred. Engine/Bridge is the first module.",
    ),
    navOverview: t("Overview"),
    navEngine: t("Engine / Bridge"),
    navFleet: t("Fleet"),
    navTmux: t("tmux"),
    refresh: t("Refresh"),
    auto: t("Auto-refresh"),
    empty: t("No Tachyon workspace attached in this window."),
    copyDiagnostics: t("Copy diagnostics"),
    openServerInspector: t("Open tmux Server Inspector"),
    openMissionControl: t("Open Mission Control"),
    copied: t("Diagnostics copied"),
    overviewTitle: t("Overview"),
    overviewHint: t("Health snapshot across attached workspace engines. Sidebar remains the day-to-day fleet UI."),
    engineTitle: t("Engine / Bridge"),
    fleetTitle: t("Fleet presence"),
    fleetBody: t(
      "Placeholder. Day-to-day agent rows stay in the sidebar; Mission Control remains the work board. This slot may later show presence summaries only.",
    ),
    tmuxTitle: t("tmux sessions"),
    tmuxBody: t("Full session reaper stays in the dedicated tmux Server Inspector. Open it for kill/reap/capture."),
    workspaces: t("Workspaces"),
    engines: t("Engines"),
    agents: t("Agents"),
    errors: t("Errors"),
    bridges: t("Bridges"),
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
    checkedAt: t("Checked"),
    sidebarNote: t("Sidebar unchanged — agents, spawn, pins stay there."),
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
      const rows = await deps.collect();
      model = buildCockpitModel(rows, { section: currentSection });
    } catch (err) {
      model = buildCockpitModel(
        [
          {
            folderName: "(cockpit)",
            workspaceRoot: "",
            wsHash: "error",
            bridgeUrl: "",
            identityError: err instanceof Error ? err.message : String(err),
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
          const rows = await deps.collect();
          const text = formatCockpitDiagnostics(buildCockpitModel(rows, { section: currentSection }));
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
