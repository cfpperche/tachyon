import { envelope } from "../shared/studio/protocol.js";
import type { RichDocAttachmentVM } from "../rich-doc/types.js";
import type { TaskPatch } from "./domain.js";

export { READY } from "../shared/ready.js";
export type { TaskStudioHostMessage, TaskStudioWebviewMessage } from "./types.js";

// t-610705 (Phase D, D2) — routeKey/mountNonce identify WHICH Control-hosted binding this ready is
// for (the retired studioHost.ts mount handshake) — same shape every other migrated shell's
// messages.ts declares; the shared shared/ready.ts helper predates the mount handshake and
// doesn't carry it.
//
// t-337cdf — the Control host is DELETED. The standalone path (`mountSingleModeStudio`) still sends
// these, but with the constants `"standalone-studio"` / `"single-mode"`, so today they never
// discriminate anything. Left in place rather than removed here: this is a wire-protocol field with
// a reader on the other side, and dropping it belongs with dissolving the remaining Control-era
// model contract (t-5a0c1c), not with deleting the host.
export const readyMessage = (mount?: { routeKey: string; mountNonce: string }) =>
  envelope({ type: "ready" as const, ...(mount ? { routeKey: mount.routeKey, mountNonce: mount.mountNonce } : {}) });
export const patchMessage = (patch: TaskPatch, editRevision?: number) =>
  envelope({ type: "patch" as const, patch, ...(editRevision !== undefined ? { editRevision } : {}) });
export const dirtyMessage = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
// t-610705 (Phase D, D2) — "save" carries NO payload on the wire (protocol.ts's core StudioWebviewCoreMessage
// shape) — the host saves whatever `b.patch` the last "patch" message set, same as every other migrated
// studio. The old standalone panel's `saveMessage(patch)` predates this shared protocol; App.tsx now posts a
// fresh click-time patchMessage() immediately before a bare saveMessage() instead.
export const saveMessage = () => envelope({ type: "save" as const });
export const cancelMessage = () => envelope({ type: "cancel" as const });
export const importPrototypeMessage = () => envelope({ type: "importPrototype" as const });
export const attachImageMessage = (input: { mediaType: string; name?: string; source: "paste" | "drop" | "import"; dataBase64: string }) =>
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
