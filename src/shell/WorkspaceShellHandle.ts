import type { GitExec } from "../worktree/WorktreeManager.js";
import type { StudioDeps, StudioSubmit } from "../webview/studioSubmit.js";
import { workspaceActivityTarget, type WorkspaceActivityTarget } from "./ActivityTarget.js";
import { ClientWorkspaceStudioTarget } from "./ClientWorkspaceStudioTarget.js";
import { workspaceHandoffTarget, type WorkspaceHandoffTarget } from "./HandoffTarget.js";
import { workspaceMissionControlTarget, type WorkspaceMissionControlTarget } from "./MissionControlTarget.js";
import { workspacePinStudioTarget, type WorkspacePinStudioTarget } from "./PinStudioTarget.js";
import { workspaceRuntimeOpsTarget, type WorkspaceRuntimeOpsTarget } from "./RuntimeOpsTarget.js";
import { workspaceSidebarTarget, type WorkspaceSidebarTarget } from "./SidebarTarget.js";
import { workspaceTaskDetailTarget, type WorkspaceTaskDetailTarget } from "./TaskDetailTarget.js";
import { workspaceTaskStudioTarget, type WorkspaceTaskStudioTarget } from "./TaskStudioTarget.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import { workspaceExtensionTarget, type WorkspaceExtensionTarget } from "./WorkspaceExtensionTarget.js";
import {
  workspaceGitPresentationTarget,
  workspacePluginPresentationTarget,
  workspaceProbePresentationTarget,
  type WorkspaceGitPresentationTarget,
  type WorkspacePluginPresentationTarget,
  type WorkspaceProbePresentationTarget,
  type WorkspaceAgentStudioTarget,
  type WorkspaceStudioTarget,
} from "./WorkspacePresentation.js";

export interface WorkspaceShellHandleOptions {
  extensionUri: StudioDeps["extensionUri"];
  gitExec: GitExec;
}

/**
 * Ephemeral editor-side handle for one persistent workspace engine.  It owns no
 * manager, store, watcher, Bridge or agent lifecycle; every operational gesture
 * crosses WorkspaceClient while the editor keeps only presentation adapters.
 */
export class WorkspaceShellHandle implements WorkspaceAgentStudioTarget {
  readonly sidebar: WorkspaceSidebarTarget;
  readonly activity: WorkspaceActivityTarget;
  readonly handoff: WorkspaceHandoffTarget;
  readonly missionControl: WorkspaceMissionControlTarget;
  readonly pinStudio: WorkspacePinStudioTarget;
  readonly taskDetail: WorkspaceTaskDetailTarget;
  readonly taskStudio: WorkspaceTaskStudioTarget;
  readonly runtimeOps: WorkspaceRuntimeOpsTarget;
  readonly extension: WorkspaceExtensionTarget;
  readonly git: WorkspaceGitPresentationTarget;
  readonly probe: WorkspaceProbePresentationTarget;
  readonly plugin: WorkspacePluginPresentationTarget;
  private readonly studio: ClientWorkspaceStudioTarget;

  constructor(
    readonly client: WorkspaceClient,
    options: WorkspaceShellHandleOptions,
  ) {
    this.sidebar = workspaceSidebarTarget(client);
    this.activity = workspaceActivityTarget(client);
    this.handoff = workspaceHandoffTarget(client);
    this.missionControl = workspaceMissionControlTarget(client);
    this.pinStudio = workspacePinStudioTarget(client);
    this.taskDetail = workspaceTaskDetailTarget(client);
    this.taskStudio = workspaceTaskStudioTarget(client);
    this.runtimeOps = workspaceRuntimeOpsTarget(client);
    this.extension = workspaceExtensionTarget(client);
    this.git = workspaceGitPresentationTarget(client, options.gitExec);
    this.probe = workspaceProbePresentationTarget(client);
    this.plugin = workspacePluginPresentationTarget(client);
    this.studio = new ClientWorkspaceStudioTarget(client, { extensionUri: options.extensionUri });
  }

  get workspaceRoot(): string { return this.client.workspaceRoot; }
  get wsHash(): string { return this.client.workspaceHash; }
  get folderName(): string { return this.client.presentation.workspace.folderName; }
  get bridgeUrl(): string { return this.client.bridgeUrl; }
  get config(): WorkspaceStudioTarget["config"] { return this.studio.config; }

  studioDeps(): StudioDeps { return this.studio.studioDeps(); }
  studioSubmit(submit: StudioSubmit): string[] | undefined | Promise<string[] | undefined> {
    return this.studio.studioSubmit(submit);
  }
  createSoulProfile(agent: string) { return this.studio.createSoulProfile(agent); }
  importSoulProfileBytes(agent: string, bytes: Buffer) { return this.studio.importSoulProfileBytes(agent, bytes); }
  replaceSoulProfileBytes(agent: string, bytes: Buffer, expectedDigest: string) {
    return this.studio.replaceSoulProfileBytes(agent, bytes, expectedDigest);
  }
  adoptSoulProfile(agent: string, expectedDigest: string) { return this.studio.adoptSoulProfile(agent, expectedDigest); }
  enableSoulProfile(agent: string) { return this.studio.enableSoulProfile(agent); }
  disableSoulProfile(agent: string) { return this.studio.disableSoulProfile(agent); }
  deleteSoulProfile(agent: string) { return this.studio.deleteSoulProfile(agent); }
  refreshSoulProfile(agent: string) { return this.studio.refreshSoulProfile(agent); }
  canonicalSoulPathForOpen(agent: string) { return this.studio.canonicalSoulPathForOpen(agent); }
}
