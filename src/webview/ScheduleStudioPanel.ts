import type * as vscode from "vscode";
import type { WorkspaceStudioTarget } from "../shell/WorkspacePresentation.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import type { StudioPanelState } from "./shared/studio/StudioPanelManagerBase.js";
import type { ScheduleStudioPatch } from "./schedule-studio-shell/domain.js";
import { SingleModeStudioPanelManager } from "./shared/studio/SingleModeStudioPanelManager.js";
import { STUDIO_REGISTRY } from "./shared/studio/studioRegistry.js";
import { webviewApp } from "./webviewApps.js";
export const SCHEDULE_STUDIO_SHELL_VIEW_TYPE = "tachyonScheduleStudioShell";
export type ScheduleStudioPanelState = StudioPanelState<ScheduleStudioPatch>;
export class ScheduleStudioPanelManager extends SingleModeStudioPanelManager {
  constructor(
    uri: vscode.Uri,
    workspaces: () => WorkspaceStudioTarget[],
    onChanged: () => void,
    scope?: ControlWorkspaceScope,
  ) {
    const row = STUDIO_REGISTRY.schedule;
    super(
      uri,
      {
        app: webviewApp("schedule-studio-shell"),
        styleFiles: [
          "codicon.css",
          "design-system.css", "quick-picker.css",
          "vscode-theme.css",
          "studio-frame.css",
          "schedule-studio-shell.css",
        ],
        iconName: "checklist",
        getWorkspaces: workspaces,
        makeAdapter: row.makeAdapter,
        onChanged,
      },
      scope,
    );
  }
}
