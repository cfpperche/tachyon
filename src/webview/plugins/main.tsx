import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import type { PluginsViewModel } from "../../plugins/viewModel";
import type { ConsentVM } from "../../plugins/consentViewModel";
import { PLUGINS, CONSENT, BUSY, RESULT, readyMessage, confirmMessage, type PluginsHostMessage, type ConfirmPayload } from "./messages";

// spec 250 — the Plugins View webview iframe entry. The host (PluginsPanelManager) gathers the model and
// drives the consent/busy/result flow via postMessage; we render only what arrives. Never imports vscode or
// the engine at runtime (engine boundary) — only the VM TYPES, which esbuild erases.
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

// spec 278 — the ready handshake works in BOTH modes: the real webview signals the vscode host; standalone
// (the dev preview harness) it posts to `window` so the harness injects a fixture deterministically.
const signalReady = (): void => {
  if (vscode) vscode.postMessage(readyMessage());
  else window.postMessage(readyMessage(), "*");
};

export interface Toast { ok: boolean; message: string; }

function Root() {
  const [vm, setVm] = useState<PluginsViewModel | undefined>(undefined);
  const [consent, setConsent] = useState<ConsentVM | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [toast, setToast] = useState<Toast | undefined>(undefined);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as Partial<PluginsHostMessage> & { label?: string; ok?: boolean; message?: string } | undefined;
      if (!d) return;
      if (d.type === PLUGINS && d.vm) { setVm(d.vm as PluginsViewModel); setBusy(undefined); }
      else if (d.type === CONSENT && d.vm) { setConsent(d.vm as ConsentVM); setBusy(undefined); }
      else if (d.type === BUSY) setBusy(d.label ?? "Working…");
      else if (d.type === RESULT) { setToast({ ok: !!d.ok, message: d.message ?? "" }); setBusy(undefined); setConsent(undefined); }
    };
    window.addEventListener("message", onMsg);
    signalReady(); // a (re)loaded webview → ask the host (or the dev harness) to (re)push the VM
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const dispatch = {
    refresh: () => vscode?.postMessage({ type: "refresh" }),
    checkUpdates: () => vscode?.postMessage({ type: "checkUpdates" }),
    checkPluginUpdate: (name: string) => vscode?.postMessage({ type: "checkPluginUpdate", name }),
    install: (spec: string) => vscode?.postMessage({ type: "install", spec }),
    update: (name: string) => vscode?.postMessage({ type: "update", name }),
    reinstall: (name: string) => vscode?.postMessage({ type: "reinstall", name }),
    remove: (name: string) => vscode?.postMessage({ type: "remove", name }),
    reselect: (runtimes: string[]) => vscode?.postMessage({ type: "reselect", runtimes }),
    repair: () => vscode?.postMessage({ type: "repair" }),
    rehydrate: () => vscode?.postMessage({ type: "rehydrate" }),
    confirm: (payload: ConfirmPayload) => vscode?.postMessage(confirmMessage(payload)),
    cancel: () => { setConsent(undefined); vscode?.postMessage({ type: "cancel" }); },
    dismissToast: () => setToast(undefined),
    openConfig: (name: string) => vscode?.postMessage({ type: "openConfig", name }),
    openDocs: (name: string) => vscode?.postMessage({ type: "openDocs", name }),
    installExternal: (externalTool: string, pluginName?: string) => vscode?.postMessage({ type: "installExternal", externalTool, ...(pluginName ? { pluginName } : {}) }),
  };

  return <App vm={vm} consent={consent} busy={busy} toast={toast} dispatch={dispatch} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
