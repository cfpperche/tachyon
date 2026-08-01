import type { WorkspaceClient } from "./WorkspaceClient.js";
import type { GitExec } from "../worktree/WorktreeManager.js";
import type { TachyonConfig } from "../config/loadConfig.js";
import type { StudioDeps, StudioSubmit } from "../webview/studioSubmit.js";
import type { ProbeView } from "../probe/probeView.js";
import type { AgentStatus, FleetVM } from "../sidebar/types.js";
import type { WorkspaceAgentProjectionV1 } from "../runtime-api/workspaceProjection.js";
import type { SoulProfileStatusMessage } from "../webview/agent-studio-shell/domain.js";
import type {
  EvolutionStudioCandidateDetail,
  EvolutionStudioOverview,
} from "../evolution/studioProjection.js";
import type { AuthorizableCapabilities } from "../config/agentCapabilityCandidates.js";
import type { AgentOwnershipViewV1, AgentProfileStudioBundleCreatedResultV1, AgentProfileStudioBundleExportResultV1, AgentProfileStudioLifecycleMutationV1, AgentProfileStudioLifecycleResultV1, AgentProfileStudioMutationV1, AgentProfileStudioSnapshotV1 } from "../config/agentProfileStudio.js";

/** Narrow identity contract shared by editor panels during the shell cutover. */
export interface WorkspacePresentationTarget {
  workspaceRoot: string;
  wsHash: string;
  folderName: string;
}

export interface WorkspaceGitPresentationTarget extends WorkspacePresentationTarget {
  gitExec: GitExec;
}

export interface WorkspaceProbePresentationTarget extends WorkspacePresentationTarget {
  probeView(caller?: string): Promise<ProbeView>;
}

export interface WorkspacePluginPresentationTarget extends WorkspacePresentationTarget {
  pluginFleet(): Promise<FleetVM>;
}

/**
 * Transitional Studio host contract. The editor owns the panels while config
 * persistence remains behind this narrow seam during the persistent-engine
 * cutover; callers must not depend on the concrete Workspace lifecycle.
 */
export interface WorkspaceStudioTarget extends WorkspacePresentationTarget {
  readonly config: TachyonConfig | undefined;
  studioDeps(): StudioDeps;
  studioSubmit(submit: StudioSubmit): string[] | undefined | Promise<string[] | undefined>;
}

export interface SoulProfileMutationTargetResult {
  status: SoulProfileStatusMessage;
  selfSelected?: boolean;
}

/** Agent Studio's operational identity mutations remain daemon-owned after the shell cutover. */
export interface WorkspaceAgentStudioTarget extends WorkspaceStudioTarget {
  inspectAgentProfileStudio(agent: string): Promise<AgentProfileStudioSnapshotV1>;
  /**
   * t-5498a6 — authorize a workspace skill for this profile. A refusal is a RESULT, not a throw:
   * "this plugin does not install for codex" is an answer the human needs to read.
   */
  authorizeAgentSkill(
    agent: string,
    skillName: string,
    options?: { reauthorize?: boolean },
  ): Promise<{ ok: true; outcome: string; referenceId: string } | { ok: false; error: string }>;
  /** t-5498a6 — candidate lists, queried fresh: a plugin install changes no profile revision. */
  authorizableCapabilitiesFor(agent: string): Promise<AuthorizableCapabilities>;
  /**
   * t-5498a6 — authorize everything a plugin exposes for this runtime, or refuse it whole.
   *
   * t-4a2a6f — `outcomes` is parallel to `authorized` and load-bearing, not diagnostic: a
   * `digest-changed` entry means that skill was NOT written. Dropping it at any hop turns a partial
   * repair into a reported success, which is the defect this carries the data to prevent.
   */
  authorizeAgentPlugin(
    agent: string,
    pluginName: string,
    options?: { reauthorize?: boolean },
  ): Promise<{ ok: true; authorized: string[]; outcomes: string[] } | { ok: false; error: string }>;
  /** t-4c113c — declared `ownership.subagents` plus the targets this agent may still declare. */
  agentOwnershipView(agent: string): Promise<AgentOwnershipViewV1>;
  commitAgentProfileStudio(mutation: AgentProfileStudioMutationV1): Promise<AgentProfileStudioSnapshotV1>;
  commitAgentProfileStudioLifecycle(mutation: AgentProfileStudioLifecycleMutationV1): Promise<AgentProfileStudioLifecycleResultV1>;
  exportAgentProfileStudioBundle(agent: string, expectedRevision: string): Promise<AgentProfileStudioBundleExportResultV1>;
  cloneAgentProfileStudioBundle(agent: string, expectedRevision: string, destinationAgentName: string): Promise<AgentProfileStudioBundleCreatedResultV1>;
  importAgentProfileStudioBundle(destinationAgentName: string, bytes: Buffer): Promise<AgentProfileStudioBundleCreatedResultV1>;
  createSoulProfile(agent: string): Promise<SoulProfileMutationTargetResult>;
  importSoulProfileBytes(agent: string, bytes: Buffer): Promise<SoulProfileMutationTargetResult>;
  replaceSoulProfileBytes(agent: string, bytes: Buffer, expectedDigest: string): Promise<SoulProfileMutationTargetResult>;
  adoptSoulProfile(agent: string, expectedDigest: string): Promise<SoulProfileMutationTargetResult>;
  enableSoulProfile(agent: string): Promise<SoulProfileMutationTargetResult>;
  disableSoulProfile(agent: string): Promise<SoulProfileMutationTargetResult>;
  deleteSoulProfile(agent: string): Promise<SoulProfileMutationTargetResult>;
  refreshSoulProfile(agent: string): Promise<SoulProfileStatusMessage>;
  canonicalSoulPathForOpen(agent: string): Promise<string>;
  readAgentEvolutionOverview(agent: string): Promise<EvolutionStudioOverview>;
  readAgentEvolutionCandidate(agent: string, candidateId: string): Promise<EvolutionStudioCandidateDetail>;
  approveAgentEvolutionCandidate(agent: string, candidateId: string, input: {
    expectedActiveVersion: number;
    expectedTargetDigest?: string;
  }): Promise<{ candidateId: string; activeVersion: number }>;
  rejectAgentEvolutionCandidate(agent: string, candidateId: string, input: {
    expectedActiveVersion: number;
    expectedTargetDigest?: string;
  }): Promise<{ candidateId: string; activeVersion: number }>;
}

