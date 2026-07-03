import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import type { RichDocAttachmentVM } from "../rich-doc/types";
import type { TaskStudioVM } from "./types";
import { readyMessage, type TaskStudioHostMessage } from "./messages";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

function Root() {
  const [vm, setVm] = useState<TaskStudioVM | undefined>(undefined);
  const [hostError, setHostError] = useState<string | undefined>(undefined);
  const [hostConflict, setHostConflict] = useState<string | undefined>(undefined);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as TaskStudioHostMessage | undefined;
      if (!d) return;
      if (d.type === "taskStudio") { setVm(d.vm); setHostError(undefined); }
      if (d.type === "error") setHostError(d.message);
      if (d.type === "saveConflict") setHostConflict(d.message);
      if (d.type === "attachmentStored") {
        (window as unknown as { __tachyonTaskStored?: (att: RichDocAttachmentVM) => void }).__tachyonTaskStored?.(d.attachment);
      }
    };
    window.addEventListener("message", onMsg);
    if (vscode) vscode.postMessage(readyMessage());
    else window.postMessage(readyMessage(), "*");
    return () => window.removeEventListener("message", onMsg);
  }, []);
  return <App vm={vm} hostError={hostError} hostConflict={hostConflict} dispatch={{ post: (msg) => vscode?.postMessage(msg) }} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
