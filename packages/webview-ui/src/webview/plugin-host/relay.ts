import { READY, readyMessage } from "../shared/ready.js";
import { PLUGIN_FLEET_PROJECTION } from "../../plugins/ui/messages.js";
import { assembleUntrustedSrcdoc, escapeHtmlAttr } from "@tachyon/shared/webview/shared/untrustedSrcdoc.js";

export const PLUGIN_UI_ACTION = "pluginUiAction" as const;
export const PLUGIN_UI_ACTION_RESULT = "pluginUiActionResult" as const;
export const SELECT_PLUGIN_SIDEBAR_SURFACE = "selectPluginSidebarSurface" as const;

export interface PluginHostSibling {
  key: string;
  title: string;
}

export interface PluginHostBootstrap {
  pluginId: string;
  viewId: string;
  title: string;
  pluginHtml: string;
  /** Stable host key for this surface; required when siblings are present so the tab can name it. */
  key?: string;
  /** First-party sidebar tabs when this host is showing more than one sidebar surface. */
  siblings?: PluginHostSibling[];
}

export interface PluginUiActionRelayMessage {
  type: typeof PLUGIN_UI_ACTION;
  id?: unknown;
  action?: unknown;
  handle?: unknown;
  generation?: unknown;
  userGesture?: unknown;
}

const MAX_RELAY_MESSAGE_BYTES = 64 * 1024;

export function assemblePluginSrcdoc(pluginHtml: string, nonce: string): string {
  return assembleUntrustedSrcdoc(pluginHtml, { mode: "plugin", nonce });
}

export function isRelayActionMessage(value: unknown): value is PluginUiActionRelayMessage {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === PLUGIN_UI_ACTION;
}

export function messageTooLarge(value: unknown): boolean {
  try {
    return JSON.stringify(value).length > MAX_RELAY_MESSAGE_BYTES;
  } catch {
    return true;
  }
}

export { escapeHtmlAttr };

export function hostReadyMessage(): { type: typeof READY } {
  return readyMessage();
}

/** First-party sidebar tabs only when the host sent more than one sibling. */
export function sidebarTabModel(boot: PluginHostBootstrap): Array<{ key: string; title: string; selected: boolean }> | undefined {
  if (!boot.siblings || boot.siblings.length <= 1) return undefined;
  const active = boot.key ?? `${boot.pluginId}:${boot.viewId}`;
  return boot.siblings.map((s) => ({ key: s.key, title: s.title, selected: s.key === active }));
}

export function isProjectionMessage(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === PLUGIN_FLEET_PROJECTION;
}
