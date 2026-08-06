/**
 * spec 280 — the SHARED host↔webview envelope for the Pin Studio view. The discriminated unions already live in
 * `./types` (PinStudioHostMessage / PinStudioWebviewMessage); this adds CONSTRUCTORS at the host's message-creation
 * boundary (the 3 host→webview messages) so a `type`/shape drift breaks the build, and re-exports the types for the
 * host + webview + harness. The webview's rich inbound action set stays a typed union (no per-action constructors —
 * the dueto's "boundary shape + exhaustiveness, not constructor maximalism").
 */

import { envelope } from "../shared/studio/protocol.js";
import type { PinStudioAttachmentVM, PinStudioHostMessage, PinStudioWebviewMessage } from "./types";
import type { PinPatch } from "./domain.js";

export { READY } from "../shared/ready";
export type { PinStudioHostMessage, PinStudioWebviewMessage } from "./types";

// t-610705 (Phase D, D3) — routeKey/mountNonce identify WHICH Control-hosted binding this ready is
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
export const patchMessage = (patch: PinPatch) => envelope({ type: "patch" as const, patch });
export const dirtyMessage = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
// t-610705 (Phase D, D3) — "save" carries NO payload on the wire (protocol.ts's core
// StudioWebviewCoreMessage shape), same as every other migrated studio — the host saves whatever
// `b.patch` the last "patch" message set. The old standalone panel's `saveMessage(patch)` predates
// this shared protocol.
export const saveMessage = () => envelope({ type: "save" as const });
export const cancelMessage = () => envelope({ type: "cancel" as const });
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
export const attachmentStoredMessage = (attachment: PinStudioAttachmentVM): PinStudioHostMessage => envelope({ type: "attachmentStored" as const, attachment });

/** the webview→host action union (typed at the `dispatch.post` boundary). */
export type PinStudioAction = PinStudioWebviewMessage;
