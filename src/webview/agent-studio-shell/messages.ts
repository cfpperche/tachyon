import { envelope } from "../shared/studio/protocol";
import type { AgentStudioPatch } from "./domain";

export { readyMessage, READY } from "../shared/ready";

export const patchMessage = (patch: AgentStudioPatch) => envelope({ type: "patch" as const, patch });
export const dirtyMessage = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
export const saveMessage = () => envelope({ type: "save" as const });
export const cancelMessage = () => envelope({ type: "cancel" as const });
export const browseMessage = () => envelope({ type: "browse" as const });
