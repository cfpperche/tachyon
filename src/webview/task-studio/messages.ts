import { envelope } from "../shared/studio/protocol.js";
import type { RichDocAttachmentVM } from "../rich-doc/types.js";
import type { TaskPatch } from "./domain.js";

export { readyMessage, READY } from "../shared/ready.js";
export type { TaskStudioHostMessage, TaskStudioWebviewMessage } from "./types.js";

export const patchMessage = (patch: TaskPatch) => envelope({ type: "patch" as const, patch });
export const dirtyMessage = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
export const saveMessage = () => envelope({ type: "save" as const });
export const cancelMessage = () => envelope({ type: "cancel" as const });
export const importImageMessage = () => envelope({ type: "importImage" as const });
export const attachImageMessage = (input: { mediaType: string; name?: string; source: "paste" | "drop"; dataBase64: string }) =>
  envelope({ type: "attachImage" as const, ...input });
export const storeSketchMessage = (input: {
  attachmentId?: string;
  name?: string;
  source: "blank" | "annotate-image";
  baseImageAttachmentId?: string;
  sceneJson: string;
  previewBase64: string;
}) => envelope({ type: "storeSketch" as const, ...input });
export const attachmentStoredMessage = (attachment: RichDocAttachmentVM) => envelope({ type: "attachmentStored" as const, attachment });
