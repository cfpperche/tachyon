import * as vscode from "vscode";
import type { WorkspaceStudioTarget } from "../shell/WorkspacePresentation.js";
import { StudioPanelManagerBase, type StudioPanelState, type StudioSurfaceConfig } from "./shared/studio/StudioPanelManagerBase.js";
import type { StudioRestoreSnapshot } from "./shared/studio/protocol.js";
import { ScheduleStudioAdapter } from "./ScheduleStudioAdapter.js";
import type { ScheduleStudioEntity, ScheduleStudioFields, ScheduleStudioPatch, ScheduleStudioReferenceData } from "./schedule-studio-shell/domain.js";

const surface: StudioSurfaceConfig = {
  viewType: "tachyonScheduleStudioShell",
  bundleFile: "schedule-studio-shell.js",
  styleFiles: ["codicon.css", "design-system.css", "studio-frame.css", "schedule-studio-shell.css"],
  iconName: "pulse",
};

export const SCHEDULE_STUDIO_SHELL_VIEW_TYPE = surface.viewType;
export type ScheduleStudioPanelState = StudioPanelState<ScheduleStudioPatch>;

export class ScheduleStudioPanelManager {
  private readonly workspaces = new Map<string, StudioPanelManagerBase<ScheduleStudioEntity, ScheduleStudioFields, ScheduleStudioPatch, ScheduleStudioReferenceData>>();

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

  openExisting(ws: WorkspaceStudioTarget, scheduleName: string): void {
    this.baseFor(ws).openExisting(ws.wsHash, scheduleName);
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

  captureSnapshot(ws: WorkspaceStudioTarget, entityId?: string): StudioRestoreSnapshot<string, ScheduleStudioPatch> | undefined {
    return this.workspaces.get(ws.wsHash)?.captureSnapshot(ws.wsHash, entityId);
  }

  restoreFromSnapshot(ws: WorkspaceStudioTarget, snapshot: StudioRestoreSnapshot<string, ScheduleStudioPatch>): void {
    this.baseFor(ws).restoreFromSnapshot(ws.wsHash, snapshot);
  }

  deserialize(panel: vscode.WebviewPanel, state: ScheduleStudioPanelState): void {
    const ws = this.getWorkspaces().find((w) => w.wsHash === state.wsKey);
    if (!ws) { panel.dispose(); return; }
    this.baseFor(ws).deserializePanel(panel, state);
  }

  private baseFor(ws: WorkspaceStudioTarget): StudioPanelManagerBase<ScheduleStudioEntity, ScheduleStudioFields, ScheduleStudioPatch, ScheduleStudioReferenceData> {
    let base = this.workspaces.get(ws.wsHash);
    if (!base) {
      base = new StudioPanelManagerBase<ScheduleStudioEntity, ScheduleStudioFields, ScheduleStudioPatch, ScheduleStudioReferenceData>(
        this.extensionUri,
        surface,
        new ScheduleStudioAdapter(ws),
        this.onChanged,
      );
      this.workspaces.set(ws.wsHash, base);
    }
    return base;
  }
}
