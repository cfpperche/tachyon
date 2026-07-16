import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import {
  buildControlInspectorModel,
  formatControlInspectorDiagnostics,
  type ControlInspectorModel,
  type ControlInspectorWorkspaceInput,
} from "../control-inspector/model.js";
import {
  initMessage,
  modelMessage,
  toastMessage,
  type ControlInspectorAction,
  type ControlInspectorStrings,
} from "./control-inspector/messages.js";

export const CONTROL_INSPECTOR_VIEW_TYPE = "tachyonControlInspector";

export interface ControlInspectorPanelState {
  schemaVersion: 1;
  view: typeof CONTROL_INSPECTOR_VIEW_TYPE;
}

/**
 * Engine/Bridge Control Inspector (POC) — sibling of the tmux Server Inspector.
 * Read-only control-plane snapshot: engine identity, Bridge URL/port, workspace binding.
 * Destructive ops intentionally omitted in the POC.
 */
export interface ControlInspectorDeps {
  extensionUri: vscode.Uri;
  /** Collect one row per attached Tachyon workspace shell. */
  collect: () => Promise<ControlInspectorWorkspaceInput[]>;
  /** Open the existing tmux Server Inspector (domain sibling). */
  openServerInspector: () => void;
}

function strings(): ControlInspectorStrings {
  const t = vscode.l10n.t;
  return {
    title: t("Engine/Bridge Inspector"),
    subtitle: t("Control-plane snapshot for each Tachyon workspace engine (POC — sibling of tmux Server Inspector)."),
    pocBanner: t(
      "POC (option B): separate surface from tmux Server Inspector. Read-only — no restart/kill. Data from live shell attach + engine identity.",
    ),
    refresh: t("Refresh"),
    auto: t("Auto-refresh"),
    empty: t("No Tachyon workspace is attached in this window. Open a folder with Tachyon active."),
    copyDiagnostics: t("Copy diagnostics"),
    openServerInspector: t("Open tmux Inspector"),
    copied: t("Diagnostics copied"),
    summary: t("Summary"),
    workspaces: t("Workspaces"),
    engine: t("Engine"),
    bridge: t("Bridge"),
    workspace: t("Workspace"),
    agents: t("Agents"),
    notes: t("Notes"),
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
    attached: t("attached"),
    error: t("error"),
    none: t("none"),
    running: t("running"),
    checkedAt: t("Checked"),
    openTmux: t("tmux"),
  };
}

let panel: vscode.WebviewPanel | undefined;

export async function openControlInspector(deps: ControlInspectorDeps, revivedPanel?: vscode.WebviewPanel): Promise<void> {
  const s = strings();
  if (panel && !revivedPanel) {
    panel.reveal(vscode.ViewColumn.Active);
  } else {
    panel = revivedPanel ?? vscode.window.createWebviewPanel(CONTROL_INSPECTOR_VIEW_TYPE, s.title, vscode.ViewColumn.Active, {
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
    let model: ControlInspectorModel;
    try {
      const rows = await deps.collect();
      model = buildControlInspectorModel(rows);
    } catch (err) {
      model = buildControlInspectorModel([
        {
          folderName: "(inspector)",
          workspaceRoot: "",
          wsHash: "error",
          bridgeUrl: "",
          identityError: err instanceof Error ? err.message : String(err),
        },
      ]);
    }
    if (panel === live) live.webview.postMessage(modelMessage(model));
  };

  live.webview.onDidReceiveMessage(async (msg: ControlInspectorAction) => {
    if (panel !== live) return;
    switch (msg.type) {
      case READY:
        live.webview.postMessage(initMessage(s));
        await sendModel();
        return;
      case "refresh":
        await sendModel();
        return;
      case "copyDiagnostics": {
        try {
          const rows = await deps.collect();
          const text = formatControlInspectorDiagnostics(buildControlInspectorModel(rows));
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
    }
  });

  const uri = (f: string): string => live.webview.asWebviewUri(vscode.Uri.joinPath(deps.extensionUri, "dist", "webview", f)).toString();
  live.webview.html = renderWebviewShell({
    cspSource: live.webview.cspSource,
    title: s.title,
    styles: [uri("codicon.css"), uri("design-system.css"), uri("control-inspector.css")],
    bundle: uri("control-inspector.js"),
    mode: "live",
    persistedState: { schemaVersion: 1, view: CONTROL_INSPECTOR_VIEW_TYPE } satisfies ControlInspectorPanelState,
  });
}
