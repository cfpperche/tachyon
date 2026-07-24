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

/**
 * host → webview: candidate agents for "Send to agent" (t-a983e1).
 * Webview already owns the product QuickPicker; host listed targets and posts this one-shot.
 */
export const SHARE_AGENT_TARGETS = "shareAgentTargets" as const;
export interface ShareAgentTargetRow {
  name: string;
  description: string;
}
export interface ShareAgentTargetsMessage {
  type: typeof SHARE_AGENT_TARGETS;
  sequence: number;
  key: string;
  targets: ShareAgentTargetRow[];
}
export function shareAgentTargetsMessage(
  sequence: number,
  key: string,
  targets: ShareAgentTargetRow[],
): ShareAgentTargetsMessage {
  return { type: SHARE_AGENT_TARGETS, sequence, key, targets };
}

/** the union the Activity webview listens for (host → webview). */
export type ActivityHostMessage = ActivityMessage | ImageDataMessage | ShareAgentTargetsMessage;

/** External share channel — chosen in-webview QuickPicker (not vscode.showQuickPick). */
export type ExternalShareChannel = "email" | "whatsapp";

/** webview → host: user requested an external share for one rendered Activity item. */
export const SHARE_EXTERNAL = "shareExternal" as const;
/** webview → host: user requested copying one rendered Activity item to the clipboard. */
export const COPY_SHARE_TEXT = "copyShareText" as const;
/**
 * webview → host: paste Activity item into another agent.
 * - without `toAgent`: prepare — host lists running targets and posts SHARE_AGENT_TARGETS
 * - with `toAgent`: execute — host confirms + pastes (revalidates still-live)
 */
export const SHARE_TO_AGENT = "shareToAgent" as const;
export interface ActivityShareMessage {
  type: typeof SHARE_EXTERNAL | typeof COPY_SHARE_TEXT | typeof SHARE_TO_AGENT;
  sequence: number;
  key: string;
  /** Required for SHARE_EXTERNAL (webview QuickPicker already chose). */
  channel?: ExternalShareChannel;
  /** Optional on SHARE_TO_AGENT: absent = list targets; present = execute paste. */
  toAgent?: string;
}
export function shareExternalMessage(
  sequence: number,
  key: string,
  channel: ExternalShareChannel,
): ActivityShareMessage {
  return { type: SHARE_EXTERNAL, sequence, key, channel };
}
export function copyShareTextMessage(sequence: number, key: string): ActivityShareMessage {
  return { type: COPY_SHARE_TEXT, sequence, key };
}
export function shareToAgentMessage(sequence: number, key: string, toAgent?: string): ActivityShareMessage {
  return {
    type: SHARE_TO_AGENT,
    sequence,
    key,
    ...(toAgent ? { toAgent } : {}),
  };
}

/** the union the Activity webview posts back to the host. */
export type ActivityWebviewMessage =
  | ReadyMessage
  | { type: "openFile"; path: string }
  | { type: "terminal" }
  | { type: "loadOlder" }
  | ActivityShareMessage;
