import * as vscode from "vscode";
import type { WorkspaceStudioTarget } from "../shell/WorkspacePresentation.js";
import { StudioPanelManagerBase, type StudioDomainMessageContext, type StudioPanelState, type StudioSurfaceConfig } from "./shared/studio/StudioPanelManagerBase.js";
import { envelope, type StudioRestoreSnapshot } from "./shared/studio/protocol.js";
import { CommandStudioAdapter } from "./CommandStudioAdapter.js";
import type { CommandStudioEntity, CommandStudioFields, CommandStudioPatch, CommandStudioReferenceData } from "./command-studio-shell/domain.js";

const surface: StudioSurfaceConfig = {
  viewType: "tachyonCommandStudioShell",
  bundleFile: "command-studio-shell.js",
  styleFiles: ["codicon.css", "design-system.css", "studio-frame.css", "command-studio-shell.css"],
  iconName: "terminal-tmux",
};

export const COMMAND_STUDIO_SHELL_VIEW_TYPE = surface.viewType;
export type CommandStudioPanelState = StudioPanelState<CommandStudioPatch>;

export class CommandStudioPanelManager {
  private readonly workspaces = new Map<string, StudioPanelManagerBase<CommandStudioEntity, CommandStudioFields, CommandStudioPatch, CommandStudioReferenceData>>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    getWorkspacesOrOnChanged?: (() => WorkspaceStudioTarget[]) | (() => void),
    onChangedMaybe?: () => void,
  ) {
    if (onChangedMaybe) {
      this.getWorkspaces = getWorkspacesOrOnChanged as () => WorkspaceStudioTarget[];
      this.onChanged = onChangedMaybe;
    } else {
      this.getWorkspaces = () => [];
      this.onChanged = (getWorkspacesOrOnChanged as (() => void) | undefined) ?? (() => {});
    }
  }

  private readonly getWorkspaces: () => WorkspaceStudioTarget[];
  private readonly onChanged: () => void;

  openNew(ws: WorkspaceStudioTarget): void {
    this.baseFor(ws).openNew(ws.wsHash);
  }

  openExisting(ws: WorkspaceStudioTarget, commandName: string): void {
    this.baseFor(ws).openExisting(ws.wsHash, commandName);
  }

  refreshAll(): void {
    for (const base of this.workspaces.values()) base.refreshAll();
  }

  dispose(): void {
    for (const base of this.workspaces.values()) base.dispose();
    this.workspaces.clear();
  }

  captureSnapshot(ws: WorkspaceStudioTarget, entityId?: string): StudioRestoreSnapshot<string, CommandStudioPatch> | undefined {
    return this.workspaces.get(ws.wsHash)?.captureSnapshot(ws.wsHash, entityId);
  }

  restoreFromSnapshot(ws: WorkspaceStudioTarget, snapshot: StudioRestoreSnapshot<string, CommandStudioPatch>): void {
    this.baseFor(ws).restoreFromSnapshot(ws.wsHash, snapshot);
  }

  deserialize(panel: vscode.WebviewPanel, state: CommandStudioPanelState): void {
    const ws = this.getWorkspaces().find((w) => w.wsHash === state.wsKey);
    if (!ws) { panel.dispose(); return; }
    this.baseFor(ws).deserializePanel(panel, state);
  }

  private baseFor(ws: WorkspaceStudioTarget): StudioPanelManagerBase<CommandStudioEntity, CommandStudioFields, CommandStudioPatch, CommandStudioReferenceData> {
    let base = this.workspaces.get(ws.wsHash);
    if (!base) {
      base = new StudioPanelManagerBase<CommandStudioEntity, CommandStudioFields, CommandStudioPatch, CommandStudioReferenceData>(
        this.extensionUri,
        surface,
        new CommandStudioAdapter(ws),
        this.onChanged,
        (ctx, message) => this.handleDomainMessage(ws, ctx, message),
      );
      this.workspaces.set(ws.wsHash, base);
    }
    return base;
  }

  private handleDomainMessage(ws: WorkspaceStudioTarget, ctx: StudioDomainMessageContext, message: { type: string }): void {
    if (message.type !== "browse") return;
    void this.browse(ws, ctx);
  }

  private async browse(ws: WorkspaceStudioTarget, ctx: StudioDomainMessageContext): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(ws.workspaceRoot),
    });
    if (picked?.[0]) ctx.post(envelope({ type: "cwd" as const, value: picked[0].fsPath }));
  }
}
