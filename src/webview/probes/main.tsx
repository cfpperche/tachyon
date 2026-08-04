import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App } from "./App";
import { PROBES, type ProbesVM } from "./messages";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);
const post = (message: unknown): void => vscode ? vscode.postMessage(message) : window.postMessage(message, "*");

function ProbesRoot() {
  const [vm, setVm] = useState<ProbesVM>();
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const raw = event.data as { type?: unknown; vm?: unknown } | undefined;
      if (raw?.type === PROBES && raw.vm) setVm(raw.vm as ProbesVM);
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return <main class="ds-page"><App vm={vm} /></main>;
}

const root = document.getElementById("root");
if (root) render(<ErrorBoundary><ProbesRoot /></ErrorBoundary>, root);
