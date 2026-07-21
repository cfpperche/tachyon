import * as vscode from "vscode";
import type { WorkspacePresentationTarget } from "../shell/WorkspacePresentation.js";
import { isCockpitSingletonClaimed } from "./cockpitSingleton.js";

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
    // t-610705 (Phase C.0) — VS Code doesn't guarantee revive order across view types; if Control's
    // own revival/open already claimed the singleton this session, a redirect here would clobber
    // whatever route the user is already looking at. `open()` below is unguarded — it is a live,
    // user-initiated jump and must always navigate.
    if (isCockpitSingletonClaimed()) return;
    void vscode.commands.executeCommand("tachyon.openApprovals", state.wsHash);
  }

  open(ws: WorkspacePresentationTarget): void {
    void vscode.commands.executeCommand("tachyon.openApprovals", ws.wsHash);
  }

  refreshAll(): void {
    // Cockpit owns live Approvals refresh via refreshCockpitApprovals.
  }
}
