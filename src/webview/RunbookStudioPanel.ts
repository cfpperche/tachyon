import * as vscode from "vscode";
import type { Workspace } from "../workspace/Workspace.js";
import { StudioPanelManagerBase, type StudioPanelState, type StudioSurfaceConfig } from "./shared/studio/StudioPanelManagerBase.js";
import type { StudioRestoreSnapshot } from "./shared/studio/protocol.js";
import { RunbookStudioAdapter } from "./RunbookStudioAdapter.js";
import type { RunbookStudioEntity, RunbookStudioFields, RunbookStudioPatch, RunbookStudioReferenceData } from "./runbook-studio-shell/domain.js";

const surface: StudioSurfaceConfig = {
  viewType: "tachyonRunbookStudioShell",
  bundleFile: "runbook-studio-shell.js",
  styleFiles: ["codicon.css", "design-system.css", "studio-frame.css", "runbook-studio-shell.css"],
  iconName: "book",
};

export const RUNBOOK_STUDIO_SHELL_VIEW_TYPE = surface.viewType;
export type RunbookStudioPanelState = StudioPanelState<RunbookStudioPatch>;

export class RunbookStudioPanelManager {
  private readonly workspaces = new Map<string, StudioPanelManagerBase<RunbookStudioEntity, RunbookStudioFields, RunbookStudioPatch, RunbookStudioReferenceData>>();

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

  openExisting(ws: Workspace, runbookName: string): void {
    this.baseFor(ws).openExisting(ws.wsHash, runbookName);
  }

  refreshAll(): void {
    for (const base of this.workspaces.values()) base.refreshAll();
  }

  refreshReferenceData(): void {
    for (const base of this.workspaces.values()) base.refreshReferenceData();
  }

  dispose(): void {
    for (const base of this.workspaces.values()) base.dispose();
    this.workspaces.clear();
  }

  captureSnapshot(ws: Workspace, entityId?: string): StudioRestoreSnapshot<string, RunbookStudioPatch> | undefined {
    return this.workspaces.get(ws.wsHash)?.captureSnapshot(ws.wsHash, entityId);
  }

  restoreFromSnapshot(ws: Workspace, snapshot: StudioRestoreSnapshot<string, RunbookStudioPatch>): void {
    this.baseFor(ws).restoreFromSnapshot(ws.wsHash, snapshot);
  }

  deserialize(panel: vscode.WebviewPanel, state: RunbookStudioPanelState): void {
    const ws = this.getWorkspaces().find((w) => w.wsHash === state.wsKey);
    if (!ws) { panel.dispose(); return; }
    this.baseFor(ws).deserializePanel(panel, state);
  }

  private baseFor(ws: Workspace): StudioPanelManagerBase<RunbookStudioEntity, RunbookStudioFields, RunbookStudioPatch, RunbookStudioReferenceData> {
    let base = this.workspaces.get(ws.wsHash);
    if (!base) {
      base = new StudioPanelManagerBase<RunbookStudioEntity, RunbookStudioFields, RunbookStudioPatch, RunbookStudioReferenceData>(
        this.extensionUri,
        surface,
        new RunbookStudioAdapter(ws),
        this.onChanged,
      );
      this.workspaces.set(ws.wsHash, base);
    }
    return base;
  }
}
