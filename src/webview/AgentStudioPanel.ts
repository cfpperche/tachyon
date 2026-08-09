import type * as vscode from "vscode";
import type { WorkspaceStudioTarget } from "../shell/WorkspacePresentation.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import type { StudioPanelState } from "./shared/studio/StudioPanelManagerBase.js";
import type { AgentStudioPatch } from "./agent-studio-shell/domain.js";
import { SingleModeStudioPanelManager } from "./shared/studio/SingleModeStudioPanelManager.js";
import { STUDIO_REGISTRY } from "./shared/studio/studioRegistry.js";
import { webviewApp } from "./webviewApps.js";
export const AGENT_STUDIO_SHELL_VIEW_TYPE = "tachyonAgentStudioShell";
export type AgentStudioPanelState = StudioPanelState<AgentStudioPatch>;
export class AgentStudioPanelManager extends SingleModeStudioPanelManager {
  constructor(
    uri: vscode.Uri,
    workspaces: () => WorkspaceStudioTarget[],
    onChanged: () => void,
    scope?: ControlWorkspaceScope,
  ) {
    const row = STUDIO_REGISTRY.agent;
    super(
      uri,
      {
        app: webviewApp("agent-studio-shell"),
        styleFiles: [
          "codicon.css",
          "design-system.css",
          "vscode-theme.css",
          "agent-studio-shell.tailwind.css",
          "studio-frame.css",
          "agent-studio-shell.css",
        ],
        iconName: "hubot",
        getWorkspaces: workspaces,
        makeAdapter: row.makeAdapter,
        onChanged,
        handleDomainMessage: row.handleDomainMessage,
      },
      scope,
    );
  }
}
