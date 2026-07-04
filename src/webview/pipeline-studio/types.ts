import type { StudioConcurrencyState, StudioRestoreSnapshot } from "../shared/studio/protocol";
import type { PipelineEntity, PipelinePatch, PipelineStage } from "./domain";

export type { PipelineEntity, PipelineFields, PipelinePatch, PipelineStage } from "./domain";

/** Host -> webview messages this surface actually receives (core + its two registered domain messages). */
export type PipelineStudioHostMessage =
  | { type: "load"; entity: PipelineEntity; concurrency: StudioConcurrencyState; saveInFlight?: boolean; studioProtocolVersion: number }
  | { type: "error"; code: string; message: string; blocking: boolean; studioProtocolVersion: number }
  | { type: "restore"; snapshot: StudioRestoreSnapshot<string, PipelinePatch> | null; studioProtocolVersion: number }
  | { type: "stagesImported"; stages: PipelineStage[]; studioProtocolVersion: number };

/** Webview -> host messages this surface sends. */
export type PipelineStudioWebviewMessage =
  | { type: "ready"; studioProtocolVersion: number }
  | { type: "patch"; patch: PipelinePatch; studioProtocolVersion: number }
  | { type: "dirty"; dirty: boolean; studioProtocolVersion: number }
  | { type: "save"; studioProtocolVersion: number }
  | { type: "cancel"; studioProtocolVersion: number }
  | { type: "importStages"; raw: string; studioProtocolVersion: number };
