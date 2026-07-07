import type { StudioHostCoreMessage, StudioWebviewCoreMessage } from "../shared/studio/protocol";
import type { RunbookStudioEntity, RunbookStudioPatch, RunbookStudioReferenceData } from "./domain";

export type { RunbookStudioEntity, RunbookStudioFields, RunbookStudioPatch, RunbookStudioReferenceData } from "./domain";

export type RunbookStudioHostMessage =
  StudioHostCoreMessage<RunbookStudioEntity, string, RunbookStudioPatch, RunbookStudioReferenceData>;

export type RunbookStudioWebviewMessage =
  StudioWebviewCoreMessage<RunbookStudioPatch>;
