import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import type { HandoffViewModel } from "./handoffViewModel";

// spec 245 inc D — the Project Handoff webview iframe entry. The host (HandoffPanelManager) pushes the
// assembled view-model via postMessage; we render only what arrives. Never imports vscode (engine boundary).
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

function Root() {
  const [vm, setVm] = useState<HandoffViewModel | undefined>(undefined);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; vm?: HandoffViewModel } | undefined;
      if (d && d.type === "handoff" && d.vm) setVm(d.vm);
    };
    window.addEventListener("message", onMsg);
    vscode?.postMessage({ type: "ready" }); // a (re)loaded webview → ask the host to (re)push the VM
    return () => window.removeEventListener("message", onMsg);
  }, []);
  const dispatch = {
    refresh: () => vscode?.postMessage({ type: "refresh" }),
    openFile: () => vscode?.postMessage({ type: "openFile" }),
  };
  return <App vm={vm} dispatch={dispatch} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
