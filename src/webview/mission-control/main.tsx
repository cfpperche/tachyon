import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App, type MissionControlDispatch, type TaskErrorEvent } from "./App";
import type { MissionControlVM } from "./messages";
import { SNAPSHOT, TASK_ERROR, closeValidationAction, readyMessage, updateTaskAction, openTaskAction, openTaskStudioAction, type MissionControlHostMessage } from "./messages";
import type { TaskUpdateInput } from "../../tasks/types";
import type { ValidationOutcome } from "../../validations/types";

// spec 335 — the Mission Control webview iframe entry. The host (MissionControlPanelManager) pushes the board
// snapshot via postMessage; we render only what arrives. Never imports vscode (engine boundary).
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

let errorSeq = 0;

function Root() {
  const [vm, setVm] = useState<MissionControlVM | undefined>(undefined);
  const [lastError, setLastError] = useState<TaskErrorEvent | undefined>(undefined);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as Partial<MissionControlHostMessage> | undefined;
      if (d?.type === SNAPSHOT && d.vm) setVm(d.vm);
      if (d?.type === TASK_ERROR && typeof d.message === "string") {
        setLastError({ seq: ++errorSeq, message: d.message, ...(d.taskId ? { taskId: d.taskId } : {}) });
      }
    };
    window.addEventListener("message", onMsg);
    if (vscode) vscode.postMessage(readyMessage());
    else window.postMessage(readyMessage(), "*");
    return () => window.removeEventListener("message", onMsg);
  }, []);
  const dispatch: MissionControlDispatch = {
    updateTask: (id: string, patch: TaskUpdateInput) => vscode?.postMessage(updateTaskAction(id, patch)),
    closeValidation: (id: string, outcome: ValidationOutcome, result_note: string) => vscode?.postMessage(closeValidationAction(id, outcome, result_note)),
    openTaskStudio: (id?: string) => vscode?.postMessage(openTaskStudioAction(id)),
    openTask: (id: string) => vscode?.postMessage(openTaskAction(id)),
  };
  return <App vm={vm} lastError={lastError} dispatch={dispatch} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
