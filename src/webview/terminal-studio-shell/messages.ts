import { envelope } from "../shared/studio/protocol";
import type { TerminalStudioPatch } from "./domain";

export const readyMessage = () => envelope({ type: "ready" as const });
export const patchMessage = (patch: TerminalStudioPatch) => envelope({ type: "patch" as const, patch });
export const dirtyMessage = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
export const saveMessage = () => envelope({ type: "save" as const });
export const cancelMessage = () => envelope({ type: "cancel" as const });
export const browseMessage = () => envelope({ type: "browse" as const });