export function workspacePresentationTarget(client: WorkspaceClient): WorkspacePresentationTarget {
  const workspace = client.presentation.workspace;
  return {
    workspaceRoot: workspace.root,
    wsHash: workspace.hash,
    folderName: workspace.folderName,
  };
}

export function workspaceGitPresentationTarget(
  client: WorkspaceClient,
  gitExec: GitExec,
): WorkspaceGitPresentationTarget {
  return { ...workspacePresentationTarget(client), gitExec };
}

export function workspaceProbePresentationTarget(client: WorkspaceClient): WorkspaceProbePresentationTarget {
  return {
    ...workspacePresentationTarget(client),
    probeView: async (caller?: string) => {
      const result = await client.query({
        schemaVersion: 1,
        method: "probe.view",
        input: { ...(caller !== undefined ? { caller } : {}) },
      });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "probe.view") throw new Error("Probe query returned the wrong view");
      return result.view;
    },
  };
}

export function workspacePluginPresentationTarget(client: WorkspaceClient): WorkspacePluginPresentationTarget {
  return {
    ...workspacePresentationTarget(client),
    pluginFleet: async () => {
      const presentation = client.presentation;
      return pluginFleetPresentation(
        {
          workspaceRoot: presentation.workspace.root,
          wsHash: presentation.workspace.hash,
          folderName: presentation.workspace.folderName,
        },
        { port: presentation.bridge.port, connected: presentation.bridge.url !== null },
        presentation.agents.items,
      );
    },
  };
}

/** Builds the intentionally sparse fleet consumed by sandboxed plugin surfaces. */
export function pluginFleetPresentation(
  workspace: WorkspacePresentationTarget,
  bridge: { port?: number | string; connected: boolean },
  agents: readonly Pick<WorkspaceAgentProjectionV1, "name" | "kind" | "running" | "lifetime" | "attention" | "unseen" | "configurationPending">[],
): FleetVM {
  return {
    folder: { hash: workspace.wsHash, name: workspace.folderName },
    bridge: { port: bridge.port === undefined ? "-" : String(bridge.port), connected: bridge.connected },
    agents: agents
      .filter((agent) => agent.kind === "agent")
      .map((agent) => ({
        name: agent.name,
        status: pluginAgentStatus(agent.running, agent.attention, agent.unseen),
        ...(agent.attention ? { attention: agent.attention } : {}),
        kind: "agent",
        adhoc: agent.lifetime === "temporary",
      })),
    terminals: [],
    commands: [],
    runbooks: [],
    pins: [],
    schedules: [],
    pipelines: [],
  };
}

function pluginAgentStatus(
  running: boolean,
  attention: WorkspaceAgentProjectionV1["attention"],
  unseen?: boolean,
): AgentStatus {
  if (!running) return "stopped";
  if (attention === "needs-input") return "needs";
  if (attention === "throttled") return "throttled";
  if (attention === "idle" && unseen) return "done";
  if (attention === "idle") return "idle";
  return "running";
}
