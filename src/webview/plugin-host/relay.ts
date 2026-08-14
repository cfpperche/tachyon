import { READY, readyMessage } from "../shared/ready.js";
import { PLUGIN_FLEET_PROJECTION } from "../../plugins/ui/messages.js";
import { assembleUntrustedSrcdoc, escapeHtmlAttr } from "@tachyon/shared/webview/shared/untrustedSrcdoc.js";

export const PLUGIN_UI_ACTION = "pluginUiAction" as const;
export const PLUGIN_UI_ACTION_RESULT = "pluginUiActionResult" as const;

export interface PluginHostBootstrap {
  pluginId: string;
  viewId: string;
  title: string;
  pluginHtml: string;
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

export function isProjectionMessage(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === PLUGIN_FLEET_PROJECTION;
}
