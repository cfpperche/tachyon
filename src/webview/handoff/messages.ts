/**
 * spec 280 — the SHARED host↔webview envelope for the Handoff view (`preact-live` read-only-ish: the host
 * re-posts the snapshot on refresh; the webview posts ready/refresh/openFile). Imported by the host
 * (HandoffPanelManager), the webview (handoff/main.tsx), and the dev preview harness.
 */

import type { HandoffViewModel } from "./handoffViewModel";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

/** host → webview: the assembled handoff snapshot (re-posted on refresh / the ready handshake). */
export const HANDOFF = "handoff" as const;
export interface HandoffMessage {
  type: typeof HANDOFF;
  vm: HandoffViewModel;
}
export function handoffMessage(vm: HandoffViewModel): HandoffMessage {
  return { type: HANDOFF, vm };
}

export type HandoffHostMessage = HandoffMessage;

/** webview → host actions. */
export type HandoffAction = { type: "ready" } | { type: "refresh" } | { type: "openFile" };
export const refreshAction = (): HandoffAction => ({ type: "refresh" });
export const openFileAction = (): HandoffAction => ({ type: "openFile" });
