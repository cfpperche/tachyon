import * as vscode from "vscode";
import type { WorkspacePresentationTarget } from "../shell/WorkspacePresentation.js";

export const APPROVAL_VIEW_TYPE = "tachyonApprovals";

export interface ApprovalPanelState {
  schemaVersion: 1;
  view: typeof APPROVAL_VIEW_TYPE;
  wsHash: string;
}

/**
 * spec 410 — Approvals open as Control → Approvals (cockpit section).
 * This manager no longer creates peer panels; it only redirects legacy opens/revives
 * and remains registered so VS Code serializer policy stays explicit on WEBVIEW_SURFACES.
 */
export class ApprovalPanelManager {
  constructor(
    _extensionUri: vscode.Uri,
    _getWorkspaces: () => WorkspacePresentationTarget[],
  ) {}

  dispose(): void {}

  deserialize(panel: vscode.WebviewPanel, state: ApprovalPanelState): void {
    panel.dispose();
    void vscode.commands.executeCommand("tachyon.openApprovals", state.wsHash);
  }

  open(ws: WorkspacePresentationTarget): void {
    void vscode.commands.executeCommand("tachyon.openApprovals", ws.wsHash);
  }

  refreshAll(): void {
    // Cockpit owns live Approvals refresh via refreshCockpitApprovals.
  }
}
