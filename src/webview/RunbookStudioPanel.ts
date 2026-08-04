import type * as vscode from "vscode";
import type { WorkspaceStudioTarget } from "../shell/WorkspacePresentation.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import type { StudioPanelState } from "./shared/studio/StudioPanelManagerBase.js";
import type { RunbookStudioPatch } from "./runbook-studio-shell/domain.js";
import { SingleModeStudioPanelManager } from "./shared/studio/SingleModeStudioPanelManager.js";
import { STUDIO_REGISTRY } from "../cockpit/studioRegistry.js";
import { webviewApp } from "./webviewApps.js";
export const RUNBOOK_STUDIO_SHELL_VIEW_TYPE = "tachyonRunbookStudioShell";
export type RunbookStudioPanelState = StudioPanelState<RunbookStudioPatch>;
export class RunbookStudioPanelManager extends SingleModeStudioPanelManager {
  constructor(
    uri: vscode.Uri,
    workspaces: () => WorkspaceStudioTarget[],
    onChanged: () => void,
    scope?: ControlWorkspaceScope,
  ) {
    const row = STUDIO_REGISTRY.runbook;
    super(
      uri,
      {
        app: webviewApp("runbook-studio-shell"),
        styleFiles: [
          "codicon.css",
          "design-system.css",
          "vscode-theme.css",
          "studio-frame.css",
          "runbook-studio-shell.css",
        ],
        iconName: "book",
        getWorkspaces: workspaces,
        makeAdapter: row.makeAdapter,
        onChanged,
      },
      scope,
    );
  }
}
