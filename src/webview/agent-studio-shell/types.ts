import type { StudioDomainMessage, StudioHostCoreMessage, StudioWebviewCoreMessage } from "../shared/studio/protocol";
import type {
  AgentEvolutionCandidateDetailMessage,
  AgentEvolutionCandidateSummaryMessage,
  AgentEvolutionSummaryMessage,
  AgentStudioEntity,
  AgentStudioPatch,
  SoulProfileStatusMessage,
} from "./domain";

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
  | StudioDomainMessage<{ type: "evolutionError"; agent: string; code: string; message: string; conflict: boolean }>;

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
    }>;
