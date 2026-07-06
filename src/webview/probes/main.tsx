import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import { PROBES, readyMessage, type ProbesHostMessage, type ProbesVM } from "./messages";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";

// spec 279 — the Probes webview entry. `preact-live` read-only: it listens for the host's model push (re-sent on
// refresh) but sends no inbound actions. Never imports vscode (engine boundary) — only the VM type, erased by esbuild.
declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

// the ready handshake works in BOTH modes: the real webview signals the vscode host; standalone (the dev preview
// harness) it posts to `window` so the harness injects a fixture deterministically.
const signalReady = (): void => {
  if (vscode) vscode.postMessage(readyMessage());
  else window.postMessage(readyMessage(), "*");
};

function Root() {
  const [vm, setVm] = useState<ProbesVM | undefined>(undefined);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as Partial<ProbesHostMessage> | undefined;
      if (d?.type === PROBES && d.vm) setVm(d.vm);
    };
    window.addEventListener("message", onMsg);
    signalReady();
    return () => window.removeEventListener("message", onMsg);
  }, []);
  return <App vm={vm} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
