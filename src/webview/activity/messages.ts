/**
 * spec 278 — the SHARED host↔webview message envelope for the Activity view.
 *
 * Pure module (no vscode, no preact — only VM TYPES, erased by esbuild): imported by the host sender
 * (`ActivityPanelManager`), the webview listener (`activity/main.tsx`), AND the dev preview harness
 * (`scripts/webview-preview/routes.ts`). The `type` strings + shapes live here once, so an envelope rename
 * or VM-shape change breaks the BUILD (typecheck), not a silent preview screenshot.
 */

import type { ActivityViewModel } from "../../activity/activityView";
import type { ReadyMessage } from "../shared/ready";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

/**
 * host → webview: the normalized activity model. `prepended` ⇒ older items paged in at the TOP
 * (scroll anchor). `wsHash`/`agent` are the feed's identity (t-610705 Phase C.2, hardening dueto
 * probe-2d90286d) — Control hosts at most ONE active feed at a time (unlike the retired standalone
 * panel's one-Map-slot-per-agent), so a message delayed behind an agent switch must be REJECTABLE
 * by the client, not just trusted because it arrived on the shared channel.
 */
export const ACTIVITY = "activity" as const;
export interface ActivityMessage {
  type: typeof ACTIVITY;
  wsHash: string;
  agent: string;
  vm: ActivityViewModel;
  prepended: boolean;
}
export function activityMessage(wsHash: string, agent: string, vm: ActivityViewModel, prepended = false): ActivityMessage {
  return { type: ACTIVITY, wsHash, agent, vm, prepended };
}

/** host → webview: one image's data URI, delivered once per id on a side channel. Carries the same
 *  feed identity as ActivityMessage, for the same reason. */
export const IMAGE_DATA = "imageData" as const;
export interface ImageDataMessage {
  type: typeof IMAGE_DATA;
  wsHash: string;
  agent: string;
  id: string;
  dataUri: string;
}
export function imageDataMessage(wsHash: string, agent: string, id: string, dataUri: string): ImageDataMessage {
  return { type: IMAGE_DATA, wsHash, agent, id, dataUri };
}

/** the union the Activity webview listens for (host → webview). */
export type ActivityHostMessage = ActivityMessage | ImageDataMessage;

/** webview → host: user requested an external share for one rendered Activity item. */
export const SHARE_EXTERNAL = "shareExternal" as const;
/** webview → host: user requested copying one rendered Activity item to the clipboard. */
export const COPY_SHARE_TEXT = "copyShareText" as const;
/** webview → host: user requested pasting one rendered Activity item into another Tachyon agent. */
export const SHARE_TO_AGENT = "shareToAgent" as const;
export interface ActivityShareMessage {
  type: typeof SHARE_EXTERNAL | typeof COPY_SHARE_TEXT | typeof SHARE_TO_AGENT;
  sequence: number;
  key: string;
}
export function shareExternalMessage(sequence: number, key: string): ActivityShareMessage {
  return { type: SHARE_EXTERNAL, sequence, key };
}
export function copyShareTextMessage(sequence: number, key: string): ActivityShareMessage {
  return { type: COPY_SHARE_TEXT, sequence, key };
}
export function shareToAgentMessage(sequence: number, key: string): ActivityShareMessage {
  return { type: SHARE_TO_AGENT, sequence, key };
}

/** the union the Activity webview posts back to the host. */
export type ActivityWebviewMessage =
  | ReadyMessage
  | { type: "openFile"; path: string }
  | { type: "terminal" }
  | { type: "loadOlder" }
  | ActivityShareMessage;
