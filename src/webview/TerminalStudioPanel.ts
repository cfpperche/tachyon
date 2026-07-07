import * as vscode from "vscode";
import type { Workspace } from "../workspace/Workspace.js";
import { StudioPanelManagerBase, type StudioDomainMessageContext, type StudioPanelState, type StudioSurfaceConfig } from "./shared/studio/StudioPanelManagerBase.js";
import { envelope, type StudioRestoreSnapshot } from "./shared/studio/protocol.js";
import { TerminalStudioAdapter } from "./TerminalStudioAdapter.js";
import type { TerminalStudioEntity, TerminalStudioFields, TerminalStudioPatch, TerminalStudioReferenceData } from "./terminal-studio-shell/domain.js";

const surface: StudioSurfaceConfig = {
  viewType: "tachyonTerminalStudioShell",
  bundleFile: "terminal-studio-shell.js",
  styleFiles: ["codicon.css", "design-system.css", "studio-frame.css", "terminal-studio-shell.css"],
  iconName: "terminal",
};

export const TERMINAL_STUDIO_SHELL_VIEW_TYPE = surface.viewType;
export type TerminalStudioPanelState = StudioPanelState<TerminalStudioPatch>;

export class TerminalStudioPanelManager {
  private readonly workspaces = new Map<string, StudioPanelManagerBase<TerminalStudioEntity, TerminalStudioFields, TerminalStudioPatch, TerminalStudioReferenceData>>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    getWorkspacesOrOnChanged?: (() => Workspace[]) | (() => void),
    onChangedMaybe?: () => void,
  ) {
    if (onChangedMaybe) {
      this.getWorkspaces = getWorkspacesOrOnChanged as () => Workspace[];
      this.onChanged = onChangedMaybe;
    } else {
      this.getWorkspaces = () => [];
      this.onChanged = (getWorkspacesOrOnChanged as (() => void) | undefined) ?? (() => {});
    }
  }

  private readonly getWorkspaces: () => Workspace[];
  private readonly onChanged: () => void;

  openNew(ws: Workspace): void {
    this.baseFor(ws).openNew(ws.wsHash);
  }

  openExisting(ws: Workspace, terminalName: string): void {
    this.baseFor(ws).openExisting(ws.wsHash, terminalName);
  }

  refreshAll(): void {
    for (const base of this.workspaces.values()) base.refreshAll();
  }

  dispose(): void {
    for (const base of this.workspaces.values()) base.dispose();
    this.workspaces.clear();
  }

  captureSnapshot(ws: Workspace, entityId?: string): StudioRestoreSnapshot<string, TerminalStudioPatch> | undefined {
    return this.workspaces.get(ws.wsHash)?.captureSnapshot(ws.wsHash, entityId);
  }

  restoreFromSnapshot(ws: Workspace, snapshot: StudioRestoreSnapshot<string, TerminalStudioPatch>): void {
    this.baseFor(ws).restoreFromSnapshot(ws.wsHash, snapshot);
  }

  deserialize(panel: vscode.WebviewPanel, state: TerminalStudioPanelState): void {
    const ws = this.getWorkspaces().find((w) => w.wsHash === state.wsKey);
    if (!ws) { panel.dispose(); return; }
    this.baseFor(ws).deserializePanel(panel, state);
  }

  private baseFor(ws: Workspace): StudioPanelManagerBase<TerminalStudioEntity, TerminalStudioFields, TerminalStudioPatch, TerminalStudioReferenceData> {
    let base = this.workspaces.get(ws.wsHash);
    if (!base) {
      base = new StudioPanelManagerBase<TerminalStudioEntity, TerminalStudioFields, TerminalStudioPatch, TerminalStudioReferenceData>(
        this.extensionUri,
        surface,
        new TerminalStudioAdapter(ws),
        this.onChanged,
        (ctx, message) => this.handleDomainMessage(ws, ctx, message),
      );
      this.workspaces.set(ws.wsHash, base);
    }
    return base;
  }

  private handleDomainMessage(ws: Workspace, ctx: StudioDomainMessageContext, message: { type: string }): void {
    if (message.type !== "browse") return;
    void this.browse(ws, ctx);
  }

  private async browse(ws: Workspace, ctx: StudioDomainMessageContext): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(ws.workspaceRoot),
    });
    if (picked?.[0]) ctx.post(envelope({ type: "cwd" as const, value: picked[0].fsPath }));
  }
}
