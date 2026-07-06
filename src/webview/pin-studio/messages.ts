/**
 * spec 280 — the SHARED host↔webview envelope for the Pin Studio view. The discriminated unions already live in
 * `./types` (PinStudioHostMessage / PinStudioWebviewMessage); this adds CONSTRUCTORS at the host's message-creation
 * boundary (the 3 host→webview messages) so a `type`/shape drift breaks the build, and re-exports the types for the
 * host + webview + harness. The webview's rich inbound action set stays a typed union (no per-action constructors —
 * the dueto's "boundary shape + exhaustiveness, not constructor maximalism").
 */

import { envelope } from "../shared/studio/protocol.js";
import type { PinStudioAttachmentVM, PinStudioHostMessage, PinStudioVM, PinStudioWebviewMessage } from "./types";
import type { PinPatch } from "./domain.js";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";
export type { PinStudioHostMessage, PinStudioWebviewMessage } from "./types";

export const patchMessage = (patch: PinPatch) => envelope({ type: "patch" as const, patch });
export const dirtyMessage = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
export const saveMessage = (patch?: PinPatch) => envelope({ type: "save" as const, ...(patch !== undefined ? { patch } : {}) });
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
export const attachmentStoredMessage = (attachment: PinStudioAttachmentVM): PinStudioHostMessage => envelope({ type: "attachmentStored" as const, attachment });
export const pinStudioMessage = (vm: PinStudioVM): PinStudioHostMessage => envelope({
  type: "load" as const,
  entity: {
    workspaceHash: vm.workspaceHash,
    folder: vm.folder,
    ...(vm.pinId ? { pinId: vm.pinId } : {}),
    title: vm.title,
    tags: vm.tags,
    doc: vm.doc,
    attachments: vm.attachments,
  },
  concurrency: { kind: "none" as const },
});

/** the webview→host action union (typed at the `dispatch.post` boundary). */
export type PinStudioAction = PinStudioWebviewMessage;
