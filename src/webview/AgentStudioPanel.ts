import * as vscode from "vscode";
import type { WorkspaceStudioTarget } from "../shell/WorkspacePresentation.js";
import { StudioPanelManagerBase, type StudioDomainMessageContext, type StudioPanelState, type StudioSurfaceConfig } from "./shared/studio/StudioPanelManagerBase.js";
import { envelope, type StudioRestoreSnapshot } from "./shared/studio/protocol.js";
import { AgentStudioAdapter } from "./AgentStudioAdapter.js";
import type { AgentStudioEntity, AgentStudioFields, AgentStudioPatch } from "./agent-studio-shell/domain.js";

/**
 * spec 350 Phase 3 T2 — Agent Studio (shell) host wiring: thin over `StudioPanelManagerBase` +
 * `AgentStudioAdapter`, mirroring PipelineStudioPanel.ts / TaskStudioPanel.ts's shape. One
 * `StudioPanelManagerBase` instance per workspace (keyed by `wsHash`), since
 * the base itself has no workspace concept — the adapter is what's workspace-scoped.
 *
 * The one registered domain action, `browse`, is the native-picker round trip the shell's adapter surface
 * budget documents (README.md) — the same pattern as Pin/Task Studio's `importImage`.
 */
const surface: StudioSurfaceConfig = {
  viewType: "tachyonAgentStudioShell",
  bundleFile: "agent-studio-shell.js",
  styleFiles: ["codicon.css", "design-system.css", "studio-frame.css", "agent-studio-shell.css"],
  iconName: "hubot",
};

export const AGENT_STUDIO_SHELL_VIEW_TYPE = surface.viewType;
export type AgentStudioPanelState = StudioPanelState<AgentStudioPatch>;

export class AgentStudioPanelManager {
  private readonly workspaces = new Map<string, StudioPanelManagerBase<AgentStudioEntity, AgentStudioFields, AgentStudioPatch>>();

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

  openExisting(ws: WorkspaceStudioTarget, agentName: string): void {
    this.baseFor(ws).openExisting(ws.wsHash, agentName);
  }

  refreshAll(): void {
    for (const base of this.workspaces.values()) base.refreshAll();
  }

  dispose(): void {
    for (const base of this.workspaces.values()) base.dispose();
    this.workspaces.clear();
  }

  captureSnapshot(ws: WorkspaceStudioTarget, entityId?: string): StudioRestoreSnapshot<string, AgentStudioPatch> | undefined {
    return this.workspaces.get(ws.wsHash)?.captureSnapshot(ws.wsHash, entityId);
  }

  restoreFromSnapshot(ws: WorkspaceStudioTarget, snapshot: StudioRestoreSnapshot<string, AgentStudioPatch>): void {
    this.baseFor(ws).restoreFromSnapshot(ws.wsHash, snapshot);
  }

  deserialize(panel: vscode.WebviewPanel, state: AgentStudioPanelState): void {
    const ws = this.getWorkspaces().find((w) => w.wsHash === state.wsKey);
    if (!ws) { panel.dispose(); return; }
    this.baseFor(ws).deserializePanel(panel, state);
  }

  private baseFor(ws: WorkspaceStudioTarget): StudioPanelManagerBase<AgentStudioEntity, AgentStudioFields, AgentStudioPatch> {
    let base = this.workspaces.get(ws.wsHash);
    if (!base) {
      base = new StudioPanelManagerBase<AgentStudioEntity, AgentStudioFields, AgentStudioPatch>(
        this.extensionUri,
        surface,
        new AgentStudioAdapter(ws),
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
