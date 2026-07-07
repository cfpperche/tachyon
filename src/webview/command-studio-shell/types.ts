import type { StudioDomainMessage, StudioHostCoreMessage, StudioWebviewCoreMessage } from "../shared/studio/protocol";
import type { CommandStudioEntity, CommandStudioPatch, CommandStudioReferenceData } from "./domain";

export type { CommandStudioEntity, CommandStudioFields, CommandStudioPatch, CommandStudioReferenceData } from "./domain";

export type CommandStudioHostMessage =
  | StudioHostCoreMessage<CommandStudioEntity, string, CommandStudioPatch, CommandStudioReferenceData>
  | StudioDomainMessage<{ type: "cwd"; value: string }>;

export type CommandStudioWebviewMessage =
  | StudioWebviewCoreMessage<CommandStudioPatch>
  | StudioDomainMessage<{ type: "browse" }>;
