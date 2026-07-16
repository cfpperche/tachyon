import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { App } from "./App";
import {
  INIT,
  MODEL,
  readyMessage,
  refreshAction,
  copyDiagnosticsAction,
  openServerInspectorAction,
  openMissionControlAction,
  openPluginsAction,
  openSettingsAction,
  openApprovalsAction,
  openRuntimeOpsAction,
  openDoctorAction,
  setSectionAction,
  type CockpitHostMessage,
  type CockpitStrings,
} from "./messages";
import type { CockpitModel, CockpitSectionId } from "../../cockpit/model";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import type { MissionControlDispatch, TaskErrorEvent } from "../mission-control/App";
import type { MissionControlVM } from "../mission-control/messages";
import {
  SNAPSHOT,
  TASK_ERROR,
  closeValidationAction,
  requestSnapshotAction,
  updateTaskAction,
  reorderLaneAction,
  openTaskAction,
  copyTaskIdAction,
  openTaskStudioAction,
  switchWorkspaceAction,
  type MissionControlHostMessage,
} from "../mission-control/messages";
import type { TaskPriority, TaskStatus, TaskUpdateInput } from "../../tasks/types";
import type { ValidationOutcome } from "../../validations/types";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

const post = (msg: unknown): void => {
  if (vscode) vscode.postMessage(msg);
  else window.postMessage(msg, "*");
};

function Root() {
  const [strings, setStrings] = useState<CockpitStrings | undefined>(undefined);
  const [model, setModel] = useState<CockpitModel | undefined>(undefined);
  const [toast, setToast] = useState<string | undefined>(undefined);
  const [auto, setAuto] = useState(true);
  const [missionVm, setMissionVm] = useState<MissionControlVM | undefined>(undefined);
  const [missionError, setMissionError] = useState<TaskErrorEvent | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);
  const errorSeq = useRef(0);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const raw = e.data as Partial<CockpitHostMessage & MissionControlHostMessage> | undefined;
      if (!raw) return;
      if (raw.type === INIT && "strings" in raw && raw.strings) setStrings(raw.strings as CockpitStrings);
      else if (raw.type === MODEL && "model" in raw && raw.model) setModel(raw.model as CockpitModel);
      else if (raw.type === SNAPSHOT && "vm" in raw && raw.vm) setMissionVm(raw.vm as MissionControlVM);
      else if (raw.type === TASK_ERROR && typeof (raw as { message?: string }).message === "string") {
        const te = raw as { message: string; taskId?: string };
        setMissionError({
          seq: ++errorSeq.current,
          message: te.message,
          ...(te.taskId ? { taskId: te.taskId } : {}),
        });
      } else if (raw.type === "toast" && "text" in raw && raw.text) {
        setToast(raw.text as string);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(undefined), 2200);
      }
    };
    window.addEventListener("message", onMsg);
    if (vscode) vscode.postMessage(readyMessage());
    else window.postMessage(readyMessage(), "*");
    return () => {
      window.removeEventListener("message", onMsg);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = undefined;
    }
    // On Mission tab, board snapshot is pushed on enter / mutation fan-out; still refresh model lightly.
    if (auto && strings) timer.current = window.setInterval(() => post(refreshAction()), 3000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [auto, strings]);

  const missionDispatch: MissionControlDispatch = useMemo(
    () => ({
      updateTask: (id: string, patch: TaskUpdateInput) => post(updateTaskAction(id, patch)),
      reorderLane: (status: TaskStatus, priority: TaskPriority | undefined, orderedIds: string[], expect: Record<string, string>) =>
        post(reorderLaneAction(status, priority, orderedIds, expect)),
      closeValidation: (id: string, outcome: ValidationOutcome, result_note: string) =>
        post(closeValidationAction(id, outcome, result_note)),
      openTaskStudio: (id?: string) => post(openTaskStudioAction(id)),
      openTask: (id: string) => post(openTaskAction(id)),
      copyTaskId: (id: string) => post(copyTaskIdAction(id)),
      switchWorkspace: (wsHash: string) => post(switchWorkspaceAction(wsHash)),
    }),
    [],
  );

  return (
    <App
      model={model}
      strings={strings}
      toast={toast}
      auto={auto}
      onToggleAuto={setAuto}
      onRefresh={() => post(refreshAction())}
      onCopyDiagnostics={() => post(copyDiagnosticsAction())}
      onOpenServerInspector={() => post(openServerInspectorAction())}
      onOpenMissionControl={() => post(openMissionControlAction())}
      onOpenPlugins={() => post(openPluginsAction())}
      onOpenSettings={() => post(openSettingsAction())}
      onOpenApprovals={() => post(openApprovalsAction())}
      onOpenRuntimeOps={() => post(openRuntimeOpsAction())}
      onOpenDoctor={() => post(openDoctorAction())}
      missionVm={missionVm}
      missionError={missionError}
      missionDispatch={missionDispatch}
      onSetSection={(section: CockpitSectionId) => {
        setModel((prev) => (prev ? { ...prev, section } : prev));
        post(setSectionAction(section));
        if (section === "mission") post(requestSnapshotAction());
      }}
    />
  );
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
