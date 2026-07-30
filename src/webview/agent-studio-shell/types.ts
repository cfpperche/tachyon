import type { StudioDomainMessage, StudioHostCoreMessage, StudioWebviewCoreMessage } from "../shared/studio/protocol";
import type {
  AgentEvolutionCandidateDetailMessage,
  AgentEvolutionCandidateSummaryMessage,
  AgentEvolutionSummaryMessage,
  AgentStudioEntity,
  AgentStudioPatch,
  SoulProfileStatusMessage,
} from "./domain";
import type { AgentOwnershipViewV1, AgentProfileStudioSnapshotV1 } from "../../config/agentProfileStudio";
import type { AgentProfileStudioBundleCreatedResultV1, AgentProfileStudioBundleExportResultV1 } from "../../config/agentProfileStudio";

export type {
  AgentEvolutionCandidateDetailMessage,
  AgentEvolutionCandidateSummaryMessage,
  AgentEvolutionLabels,
  AgentEvolutionSummaryMessage,
  AgentStudioEntity,
  AgentStudioFields,
  AgentStudioPatch,
  SoulProfileStatusMessage,
} from "./domain";

/** Host -> webview messages this surface actually receives. */
export type AgentStudioHostMessage =
  | StudioHostCoreMessage<AgentStudioEntity, string, AgentStudioPatch>
  | StudioDomainMessage<{ type: "cwd"; value: string }>
  | StudioDomainMessage<{ type: "soulProfileStatus"; status: SoulProfileStatusMessage }>
  | StudioDomainMessage<{ type: "soulProfileError"; agent: string; code: string; message: string }>
  | StudioDomainMessage<{ type: "evolutionSummary"; summary: AgentEvolutionSummaryMessage }>
  | StudioDomainMessage<{ type: "evolutionCandidates"; agent: string; candidates: AgentEvolutionCandidateSummaryMessage[] }>
  | StudioDomainMessage<{ type: "evolutionCandidateDetail"; agent: string; detail: AgentEvolutionCandidateDetailMessage }>
  | StudioDomainMessage<{ type: "evolutionActionResult"; agent: string; candidateId: string; status: "approved" | "rejected"; activeVersion: number }>
  | StudioDomainMessage<{ type: "evolutionError"; agent: string; code: string; message: string; conflict: boolean }>
  | StudioDomainMessage<{ type: "agentProfileSnapshot"; action: "refresh" | "set-enabled" | "rename" | "set-subagents" | "set-propose-saved-agent-grant"; snapshot: AgentProfileStudioSnapshotV1 }>
  | StudioDomainMessage<{ type: "agentProfileOwnership"; agent: string; ownership: AgentOwnershipViewV1 }>
  | StudioDomainMessage<{ type: "agentProfileForgotten"; agent: string; agentId: string }>
  | StudioDomainMessage<{ type: "agentProfileError"; agent: string; code: string; message: string; conflict: boolean }>
  | StudioDomainMessage<{ type: "agentProfileBundleExport"; result: AgentProfileStudioBundleExportResultV1 }>
  | StudioDomainMessage<{ type: "agentProfileBundleCreated"; result: AgentProfileStudioBundleCreatedResultV1 }>
  | StudioDomainMessage<{ type: "agentProfileBundleError"; agent: string; code: string; message: string; conflict: boolean }>;

/** Webview -> host messages this surface sends. */
export type AgentStudioWebviewMessage =
  | StudioWebviewCoreMessage<AgentStudioPatch>
  | StudioDomainMessage<{ type: "browse" }>
  | StudioDomainMessage<{ type: "createSoul"; agent: string }>
  | StudioDomainMessage<{ type: "importSoul"; agent: string; contentBase64: string }>
  | StudioDomainMessage<{ type: "replaceSoul"; agent: string; contentBase64: string; expectedDigest: string }>
  | StudioDomainMessage<{ type: "openSoul"; agent: string }>
  | StudioDomainMessage<{ type: "refreshSoul"; agent: string }>
  | StudioDomainMessage<{ type: "previewSoul"; agent: string }>
  | StudioDomainMessage<{ type: "adoptSoulProfile"; agent: string; expectedDigest: string }>
  | StudioDomainMessage<{ type: "enableSoul"; agent: string }>
  | StudioDomainMessage<{ type: "disableSoul"; agent: string }>
  | StudioDomainMessage<{ type: "deleteSoulProfile"; agent: string }>
  | StudioDomainMessage<{ type: "refreshEvolution"; agent: string }>
  | StudioDomainMessage<{ type: "loadEvolutionCandidate"; agent: string; candidateId: string }>
  | StudioDomainMessage<{
      type: "approveEvolutionCandidate" | "rejectEvolutionCandidate";
      agent: string;
      candidateId: string;
      expectedActiveVersion: number;
      expectedTargetDigest?: string;
    }>
  | StudioDomainMessage<{ type: "refreshAgentProfile"; agent: string }>
  | StudioDomainMessage<{ type: "setAgentProfileEnabled"; agent: string; expectedRevision: string; enabled: boolean }>
  | StudioDomainMessage<{ type: "renameAgentProfile"; agent: string; expectedRevision: string; newName: string }>
  | StudioDomainMessage<{ type: "forgetAgentProfile"; agent: string; expectedRevision: string; confirmation: string }>
  | StudioDomainMessage<{ type: "setAgentProfileSubagents"; agent: string; expectedRevision: string; subagents: string[] }>
  | StudioDomainMessage<{ type: "exportSavedAgentProfileBundle"; agent: string; expectedRevision: string }>
  | StudioDomainMessage<{ type: "cloneSavedAgentProfileBundle"; agent: string; expectedRevision: string; destinationAgentName: string }>
  | StudioDomainMessage<{ type: "importSavedAgentProfileBundle"; agent: string; destinationAgentName: string; contentBase64: string }>;
