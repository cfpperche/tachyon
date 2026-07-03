import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App, type TaskDetailDispatch } from "./App";
import type { TaskDetailVM } from "./messages";
import { TASK, TASK_DETAIL_ERROR, readyMessage, requestSnapshotAction, updateTaskAction, openTaskAction, openTaskStudioAction, type TaskDetailHostMessage } from "./messages";
import type { TaskUpdateInput } from "../../tasks/types";

// spec 335 — the Task Detail webview iframe entry. One instance per task-id tab (the host manages a Map of
// panels, each running its own copy of this bundle). Never imports vscode (engine boundary).
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

let errorSeq = -1;

function Root() {
  const [vm, setVm] = useState<TaskDetailVM | undefined>(undefined);
  const [errSeq, setErrSeq] = useState(-1);
  const [errMessage, setErrMessage] = useState<string | undefined>(undefined);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as Partial<TaskDetailHostMessage> | undefined;
      if (d?.type === TASK && d.vm) setVm(d.vm);
      if (d?.type === TASK_DETAIL_ERROR && typeof d.message === "string") {
        errorSeq += 1;
        setErrSeq(errorSeq);
        setErrMessage(d.message);
      }
    };
    window.addEventListener("message", onMsg);
    if (vscode) vscode.postMessage(readyMessage());
    else window.postMessage(readyMessage(), "*");
    return () => window.removeEventListener("message", onMsg);
  }, []);
  const dispatch: TaskDetailDispatch = {
    updateTask: (patch: TaskUpdateInput) => vscode?.postMessage(updateTaskAction(patch)),
    openTask: (id: string) => vscode?.postMessage(openTaskAction(id)),
    openStudio: () => vscode?.postMessage(openTaskStudioAction()),
    refresh: () => vscode?.postMessage(requestSnapshotAction()),
  };
  return <App vm={vm} errorSeq={errSeq} errorMessage={errMessage} dispatch={dispatch} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
