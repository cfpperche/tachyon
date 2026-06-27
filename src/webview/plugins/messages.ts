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
