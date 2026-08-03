import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { ToastProvider } from "../shared/ui";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App, type MissionControlDispatch, type TaskErrorEvent } from "./App";
import {
  SNAPSHOT,
  TASK_ERROR,
  closeValidationAction,
  copyTaskIdAction,
  openTaskAction,
  openTaskStudioAction,
  readyMessage,
  reorderLaneAction,
  requestSnapshotAction,
  updateTaskAction,
  type MissionControlVM,
} from "./messages";
import type { TaskPriority, TaskStatus, TaskUpdateInput } from "../../tasks/types";
import type { ValidationOutcome } from "../../validations/types";

/**
 * SDD 485 C5 — the Board's OWN bootstrap, error boundary and toast host.
 *
 * The component below this file (`./App`) is byte-for-byte the one Control embedded; what changed is who
 * mounts it. That is the whole of the "atomic cutover" rule as it applies here: `cockpit/App.tsx` no longer
 * lazy-imports the board, so there is exactly one live renderer of this screen and one client that can answer
 * a host push. Two would mean two subscriptions and two possible answers to one command — the scar Approvals
 * already wore before SDD 410 (`spec.md`, RESOLVED: "Does the migration keep both paths alive, or cut over?").
 *
 * `ToastProvider` is here because the board asks for a toast through `useToastOptional()`: inside Control the
 * shell provided one, and a standalone app that provided none would silently swallow every "Board changed —
 * retry" a rejected drag produces.
 */

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

const post = (message: unknown): void => {
  if (vscode) vscode.postMessage(message);
  else window.postMessage(message, "*");
};

function BoardRoot() {
  const [vm, setVm] = useState<MissionControlVM | undefined>(undefined);
  const [lastError, setLastError] = useState<TaskErrorEvent | undefined>(undefined);

  useEffect(() => {
    let errorSeq = 0;
    const onMessage = (event: MessageEvent) => {
      const raw = event.data as Record<string, unknown> | undefined;
      if (!raw || typeof raw.type !== "string") return;
      if (raw.type === SNAPSHOT && raw.vm) setVm(raw.vm as MissionControlVM);
      else if (raw.type === TASK_ERROR && typeof raw.message === "string") {
        errorSeq += 1;
        setLastError({
          seq: errorSeq,
          message: raw.message,
          ...(typeof raw.taskId === "string" ? { taskId: raw.taskId } : {}),
        });
      }
    };
    window.addEventListener("message", onMessage);
    post(readyMessage());
    // The client-side poll Control also ran. It stays, and it stays UNCONDITIONAL, because the HOST is what
    // refuses to serve it while the panel is hidden (`refreshKindFor` → `PanelWorkGate`): Phase B's loudest
    // finding was a hidden Control running a full collect twenty times a minute off exactly this timer, and
    // the fix was host-side precisely so no client version can reopen the door (notes.md, Phase B/C).
    const timer = setInterval(() => post(requestSnapshotAction()), 3000);
    return () => {
      window.removeEventListener("message", onMessage);
      clearInterval(timer);
    };
  }, []);

  const dispatch: MissionControlDispatch = useMemo(
    () => ({
      updateTask: (id: string, patch: TaskUpdateInput) => post(updateTaskAction(id, patch)),
      reorderLane: (status: TaskStatus, priority: TaskPriority | undefined, orderedIds: string[], expect: Record<string, string>) =>
        post(reorderLaneAction(status, priority, orderedIds, expect)),
      closeValidation: (id: string, outcome: ValidationOutcome, result_note: string) =>
        post(closeValidationAction(id, outcome, result_note)),
      openTaskStudio: (id?: string) => post(openTaskStudioAction(id)),
      openTask: (id: string) => post(openTaskAction(id)),
      copyTaskId: (id: string) => post(copyTaskIdAction(id)),
    }),
    [],
  );

  // `pendingTaskId` is deliberately not passed: it was derived from Control's own routePending bracket, and
  // opening a task is no longer a navigation THIS panel performs — it opens elsewhere. Claiming a pending
  // state this app cannot observe the end of would leave a card stuck looking busy forever.
  return <App vm={vm} lastError={lastError} dispatch={dispatch} />;
}

const root = document.getElementById("root");
if (root) {
  render(
    <ErrorBoundary>
      <ToastProvider>
        <BoardRoot />
      </ToastProvider>
    </ErrorBoundary>,
    root,
  );
}
