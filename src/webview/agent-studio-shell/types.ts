import type { StudioDomainMessage, StudioHostCoreMessage, StudioWebviewCoreMessage } from "../shared/studio/protocol";
import type { AgentStudioEntity, AgentStudioPatch, SoulProfileStatusMessage } from "./domain";

export type { AgentStudioEntity, AgentStudioFields, AgentStudioPatch, SoulProfileStatusMessage } from "./domain";

/** Host -> webview messages this surface actually receives. */
export type AgentStudioHostMessage =
  | StudioHostCoreMessage<AgentStudioEntity, string, AgentStudioPatch>
  | StudioDomainMessage<{ type: "cwd"; value: string }>
  | StudioDomainMessage<{ type: "soulProfileStatus"; status: SoulProfileStatusMessage }>
  | StudioDomainMessage<{ type: "soulProfileError"; agent: string; code: string; message: string }>;

/** Webview -> host messages this surface sends. */
export type AgentStudioWebviewMessage =
  | StudioWebviewCoreMessage<AgentStudioPatch>
  | StudioDomainMessage<{ type: "browse" }>
  | StudioDomainMessage<{ type: "createSoul"; agent: string }>
  | StudioDomainMessage<{ type: "importSoul"; agent: string }>
  | StudioDomainMessage<{ type: "openSoul"; agent: string }>
  | StudioDomainMessage<{ type: "refreshSoul"; agent: string }>
  | StudioDomainMessage<{ type: "previewSoul"; agent: string }>
  | StudioDomainMessage<{ type: "adoptSoulProfile"; agent: string; expectedDigest: string }>
  | StudioDomainMessage<{ type: "enableSoul"; agent: string }>
  | StudioDomainMessage<{ type: "disableSoul"; agent: string }>;
