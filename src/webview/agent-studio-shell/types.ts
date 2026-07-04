import type { StudioDomainMessage, StudioHostCoreMessage, StudioWebviewCoreMessage } from "../shared/studio/protocol";
import type { AgentStudioEntity, AgentStudioPatch } from "./domain";

export type { AgentStudioEntity, AgentStudioFields, AgentStudioPatch } from "./domain";

/** Host -> webview messages this surface actually receives (core + its one registered domain reply, `cwd` —
 *  the `browse` native-picker round trip's answer). */
export type AgentStudioHostMessage =
  | StudioHostCoreMessage<AgentStudioEntity, string, AgentStudioPatch>
  | StudioDomainMessage<{ type: "cwd"; value: string }>;

/** Webview -> host messages this surface sends. */
export type AgentStudioWebviewMessage =
  | StudioWebviewCoreMessage<AgentStudioPatch>
  | StudioDomainMessage<{ type: "browse" }>;
