import type { StudioDomainMessage, StudioHostCoreMessage, StudioWebviewCoreMessage } from "../shared/studio/protocol";
import type { TerminalStudioEntity, TerminalStudioPatch, TerminalStudioReferenceData } from "./domain";

export type { TerminalStudioEntity, TerminalStudioFields, TerminalStudioPatch, TerminalStudioReferenceData } from "./domain";

export type TerminalStudioHostMessage =
  | StudioHostCoreMessage<TerminalStudioEntity, string, TerminalStudioPatch, TerminalStudioReferenceData>
  | StudioDomainMessage<{ type: "cwd"; value: string }>;

export type TerminalStudioWebviewMessage =
  | StudioWebviewCoreMessage<TerminalStudioPatch>
  | StudioDomainMessage<{ type: "browse" }>;
