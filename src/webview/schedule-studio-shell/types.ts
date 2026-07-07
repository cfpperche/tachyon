import type { StudioHostCoreMessage, StudioWebviewCoreMessage } from "../shared/studio/protocol";
import type { ScheduleStudioEntity, ScheduleStudioPatch, ScheduleStudioReferenceData } from "./domain";

export type { ScheduleStudioEntity, ScheduleStudioFields, ScheduleStudioPatch, ScheduleStudioReferenceData } from "./domain";

export type ScheduleStudioHostMessage =
  StudioHostCoreMessage<ScheduleStudioEntity, string, ScheduleStudioPatch, ScheduleStudioReferenceData>;

export type ScheduleStudioWebviewMessage =
  StudioWebviewCoreMessage<ScheduleStudioPatch>;
