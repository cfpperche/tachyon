import { assemblePluginSrcdoc, hostReadyMessage, isProjectionMessage, isRelayActionMessage, messageTooLarge, PLUGIN_UI_ACTION_RESULT, SELECT_PLUGIN_SIDEBAR_SURFACE, sidebarTabModel, type PluginHostBootstrap } from "./relay.js";

declare const acquireVsCodeApi: undefined | (() => { postMessage(message: unknown): void });

declare global {
  interface Window {
    __tachyonPluginHost?: PluginHostBootstrap;
  }
}

const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage: (message: unknown) => window.parent.postMessage(message, "*") };
const boot = window.__tachyonPluginHost;
const root: HTMLElement = document.getElementById("root")!;
const relayNonce = document.currentScript instanceof HTMLScriptElement ? document.currentScript.nonce as string : "";

let frame: HTMLIFrameElement | undefined;

if (!root) {
  throw new Error("missing plugin host root");
}

if (!boot) {
  renderEmpty("No plugin surface is registered.");
} else {
  mountPluginFrame(boot);
  vscode.postMessage(hostReadyMessage());
}

window.addEventListener("message", (event) => {
  if (event.source === window && isProjectionMessage(event.data)) return;
  if (frame && event.source === frame.contentWindow) {
    handlePluginMessage(event.data);
    return;
  }
  if (isProjectionMessage(event.data)) {
    frame?.contentWindow?.postMessage(event.data, "*");
  }
});

function mountPluginFrame(state: PluginHostBootstrap): void {
  root.replaceChildren();
  const tabs = sidebarTabModel(state);
  if (tabs) {
    root.className = "plugin-host-root has-tabs";
    root.append(renderTabs(tabs));
  } else {
    root.className = "plugin-host-root";
  }
  const iframe = document.createElement("iframe");
  iframe.title = state.title;
  iframe.className = "plugin-host-frame";
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.srcdoc = assemblePluginSrcdoc(state.pluginHtml, relayNonce);
  root.append(iframe);
  frame = iframe;
}

function renderTabs(tabs: Array<{ key: string; title: string; selected: boolean }>): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "ds-tabs";
  bar.setAttribute("role", "tablist");
  for (const tab of tabs) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", tab.selected ? "true" : "false");
    button.className = tab.selected ? "ds-tab active" : "ds-tab";
    button.textContent = tab.title;
    button.addEventListener("click", () => {
      if (tab.selected) return;
      vscode.postMessage({ type: SELECT_PLUGIN_SIDEBAR_SURFACE, key: tab.key });
    });
    bar.append(button);
  }
  return bar;
}

function handlePluginMessage(message: unknown): void {
  if (messageTooLarge(message)) {
    postActionResult(undefined, { ok: false, code: "message_too_large", reason: "Plugin message exceeds relay limit." });
    return;
  }
  if (!isRelayActionMessage(message)) return;
  vscode.postMessage({
    ...message,
    userGesture: message.userGesture === true && navigator.userActivation.isActive === true,
  });
}

function postActionResult(id: unknown, result: unknown): void {
  frame?.contentWindow?.postMessage({ type: PLUGIN_UI_ACTION_RESULT, id, result }, "*");
}

window.addEventListener("message", (event) => {
  const data = event.data as { type?: unknown; id?: unknown; result?: unknown };
  if (data?.type === PLUGIN_UI_ACTION_RESULT) postActionResult(data.id, data.result);
});

function renderEmpty(message: string): void {
  root.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "plugin-host-empty";
  empty.textContent = message;
  root.append(empty);
}
