import { READY, readyMessage } from "../shared/ready.js";
import { PLUGIN_FLEET_PROJECTION } from "../../plugins/ui/messages.js";

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

const CSP_META_RE = /<meta\b(?=[^>]*http-equiv\s*=\s*(?:"content-security-policy"|'content-security-policy'|content-security-policy))[^>]*>/gi;
const HEAD_OPEN_RE = /<head\b[^>]*>/i;
const SCRIPT_OPEN_RE = /<script\b(?![^>]*\bsrc\s*=)(?![^>]*\bnonce\s*=)([^>]*)>/gi;
const MAX_RELAY_MESSAGE_BYTES = 64 * 1024;

export function assemblePluginSrcdoc(pluginHtml: string, nonce: string): string {
  const csp =
    "default-src 'none'; " +
    "img-src data:; " +
    "style-src 'unsafe-inline'; " +
    `script-src 'nonce-${escapeHtmlAttr(nonce)}'; ` +
    "connect-src 'none'; " +
    "base-uri 'none'; " +
    "form-action 'none'; " +
    "frame-src 'none'; " +
    "worker-src 'none';";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const withoutAuthorCsp = pluginHtml.replace(CSP_META_RE, "");
  const stamped = withoutAuthorCsp.replace(SCRIPT_OPEN_RE, `<script nonce="${escapeHtmlAttr(nonce)}"$1>`);
  if (HEAD_OPEN_RE.test(stamped)) return stamped.replace(HEAD_OPEN_RE, (m) => `${m}\n${meta}`);
  return `<!doctype html><html><head>${meta}</head><body>${stamped}</body></html>`;
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

export function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function hostReadyMessage(): { type: typeof READY } {
  return readyMessage();
}

export function isProjectionMessage(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === PLUGIN_FLEET_PROJECTION;
}

