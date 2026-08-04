import type * as vscode from "vscode";
import type { WorkspaceStudioTarget } from "../shell/WorkspacePresentation.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import type { StudioPanelState } from "./shared/studio/StudioPanelManagerBase.js";
import type { TerminalStudioPatch } from "./terminal-studio-shell/domain.js";
import { SingleModeStudioPanelManager } from "./shared/studio/SingleModeStudioPanelManager.js";
import { STUDIO_REGISTRY } from "../cockpit/studioRegistry.js";
import { webviewApp } from "./webviewApps.js";
export const TERMINAL_STUDIO_SHELL_VIEW_TYPE = "tachyonTerminalStudioShell";
export type TerminalStudioPanelState = StudioPanelState<TerminalStudioPatch>;
export class TerminalStudioPanelManager extends SingleModeStudioPanelManager {
  constructor(
    uri: vscode.Uri,
    workspaces: () => WorkspaceStudioTarget[],
    onChanged: () => void,
    scope?: ControlWorkspaceScope,
  ) {
    const row = STUDIO_REGISTRY.terminal;
    super(
      uri,
      {
        app: webviewApp("terminal-studio-shell"),
        styleFiles: [
          "codicon.css",
          "design-system.css",
          "vscode-theme.css",
          "studio-frame.css",
          "terminal-studio-shell.css",
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
