import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import type { PinStudioAttachmentVM, PinStudioVM } from "./types";
import { readyMessage, type PinStudioHostMessage } from "./messages";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

function Root() {
  const [vm, setVm] = useState<PinStudioVM | undefined>(undefined);
  const [hostError, setHostError] = useState<string | undefined>(undefined);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as PinStudioHostMessage | undefined;
      if (!d) return;
      if (d.type === "pinStudio") { setVm(d.vm); setHostError(undefined); }
      if (d.type === "error") setHostError(d.message);
      if (d.type === "attachmentStored") {
        (window as unknown as { __tachyonPinStored?: (att: PinStudioAttachmentVM) => void }).__tachyonPinStored?.(d.attachment);
      }
    };
    window.addEventListener("message", onMsg);
    if (vscode) vscode.postMessage(readyMessage());
    else window.postMessage(readyMessage(), "*");
    return () => window.removeEventListener("message", onMsg);
  }, []);
  return <App vm={vm} hostError={hostError} dispatch={{ post: (msg) => vscode?.postMessage(msg) }} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
