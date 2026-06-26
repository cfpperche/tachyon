import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import type { PluginsViewModel } from "../../plugins/viewModel";
import type { ConsentVM } from "../../plugins/consentViewModel";

// spec 250 — the Plugins View webview iframe entry. The host (PluginsPanelManager) gathers the model and
// drives the consent/busy/result flow via postMessage; we render only what arrives. Never imports vscode or
// the engine at runtime (engine boundary) — only the VM TYPES, which esbuild erases.
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

export interface Toast { ok: boolean; message: string; }

function Root() {
  const [vm, setVm] = useState<PluginsViewModel | undefined>(undefined);
  const [consent, setConsent] = useState<ConsentVM | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [toast, setToast] = useState<Toast | undefined>(undefined);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; vm?: PluginsViewModel | ConsentVM; label?: string; ok?: boolean; message?: string } | undefined;
      if (!d) return;
      if (d.type === "plugins" && d.vm) { setVm(d.vm as PluginsViewModel); setBusy(undefined); }
      else if (d.type === "consent" && d.vm) { setConsent(d.vm as ConsentVM); setBusy(undefined); }
      else if (d.type === "busy") setBusy(d.label ?? "Working…");
      else if (d.type === "result") { setToast({ ok: !!d.ok, message: d.message ?? "" }); setBusy(undefined); setConsent(undefined); }
    };
    window.addEventListener("message", onMsg);
    vscode?.postMessage({ type: "ready" }); // a (re)loaded webview → ask the host to (re)push the VM
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const dispatch = {
    refresh: () => vscode?.postMessage({ type: "refresh" }),
    checkUpdates: () => vscode?.postMessage({ type: "checkUpdates" }),
    install: (spec: string) => vscode?.postMessage({ type: "install", spec }),
    update: (name: string) => vscode?.postMessage({ type: "update", name }),
    reinstall: (name: string) => vscode?.postMessage({ type: "reinstall", name }),
    remove: (name: string) => vscode?.postMessage({ type: "remove", name }),
    reselect: (runtimes: string[]) => vscode?.postMessage({ type: "reselect", runtimes }),
    repair: () => vscode?.postMessage({ type: "repair" }),
    rehydrate: () => vscode?.postMessage({ type: "rehydrate" }),
    confirm: (token: string, skillDecisions: Record<string, "keep" | "replace"> = {}, mcpDecisions: Record<string, "keep" | "replace"> = {}, mcpConfirmed = false, gitHookConfirmed = false, toolConfirmed = false) => vscode?.postMessage({ type: "confirm", token, skillDecisions, mcpDecisions, mcpConfirmed, gitHookConfirmed, toolConfirmed }),
    cancel: () => { setConsent(undefined); vscode?.postMessage({ type: "cancel" }); },
    dismissToast: () => setToast(undefined),
  };

  return <App vm={vm} consent={consent} busy={busy} toast={toast} dispatch={dispatch} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
