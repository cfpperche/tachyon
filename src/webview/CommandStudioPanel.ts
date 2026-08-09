import type * as vscode from "vscode";
import type { WorkspaceStudioTarget } from "../shell/WorkspacePresentation.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import type { StudioPanelState } from "./shared/studio/StudioPanelManagerBase.js";
import type { CommandStudioPatch } from "./command-studio-shell/domain.js";
import { SingleModeStudioPanelManager } from "./shared/studio/SingleModeStudioPanelManager.js";
import { STUDIO_REGISTRY } from "./shared/studio/studioRegistry.js";
import { webviewApp } from "./webviewApps.js";

export const COMMAND_STUDIO_SHELL_VIEW_TYPE = "tachyonCommandStudioShell";
export type CommandStudioPanelState = StudioPanelState<CommandStudioPatch>;
export class CommandStudioPanelManager extends SingleModeStudioPanelManager {
  constructor(
    uri: vscode.Uri,
    workspaces: () => WorkspaceStudioTarget[],
    onChanged: () => void,
    scope?: ControlWorkspaceScope,
  ) {
    const row = STUDIO_REGISTRY.command;
    super(
      uri,
      {
        app: webviewApp("command-studio-shell"),
        styleFiles: [
          "codicon.css",
          "design-system.css",
          "vscode-theme.css",
          "studio-frame.css",
          "command-studio-shell.css",
        ],
        iconName: "terminal",
        getWorkspaces: workspaces,
        makeAdapter: row.makeAdapter,
        onChanged,
        handleDomainMessage: row.handleDomainMessage,
      },
      scope,
    );
  }
}
