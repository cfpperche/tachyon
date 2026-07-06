import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import { PIN_PREVIEW, readyMessage, type PinPreviewHostMessage } from "./messages";
import type { PinPreviewVM } from "../../sidebar/types";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";

// spec 279 — the Pin Preview webview entry (converted from inline HTML). `preact-static`: receives the VM once
// after the ready handshake, renders, no inbound actions. Never imports vscode (engine boundary).
declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

const signalReady = (): void => {
  if (vscode) vscode.postMessage(readyMessage());
  else window.postMessage(readyMessage(), "*");
};

function Root() {
  const [vm, setVm] = useState<PinPreviewVM | undefined>(undefined);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as Partial<PinPreviewHostMessage> | undefined;
      if (d?.type === PIN_PREVIEW && d.vm) setVm(d.vm);
    };
    window.addEventListener("message", onMsg);
    signalReady();
    return () => window.removeEventListener("message", onMsg);
  }, []);
  return <App vm={vm} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
