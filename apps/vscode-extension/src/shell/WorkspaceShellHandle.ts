import type { GitExec } from "@tachyon/engine/worktree/WorktreeManager.js";
import type { StudioDeps, StudioSubmit } from "../webview/studioSubmit.js";
import { workspaceActivityTarget, type WorkspaceActivityTarget } from "./ActivityTarget.js";
import { ClientWorkspaceStudioTarget } from "./ClientWorkspaceStudioTarget.js";
import { workspaceHandoffTarget, type WorkspaceHandoffTarget } from "./HandoffTarget.js";
import { workspaceBoardTarget, type WorkspaceBoardTarget } from "./BoardTarget.js";
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
  workspacePluginProfileTarget,
  workspaceProbePresentationTarget,
  type WorkspaceGitPresentationTarget,
  type WorkspacePluginPresentationTarget,
  type WorkspacePluginProfileTarget,
  type WorkspaceProbePresentationTarget,
  type WorkspaceAgentStudioTarget,
  type SecretInventoryView,
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
  readonly board: WorkspaceBoardTarget;
  readonly pinStudio: WorkspacePinStudioTarget;
  readonly taskDetail: WorkspaceTaskDetailTarget;
  readonly taskStudio: WorkspaceTaskStudioTarget;
  readonly runtimeOps: WorkspaceRuntimeOpsTarget;
  readonly extension: WorkspaceExtensionTarget;
  readonly git: WorkspaceGitPresentationTarget;
  /** t-b1940c — the git presentation plus the revoke-on-remove door, for the Plugins panel. */
  readonly pluginProfile: WorkspacePluginProfileTarget;
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
    this.board = workspaceBoardTarget(client);
    this.pinStudio = workspacePinStudioTarget(client);
    this.taskDetail = workspaceTaskDetailTarget(client);
    this.taskStudio = workspaceTaskStudioTarget(client);
    this.runtimeOps = workspaceRuntimeOpsTarget(client);
    this.extension = workspaceExtensionTarget(client);
    this.git = workspaceGitPresentationTarget(client, options.gitExec);
    this.pluginProfile = workspacePluginProfileTarget(client, options.gitExec);
    this.probe = workspaceProbePresentationTarget(client);
    this.plugin = workspacePluginPresentationTarget(client);
    this.studio = new ClientWorkspaceStudioTarget(client, { extensionUri: options.extensionUri });
  }

  get workspaceRoot(): string { return this.client.workspaceRoot; }
  get wsHash(): string { return this.client.workspaceHash; }
  get folderName(): string { return this.client.presentation.workspace.folderName; }
  get bridgeUrl(): string { return this.client.bridgeUrl; }
  get config(): WorkspaceStudioTarget["config"] { return this.studio.config; }

  /** t-ea8f78 — same notice queue approval.resolve uses, reached from the editor-side commit. */
  async deliverNotice(agent: string, line: string): Promise<void> {
    await this.extension.invoke({ action: "notice.deliver", agent, line });
  }

  studioDeps(): StudioDeps { return this.studio.studioDeps(); }
  studioSubmit(submit: StudioSubmit): string[] | undefined | Promise<string[] | undefined> {
    return this.studio.studioSubmit(submit);
  }
  secretInventory(): Promise<SecretInventoryView> { return this.studio.secretInventory(); }
  setProfileSecret(provider: string, id: string, value: string) { return this.studio.setProfileSecret(provider, id, value); }
  replaceProfileSecret(provider: string, id: string, value: string) { return this.studio.replaceProfileSecret(provider, id, value); }
  removeProfileSecret(provider: string, id: string) { return this.studio.removeProfileSecret(provider, id); }
  inspectAgentProfileStudio(agent: string) { return this.studio.inspectAgentProfileStudio(agent); }
  agentOwnershipView(agent: string) { return this.studio.agentOwnershipView(agent); }
  commitAgentProfileStudio(mutation: Parameters<ClientWorkspaceStudioTarget["commitAgentProfileStudio"]>[0]) {
    return this.studio.commitAgentProfileStudio(mutation);
  }
  /** SDD 482 phase 4 — create + record owner in one canonical transaction. */
  createSavedAgentWithOwner(mutation: Parameters<ClientWorkspaceStudioTarget["createSavedAgentWithOwner"]>[0], owner: string) {
    return this.studio.createSavedAgentWithOwner(mutation, owner);
  }
  /** t-5498a6 — the shared authorization door, reached from the proposal approval and the Studio. */
  authorizeAgentSkill(agentName: string, skillName: string, options: { reauthorize?: boolean } = {}) {
    return this.studio.authorizeAgentSkill(agentName, skillName, options);
  }

  authorizableCapabilitiesFor(agent: string) {
    return this.studio.authorizableCapabilitiesFor(agent);
  }

  authorizeAgentPlugin(agentName: string, pluginName: string, options: { reauthorize?: boolean } = {}) {
    return this.studio.authorizeAgentPlugin(agentName, pluginName, options);
  }

  createSavedAgent(
    mutation: Parameters<ClientWorkspaceStudioTarget["createSavedAgent"]>[0],
    options: Parameters<ClientWorkspaceStudioTarget["createSavedAgent"]>[1],
  ) {
    return this.studio.createSavedAgent(mutation, options);
  }
  planAgentProfileForget(agent: string, expectedRevision: string) {
    return this.studio.planAgentProfileForget(agent, expectedRevision);
  }
  commitAgentProfileStudioLifecycle(mutation: Parameters<ClientWorkspaceStudioTarget["commitAgentProfileStudioLifecycle"]>[0]) {
    return this.studio.commitAgentProfileStudioLifecycle(mutation);
  }
  exportAgentProfileStudioBundle(agent: string, expectedRevision: string) { return this.studio.exportAgentProfileStudioBundle(agent, expectedRevision); }
  cloneAgentProfileStudioBundle(agent: string, expectedRevision: string, destinationAgentName: string) { return this.studio.cloneAgentProfileStudioBundle(agent, expectedRevision, destinationAgentName); }
  importAgentProfileStudioBundle(destinationAgentName: string, bytes: Buffer) { return this.studio.importAgentProfileStudioBundle(destinationAgentName, bytes); }
  /** t-a39c7d — clear done(unseen) via engine sidebar mutation. */
  async markAgentPaneSeen(agent: string): Promise<void> {
    await this.sidebar.mutateSidebar({ action: "agent.markSeen", id: agent });
  }
}
