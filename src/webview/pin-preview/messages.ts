/**
 * spec 279 — the host→webview envelope for the Pin Preview view (`preact-static`: the host posts the VM once
 * after the ready handshake; no inbound actions). Imported by the host (SidebarPrototype.previewPin), the
 * webview (pin-preview/main.tsx), and the dev preview harness.
 *
 * SECURITY: pin content is USER text. The webview renders it via preact (escapes by default) as TEXT/structured
 * components — never innerHTML — under a strict nonce'd CSP. That's what makes flipping enableScripts on safe.
 */

import type { PinPreviewVM } from "../../sidebar/types";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export const PIN_PREVIEW = "pinPreview" as const;
export interface PinPreviewMessage {
  type: typeof PIN_PREVIEW;
  vm: PinPreviewVM;
}
export function pinPreviewMessage(vm: PinPreviewVM): PinPreviewMessage {
  return { type: PIN_PREVIEW, vm };
}

export type PinPreviewHostMessage = PinPreviewMessage;
