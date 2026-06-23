import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import type { PluginsViewModel } from "../../plugins/viewModel";

// spec 250 — the Plugins View webview iframe entry. The host (PluginsPanelManager) gathers the model
// (detectRuntimes + lockfile) and pushes it via postMessage; we render only what arrives. Never imports
// vscode or the engine at runtime (engine boundary) — only the VM TYPE, which esbuild erases.
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

function Root() {
  const [vm, setVm] = useState<PluginsViewModel | undefined>(undefined);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; vm?: PluginsViewModel } | undefined;
      if (d && d.type === "plugins" && d.vm) setVm(d.vm);
    };
    window.addEventListener("message", onMsg);
    vscode?.postMessage({ type: "ready" }); // a (re)loaded webview → ask the host to (re)push the VM
    return () => window.removeEventListener("message", onMsg);
  }, []);
  const dispatch = {
    refresh: () => vscode?.postMessage({ type: "refresh" }),
  };
  return <App vm={vm} dispatch={dispatch} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
