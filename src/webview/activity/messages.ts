/**
 * spec 278 — the SHARED host↔webview message envelope for the Activity view.
 *
 * Pure module (no vscode, no preact — only VM TYPES, erased by esbuild): imported by the host sender
 * (`ActivityPanelManager`), the webview listener (`activity/main.tsx`), AND the dev preview harness
 * (`scripts/webview-preview/routes.ts`). The `type` strings + shapes live here once, so an envelope rename
 * or VM-shape change breaks the BUILD (typecheck), not a silent preview screenshot.
 */

import type { ActivityViewModel } from "../../activity/activityView";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

/** host → webview: the normalized activity model. `prepended` ⇒ older items paged in at the TOP (scroll anchor). */
export const ACTIVITY = "activity" as const;
export interface ActivityMessage {
  type: typeof ACTIVITY;
  vm: ActivityViewModel;
  prepended: boolean;
}
export function activityMessage(vm: ActivityViewModel, prepended = false): ActivityMessage {
  return { type: ACTIVITY, vm, prepended };
}

/** host → webview: one image's data URI, delivered once per id on a side channel. */
export const IMAGE_DATA = "imageData" as const;
export interface ImageDataMessage {
  type: typeof IMAGE_DATA;
  id: string;
  dataUri: string;
}
export function imageDataMessage(id: string, dataUri: string): ImageDataMessage {
  return { type: IMAGE_DATA, id, dataUri };
}

/** the union the Activity webview listens for (host → webview). */
export type ActivityHostMessage = ActivityMessage | ImageDataMessage;
