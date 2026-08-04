import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App, type TaskDetailDispatch } from "./App";
import {
  TASK,
  TASK_DETAIL_ERROR,
  TASK_DOCUMENT_MODE,
  approvePrototypeAction,
  notePrototypeAction,
  openTaskAction,
  openTaskStudioAction,
  rejectPrototypeAction,
  readyMessage,
  requestSnapshotAction,
  updateTaskAction,
  type TaskDetailAction,
  type TaskDetailVM,
} from "./messages";
import { App as TaskStudioApp } from "../task-studio/App";

/**
 * SDD 485 C4 — the task detail's OWN bootstrap, error boundary and CSS: the half of the reversal a single
 * bundle with twelve lazy mounts could not buy (`spec.md`, codex's point). Until this file existed, this
 * screen was mounted by `cockpit/App.tsx` behind Control's shared listener, shared state and shared error
 * boundary — one panel, one screen, and the maintainer's motivating case #2 (two task details side by side)
 * structurally out of reach.
 *
 * The renderer itself (`./App.tsx`) is UNCHANGED and stays the same component the Control subroute mounted:
 * this phase moves WHERE the screen renders, not how it looks.
 *
 * Two things are deliberately NOT here, both of them Control's and neither of them this document's:
 *
 *  - no client-side poll. `route.ts`'s `refreshPolicy` already answered "none" for a task detail (a
 *    timer-driven refetch mid-read, or mid-typing in the assignee field, is only downside), and the host's
 *    fan-out re-pushes on every real mutation. The gate in `SectionPanelManager` would have refused a hidden
 *    panel's poll anyway; the right answer is still not to have one.
 *  - no identity check on an inbound TASK. Control needed one because ONE panel served every task and a late
 *    push from the route you just left could repopulate the screen under a different task (t-9993cc). A
 *    document panel IS one identity for its whole life — the host resolves the task from the panel's own
 *    frozen target, so there is no second identity for a message to belong to.
 */

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

function post(message: TaskDetailAction): void {
  if (vscode) vscode.postMessage(message);
  else window.postMessage(message, "*");
}

function Root() {
  const [vm, setVm] = useState<TaskDetailVM | undefined>(undefined);
  const [errorSeq, setErrorSeq] = useState(-1);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const errorCounter = useRef(0);
  const initialMode = (window.__tachyonPersistedState as { mode?: "read" | "edit" } | undefined)?.mode;
  const [mode, setMode] = useState<"read" | "edit">(initialMode === "edit" ? "edit" : "read");
  const [studioIncoming, setStudioIncoming] = useState<{ seq: number; message: unknown }>();
  const studioSeq = useRef(0);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const raw = event.data as { type?: unknown; vm?: unknown; message?: unknown } | undefined;
      if (!raw || typeof raw !== "object") return;
      if (raw.type === TASK && raw.vm) setVm(raw.vm as TaskDetailVM);
      else if (raw.type === TASK_DOCUMENT_MODE && (raw as { mode?: unknown }).mode) {
        const next = (raw as { mode: "read" | "edit" }).mode;
        setMode(next);
        vscode?.setState?.({ ...(window.__tachyonPersistedState as object), mode: next });
      }
      else if (raw.type === TASK_DETAIL_ERROR && typeof raw.message === "string") {
        errorCounter.current += 1;
        setErrorSeq(errorCounter.current);
        setErrorMessage(raw.message);
      } else if (typeof raw.type === "string") {
        studioSeq.current += 1;
        setStudioIncoming({ seq: studioSeq.current, message: raw });
      }
    };
    window.addEventListener("message", onMessage);
    // spec 278's SHARED handshake, not a surface-local one: the host claims it as this app's first refresh
    // (`refreshKindFor`), and the dev preview harness waits for exactly this message before injecting a
    // fixture — a view that invents its own `ready` never renders there (SDD 485 C1–C3's visual pass found
    // that the hard way).
    post(readyMessage());
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const dispatch = useMemo<TaskDetailDispatch>(() => ({
    updateTask: (patch) => post(updateTaskAction(patch)),
    openTask: (id) => post(openTaskAction(id)),
    openStudio: () => post(openTaskStudioAction()),
    refresh: () => post(requestSnapshotAction()),
    approvePrototype: (prototypeId, expectUpdatedAt, review) => post(approvePrototypeAction(prototypeId, expectUpdatedAt, review)),
    rejectPrototype: (prototypeId, expectUpdatedAt, review) => post(rejectPrototypeAction(prototypeId, expectUpdatedAt, review)),
    notePrototype: (prototypeId, expectUpdatedAt, review) => post(notePrototypeAction(prototypeId, expectUpdatedAt, review)),
  }), []);

  if (mode === "edit") {
    return <div class="td-edit-mode">
      <TaskStudioApp
        dispatch={{ post }}
        routeKey={`task-detail:${vm?.wsHash ?? ""}:${vm?.id ?? ""}`}
        mountNonce="task-document"
        incoming={studioIncoming}
      />
    </div>;
  }
  return <App vm={vm} errorSeq={errorSeq} errorMessage={errorMessage} dispatch={dispatch} />;
}

const root = document.getElementById("root");
if (root) render(<ErrorBoundary><Root /></ErrorBoundary>, root);
