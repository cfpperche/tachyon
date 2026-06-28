/**
 * spec 280 — the SHARED host↔webview envelope for the Pin Studio view. The discriminated unions already live in
 * `./types` (PinStudioHostMessage / PinStudioWebviewMessage); this adds CONSTRUCTORS at the host's message-creation
 * boundary (the 3 host→webview messages) so a `type`/shape drift breaks the build, and re-exports the types for the
 * host + webview + harness. The webview's rich inbound action set stays a typed union (no per-action constructors —
 * the dueto's "boundary shape + exhaustiveness, not constructor maximalism").
 */

import type { PinStudioVM, PinStudioAttachmentVM, PinStudioHostMessage, PinStudioWebviewMessage } from "./types";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";
export type { PinStudioHostMessage, PinStudioWebviewMessage } from "./types";

export const pinStudioMessage = (vm: PinStudioVM): PinStudioHostMessage => ({ type: "pinStudio", vm });
export const attachmentStoredMessage = (attachment: PinStudioAttachmentVM): PinStudioHostMessage => ({ type: "attachmentStored", attachment });
export const errorMessage = (message: string): PinStudioHostMessage => ({ type: "error", message });

/** the webview→host action union (typed at the `dispatch.post` boundary). */
export type PinStudioAction = PinStudioWebviewMessage;
