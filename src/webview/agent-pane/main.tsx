import { render } from "preact";
import { App } from "./App";
import type { AgentPaneFromHost, AgentPaneToHost } from "./protocol";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { ErrorBoundary } from "../shared/ErrorBoundary";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

function postMessage(msg: AgentPaneToHost): void {
  if (vscode) vscode.postMessage(msg);
  else window.postMessage(msg, "*");
}

function onHostMessage(handler: (msg: AgentPaneFromHost) => void): () => void {
  const listener = (e: MessageEvent) => {
    const d = e.data as AgentPaneFromHost | undefined;
    if (!d || typeof d !== "object" || typeof d.type !== "string") return;
    if (!d.type.startsWith("agent-pane/")) return;
    handler(d);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

const root = document.getElementById("root");
if (root) {
  render(
    <ErrorBoundary>
      <App postMessage={postMessage} onHostMessage={onHostMessage} />
    </ErrorBoundary>,
    root,
  );
}
