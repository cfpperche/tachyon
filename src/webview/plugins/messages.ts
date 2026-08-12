/**
 * spec 278 — the SHARED host↔webview message envelope for the Plugins view.
 *
 * Pure module (no vscode, no preact — only VM TYPES, which esbuild erases): imported by the host sender
 * (`PluginsPanelManager`), the webview listener (`plugins/main.tsx`), AND the dev preview harness
 * (`scripts/webview-preview/routes.ts`). The `type` strings + message shapes live here ONCE, so an
 * envelope rename or VM-shape change breaks the BUILD (typecheck), not a silent preview screenshot.
 */

import type { PluginsViewModel } from "../../plugins/viewModel";
import type { ConsentVM } from "../../plugins/consentViewModel";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

/** host → webview: the installed-plugins model (the main view). */
export const PLUGINS = "plugins" as const;
export interface PluginsMessage {
  type: typeof PLUGINS;
  vm: PluginsViewModel;
}
export function pluginsMessage(vm: PluginsViewModel): PluginsMessage {
  return { type: PLUGINS, vm };
}

/** host → webview: open the consent drawer for a pending install/update. */
export const CONSENT = "consent" as const;
export interface ConsentMessage {
  type: typeof CONSENT;
  vm: ConsentVM;
}
export function consentMessage(vm: ConsentVM): ConsentMessage {
  return { type: CONSENT, vm };
}

/** host → webview: a long op is running (drawer/list lock + spinner label). */
export const BUSY = "busy" as const;
export interface BusyMessage {
  type: typeof BUSY;
  label: string;
}
export function busyMessage(label: string): BusyMessage {
  return { type: BUSY, label };
}

/** host → webview: an op finished (toast). */
export const RESULT = "result" as const;
export interface ResultMessage {
  type: typeof RESULT;
  ok: boolean;
  message: string;
}
export function resultMessage(ok: boolean, message: string): ResultMessage {
  return { type: RESULT, ok, message };
}

/** the union the Plugins webview listens for (host → webview). */
export type PluginsHostMessage = PluginsMessage | ConsentMessage | BusyMessage | ResultMessage;

/**
 * SDD 485 D2 — webview → host: "re-read the model, nothing has been asked for". The app's own 3s timer,
 * which is the timer CONTROL used to own: inside Control the plugins model was re-posted as a side effect
 * of `sendSectionModule()` running every three seconds for whatever section was active.
 *
 * It is a SEPARATE word from `refresh` on purpose, and the separation is the product behaviour rather than
 * taste. `refresh` is the human pressing the Refresh button, and the host answers it by DROPPING every
 * update check it has found (`io.setChecks({})`) — that is what the button means. A poll that shared the
 * word would run that drop twenty times a minute and a just-found "update available" badge would vanish
 * within three seconds: t-0fc9ee's bug exactly, arriving by a new road. So the poll asks for a re-gather
 * and nothing else, and it is the message `pluginsRefreshKind` claims for the visibility gate.
 */
export const POLL = "poll" as const;
export interface PollActionMessage {
  type: typeof POLL;
}
export function pollAction(): PollActionMessage {
  return { type: POLL };
}

export interface ConfirmPayload {
  token: string;
  skillDecisions?: Record<string, "keep" | "replace">;
  mcpDecisions?: Record<string, "keep" | "replace">;
  mcpConfirmed?: boolean;
  gitHookConfirmed?: boolean;
  toolConfirmed?: boolean;
  dataConfirmed?: boolean;
  viewConfirmed?: boolean;
  fleetReadConfirmed?: boolean;
  actionConfirmed?: Record<string, boolean>;
}

/** webview -> host: apply the currently-open consent drawer, echoing every required acknowledgement. */
export interface ConfirmActionMessage extends ConfirmPayload {
  type: "confirm";
}
export function confirmMessage(payload: ConfirmPayload): ConfirmActionMessage {
  return { type: "confirm", ...payload };
}

/** spec 280 — the webview→host action type union (the Plugins view's inbound messages). Typing the host's
 *  InboundMsg.type against this makes a typo'd `case "…"` a compile error (the typed-union convention). */
export type PluginsActionType =
  | "ready" | "refresh" | "poll" | "checkUpdates" | "checkPluginUpdate" | "install" | "update" | "reinstall" | "remove"
  | "reselect" | "repair" | "rehydrate" | "confirm" | "cancel" | "openConfig" | "openDocs" | "installExternal"
  | "applyMcp" | "unapplyMcp" | "applyContribution" | "unapplyContribution";

/** t-d23f93 — the result-toast shape (moved from the retired standalone bootstrap main.tsx). */
export interface Toast { ok: boolean; message: string; }
