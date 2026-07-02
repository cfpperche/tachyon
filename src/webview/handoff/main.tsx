import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import type { HandoffViewModel } from "./handoffViewModel";
import { HANDOFF, readyMessage, refreshAction, openFileAction, distillExistingAction, distillAdhocAction, type HandoffHostMessage } from "./messages";

// spec 245 inc D — the Project Handoff webview iframe entry. The host (HandoffPanelManager) pushes the
// assembled view-model via postMessage; we render only what arrives. Never imports vscode (engine boundary).
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

function Root() {
  const [vm, setVm] = useState<HandoffViewModel | undefined>(undefined);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as Partial<HandoffHostMessage> | undefined;
      if (d && d.type === HANDOFF && d.vm) setVm(d.vm);
    };
    window.addEventListener("message", onMsg);
    // spec 280 — the ready handshake works in both modes (real host / dev preview harness).
    if (vscode) vscode.postMessage(readyMessage());
    else window.postMessage(readyMessage(), "*");
    return () => window.removeEventListener("message", onMsg);
  }, []);
  const dispatch = {
    refresh: () => vscode?.postMessage(refreshAction()),
    openFile: () => vscode?.postMessage(openFileAction()),
    distillExisting: (agent: string, instructions?: string) => vscode?.postMessage(distillExistingAction(agent, instructions)),
    distillAdhoc: (runtime: string, instructions?: string) => vscode?.postMessage(distillAdhocAction(runtime, instructions)),
  };
  return <App vm={vm} dispatch={dispatch} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
