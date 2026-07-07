import { envelope } from "../shared/studio/protocol";
import type { RunbookStudioPatch } from "./domain";

export const readyMessage = () => envelope({ type: "ready" as const });
export const patchMessage = (patch: RunbookStudioPatch) => envelope({ type: "patch" as const, patch });
export const dirtyMessage = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
export const saveMessage = () => envelope({ type: "save" as const });
export const cancelMessage = () => envelope({ type: "cancel" as const });
