import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { App } from "./App";
import { PIN_DOCUMENT_MODE, PIN_PREVIEW, readyMessage, setPinDocumentModeAction, type PinPreviewHostMessage } from "./messages";
import type { PinPreviewVM } from "../../sidebar/types";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App as PinStudioApp } from "../pin-studio/App";
import { Button } from "../shared/ui";

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
  const initialMode = (window.__tachyonPersistedState as { mode?: "read" | "edit" } | undefined)?.mode;
  const [mode, setMode] = useState<"read" | "edit">(initialMode === "edit" ? "edit" : "read");
  const [incoming, setIncoming] = useState<{ seq: number; message: unknown }>();
  const seq = useRef(0);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as Partial<PinPreviewHostMessage> | undefined;
      if (d?.type === PIN_PREVIEW && d.vm) setVm(d.vm);
      else if (d?.type === PIN_DOCUMENT_MODE) {
        const next = (d as { mode: "read" | "edit" }).mode;
        setMode(next);
        vscode?.setState?.({ ...(window.__tachyonPersistedState as object), mode: next });
      } else if (typeof d?.type === "string") {
        seq.current += 1;
        setIncoming({ seq: seq.current, message: d });
      }
    };
    window.addEventListener("message", onMsg);
    signalReady();
    return () => window.removeEventListener("message", onMsg);
  }, []);
  const post = (message: object) => vscode ? vscode.postMessage(message) : window.postMessage(message, "*");
  if (mode === "edit") {
    return <div class="pin-edit-mode"><PinStudioApp
      dispatch={{ post }}
      routeKey={`pin-detail:${vm?.id ?? ""}`}
      mountNonce="pin-document"
      incoming={incoming}
      backLink={<Button icon="arrow-left" onClick={() => post(setPinDocumentModeAction("read"))}>Read pin</Button>}
    /></div>;
  }
  return <App vm={vm} onEdit={() => post(setPinDocumentModeAction("edit"))} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
