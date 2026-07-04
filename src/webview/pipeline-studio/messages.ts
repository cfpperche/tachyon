import { envelope } from "../shared/studio/protocol";
import type { PipelinePatch, PipelineStage, PipelineStudioWebviewMessage } from "./types";

export { readyMessage, READY } from "../shared/ready";

export const patchMessage = (patch: PipelinePatch) => envelope({ type: "patch" as const, patch });
export const dirtyMessage = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
export const saveMessage = () => envelope({ type: "save" as const });
export const cancelMessage = () => envelope({ type: "cancel" as const });
export const importStagesMessage = (raw: string) => envelope({ type: "importStages" as const, raw });

export type { PipelineStudioWebviewMessage };
export const stagesImportedMessage = (stages: PipelineStage[]) => envelope({ type: "stagesImported" as const, stages });
