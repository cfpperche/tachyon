import type { StudioDomainMessage, StudioHostCoreMessage, StudioWebviewCoreMessage } from "../shared/studio/protocol";
import type {
  AgentStudioEntity,
  AgentStudioPatch,
} from "./domain";
import type { AuthorizableCapabilities } from "../../config/agentCapabilityCandidates.js";
import type { AgentOwnershipViewV1, AgentProfileStudioSnapshotV1 } from "../../config/agentProfileStudio";
import type { AgentProfileStudioBundleCreatedResultV1, AgentProfileStudioBundleExportResultV1 } from "../../config/agentProfileStudio";
import type { AgentForgetPlanResultV1 } from "../../config/agentForgetPlan";

export type {
  AgentStudioEntity,
  AgentStudioFields,
  AgentStudioPatch,
} from "./domain";

/** Host -> webview messages this surface actually receives. */
export type AgentStudioHostMessage =
  | StudioHostCoreMessage<AgentStudioEntity, string, AgentStudioPatch>
  | StudioDomainMessage<{ type: "cwd"; value: string }>
  | StudioDomainMessage<{ type: "agentProfileSnapshot"; action: "refresh" | "set-enabled" | "rename" | "set-subagents" | "set-propose-saved-agent-grant"; snapshot: AgentProfileStudioSnapshotV1 }>
  | StudioDomainMessage<{ type: "agentProfileOwnership"; agent: string; ownership: AgentOwnershipViewV1 }>
  /** t-e722ce — the read-only plan (or the refusal that stopped it being computed). */
  | StudioDomainMessage<{ type: "agentProfileForgetPlan"; agent: string; result: AgentForgetPlanResultV1 }>
  | StudioDomainMessage<{ type: "agentProfileForgotten"; agent: string; agentId: string }>
  | StudioDomainMessage<{ type: "agentProfileError"; agent: string; code: string; message: string; conflict: boolean }>
  /**
   * t-746f0f — something the human needs told about an action that SUCCEEDED.
   *
   * Separate from `agentProfileError` because the panel renders that one red and labels the profile
   * degraded. "Authorized — it reaches the running agent at its next launch" is neither a failure nor
   * a refusal; sending it down the error channel would report a working repair as a broken one.
   */
  | StudioDomainMessage<{ type: "agentProfileNotice"; agent: string; code: string; message: string }>
  /** t-5498a6 — the two candidate lists, delivered host → webview. */
  | StudioDomainMessage<{ type: "authorizableCapabilities"; agent: string; capabilities: AuthorizableCapabilities }>
  | StudioDomainMessage<{ type: "agentProfileBundleExport"; result: AgentProfileStudioBundleExportResultV1 }>
  | StudioDomainMessage<{ type: "agentProfileBundleCreated"; result: AgentProfileStudioBundleCreatedResultV1 }>
  | StudioDomainMessage<{ type: "agentProfileBundleError"; agent: string; code: string; message: string; conflict: boolean }>;

/** Webview -> host messages this surface sends. */
export type AgentStudioWebviewMessage =
  | StudioWebviewCoreMessage<AgentStudioPatch>
  | StudioDomainMessage<{ type: "browse" }>
  | StudioDomainMessage<{ type: "authorizeSkill"; agent: string; skillName: string }>
  | StudioDomainMessage<{ type: "authorizePlugin"; agent: string; pluginName: string }>
  | StudioDomainMessage<{ type: "refreshAuthorizableCapabilities"; agent: string }>
  | StudioDomainMessage<{ type: "refreshAgentProfile"; agent: string }>
  | StudioDomainMessage<{ type: "setAgentProfileEnabled"; agent: string; expectedRevision: string; enabled: boolean }>
  | StudioDomainMessage<{ type: "renameAgentProfile"; agent: string; expectedRevision: string; newName: string }>
  | StudioDomainMessage<{ type: "planAgentProfileForget"; agent: string; expectedRevision: string }>
  | StudioDomainMessage<{ type: "forgetAgentProfile"; agent: string; expectedRevision: string; confirmation: string }>
  | StudioDomainMessage<{ type: "setAgentProfileSubagents"; agent: string; expectedRevision: string; subagents: string[] }>
  | StudioDomainMessage<{ type: "exportSavedAgentProfileBundle"; agent: string; expectedRevision: string }>
  | StudioDomainMessage<{ type: "cloneSavedAgentProfileBundle"; agent: string; expectedRevision: string; destinationAgentName: string }>
  | StudioDomainMessage<{ type: "importSavedAgentProfileBundle"; agent: string; destinationAgentName: string; contentBase64: string }>;
