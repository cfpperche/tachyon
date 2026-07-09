import * as vscode from "vscode";
import type { Workspace } from "../workspace/Workspace.js";
import { panelIcon } from "./shared/panelIcon.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import { approvalErrorMessage, approvalsMessage, type ApprovalAction } from "./approval/messages.js";
import { buildApprovalViewModel } from "./approval/viewModel.js";

export const APPROVAL_VIEW_TYPE = "tachyonApprovals";

export interface ApprovalPanelState {
  schemaVersion: 1;
  view: typeof APPROVAL_VIEW_TYPE;
  wsHash: string;
}

export class ApprovalPanelManager {
  private panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => Workspace[],
  ) {}

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }

  open(ws: Workspace): void {
    const existing = this.panels.get(ws.wsHash);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active);
      this.post(existing, ws);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      APPROVAL_VIEW_TYPE,
      `Approvals: ${ws.folderName}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")], retainContextWhenHidden: true },
    );
    panel.iconPath = panelIcon(this.extensionUri, "checklist");
    this.panels.set(ws.wsHash, panel);
    panel.onDidDispose(() => this.panels.delete(ws.wsHash));
    this.revive(panel, ws);
  }

  deserialize(panel: vscode.WebviewPanel, state: ApprovalPanelState): void {
    const ws = this.getWorkspaces().find((w) => w.wsHash === state.wsHash);
    if (!ws) {
      panel.dispose();
      return;
    }
    this.panels.set(ws.wsHash, panel);
    panel.onDidDispose(() => this.panels.delete(ws.wsHash));
    this.revive(panel, ws);
  }

  refreshAll(): void {
    for (const [hash, panel] of this.panels) {
      const ws = this.getWorkspaces().find((w) => w.wsHash === hash);
      if (ws) this.post(panel, ws);
    }
  }

  private revive(panel: vscode.WebviewPanel, ws: Workspace): void {
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title: "Tachyon approvals",
      styles: [uri("codicon.css"), uri("design-system.css"), uri("approval.css")],
      bundle: uri("approval.js"),
      mode: "live",
      persistedState: { schemaVersion: 1, view: APPROVAL_VIEW_TYPE, wsHash: ws.wsHash } satisfies ApprovalPanelState,
    });
    panel.webview.onDidReceiveMessage((m: Partial<ApprovalAction>) => {
      if (m?.type === READY || m?.type === "refresh") return this.post(panel, ws);
      if (m?.type === "resolve" && m.id && (m.decision === "approved" || m.decision === "denied")) {
        void vscode.commands.executeCommand("tachyon.resolveApproval", { id: m.id, decision: m.decision, wsHash: m.wsHash });
      }
    });
    this.post(panel, ws);
  }

  private post(panel: vscode.WebviewPanel, ws: Workspace): void {
    try {
      const vm = buildApprovalViewModel({ workspaceRoot: ws.workspaceRoot, folder: ws.folderName, wsHash: ws.wsHash });
      void panel.webview.postMessage(approvalsMessage(vm));
    } catch (err) {
      void panel.webview.postMessage(approvalErrorMessage(err instanceof Error ? err.message : String(err)));
    }
  }
}
