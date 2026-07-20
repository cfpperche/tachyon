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
  switchControlWorkspaceAction,
  fleetStartAction,
  fleetStopAction,
  fleetTerminalAction,
  fleetActivityAction,
  revealPathAction,
  copyTextAction,
  openConfigFileAction,
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
import type { ApprovalDispatch } from "../approval/App";
import type { ApprovalViewModel } from "../approval/viewModel";
import {
  APPROVALS,
  APPROVAL_ERROR,
  refreshApprovalsAction,
  resolveApprovalAction,
} from "../approval/messages";
import type { ApprovalDecision } from "../../bridge/approvalRequest";
import type { ValidationsDispatch } from "../validations/App";
import type { ValidationsViewModel } from "../validations/viewModel";
import {
  VALIDATIONS,
  VALIDATION_ERROR,
  refreshValidationsAction,
  closeValidationItemAction,
  assignValidationAction,
} from "../validations/messages";
import type { RuntimeOpsSnapshot, RuntimeOpsProviderV2 } from "../../runtimeOps/types";
import {
  RUNTIME_OPS_SNAPSHOT,
  runtimeOpsSetProviderObservationAction,
} from "../runtime-ops/messages";
import type { InspectorAppProps } from "../inspector/App";
import type { InspectorModel } from "../../inspector/model";
import type { InspectorStrings } from "../inspector/messages";
import {
  captureAction,
  refreshAction as inspectorRefreshAction,
  openAction,
  killAction,
  reapDeadAction,
  reapOrphansAction,
} from "../inspector/messages";
import type { PluginsDispatch } from "../plugins/App";
import type { PluginsViewModel } from "../../plugins/viewModel";
import type { ConsentVM } from "../../plugins/consentViewModel";
import {
  PLUGINS,
  CONSENT,
  BUSY,
  RESULT,
  confirmMessage,
  type ConfirmPayload,
} from "../plugins/messages";

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
  const [approvalVm, setApprovalVm] = useState<ApprovalViewModel | undefined>(undefined);
  const [approvalError, setApprovalError] = useState<string | undefined>(undefined);
  const [validationsVm, setValidationsVm] = useState<ValidationsViewModel | undefined>(undefined);
  const [validationsError, setValidationsError] = useState<string | undefined>(undefined);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<RuntimeOpsSnapshot | undefined>(undefined);
  const [inspectorStrings, setInspectorStrings] = useState<InspectorStrings | undefined>(undefined);
  const [inspectorModel, setInspectorModel] = useState<InspectorModel | undefined>(undefined);
  const [inspectorCaptures, setInspectorCaptures] = useState<Record<string, string>>({});
  const [inspectorOpen, setInspectorOpen] = useState<Set<string>>(new Set());
  const [pluginsVm, setPluginsVm] = useState<PluginsViewModel | undefined>(undefined);
  const [pluginsConsent, setPluginsConsent] = useState<ConsentVM | undefined>(undefined);
  const [pluginsBusy, setPluginsBusy] = useState<string | undefined>(undefined);
  const [pluginsToast, setPluginsToast] = useState<{ ok: boolean; message: string } | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);
  const errorSeq = useRef(0);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const raw = e.data as Record<string, unknown> | undefined;
      if (!raw || typeof raw.type !== "string") return;
      const type = raw.type;

      if (type === INIT && raw.strings) setStrings(raw.strings as CockpitStrings);
      else if (type === MODEL && raw.model) setModel(raw.model as CockpitModel);
      else if (type === SNAPSHOT && raw.vm) setMissionVm(raw.vm as MissionControlVM);
      else if (type === TASK_ERROR && typeof raw.message === "string") {
        setMissionError({
          seq: ++errorSeq.current,
          message: raw.message,
          ...(typeof raw.taskId === "string" ? { taskId: raw.taskId } : {}),
        });
      } else if (type === APPROVALS && raw.vm) {
        setApprovalVm(raw.vm as ApprovalViewModel);
        setApprovalError(undefined);
      } else if (type === APPROVAL_ERROR && typeof raw.message === "string") {
        setApprovalError(raw.message);
      } else if (type === VALIDATIONS && raw.vm) {
        setValidationsVm(raw.vm as ValidationsViewModel);
        setValidationsError(undefined);
      } else if (type === VALIDATION_ERROR && typeof raw.message === "string") {
        setValidationsError(raw.message);
      } else if (type === RUNTIME_OPS_SNAPSHOT && raw.snapshot) {
        setRuntimeSnapshot(raw.snapshot as RuntimeOpsSnapshot);
      } else if (type === "inspectorInit" && raw.strings) {
        setInspectorStrings(raw.strings as InspectorStrings);
      } else if (type === "inspectorModel" && raw.model) {
        setInspectorModel(raw.model as InspectorModel);
      } else if (type === "inspectorCapture" && typeof raw.session === "string") {
        setInspectorCaptures((prev) => ({ ...prev, [raw.session as string]: String(raw.text ?? "") }));
      } else if (type === PLUGINS && raw.vm) {
        setPluginsVm(raw.vm as PluginsViewModel);
        setPluginsBusy(undefined);
      } else if (type === CONSENT && raw.vm) {
        setPluginsConsent(raw.vm as ConsentVM);
        setPluginsBusy(undefined);
      } else if (type === BUSY) {
        setPluginsBusy(typeof raw.label === "string" ? raw.label : "Working…");
      } else if (type === RESULT) {
        setPluginsToast({ ok: !!raw.ok, message: String(raw.message ?? "") });
        setPluginsBusy(undefined);
        setPluginsConsent(undefined);
      } else if (type === "toast" && typeof raw.text === "string") {
        setToast(raw.text);
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

  const approvalDispatch: ApprovalDispatch = useMemo(
    () => ({
      refresh: () => post(refreshApprovalsAction()),
      resolve: (id: string, decision: ApprovalDecision) => post(resolveApprovalAction(id, decision)),
    }),
    [],
  );

  const validationsDispatch: ValidationsDispatch = useMemo(
    () => ({
      refresh: () => post(refreshValidationsAction()),
      close: (id, outcome, note) => post(closeValidationItemAction(id, outcome, note)),
      assign: (id, assignee, expect) => post(assignValidationAction(id, assignee, expect)),
    }),
    [],
  );

  const pluginsDispatch: PluginsDispatch = useMemo(
    () => ({
      refresh: () => post({ type: "refresh" }),
      checkUpdates: () => post({ type: "checkUpdates" }),
      checkPluginUpdate: (name: string) => post({ type: "checkPluginUpdate", name }),
      install: (spec: string) => post({ type: "install", spec }),
      update: (name: string) => post({ type: "update", name }),
      reinstall: (name: string) => post({ type: "reinstall", name }),
      remove: (name: string) => post({ type: "remove", name }),
      reselect: (runtimes: string[]) => post({ type: "reselect", runtimes }),
      repair: () => post({ type: "repair" }),
      rehydrate: () => post({ type: "rehydrate" }),
      confirm: (payload: ConfirmPayload) => post(confirmMessage(payload)),
      cancel: () => {
        setPluginsConsent(undefined);
        post({ type: "cancel" });
      },
      dismissToast: () => setPluginsToast(undefined),
      openConfig: (name: string) => post({ type: "openConfig", name }),
      openDocs: (name: string) => post({ type: "openDocs", name }),
      installExternal: (externalTool: string, pluginName?: string) =>
        post({ type: "installExternal", externalTool, ...(pluginName ? { pluginName } : {}) }),
    }),
    [],
  );

  const inspectorProps: Pick<
    InspectorAppProps,
    "model" | "strings" | "captures" | "open" | "auto" | "onToggleAuto" | "onToggleCapture" | "onCloseCapture" | "onAction"
  > = {
    model: inspectorModel,
    strings: inspectorStrings,
    captures: inspectorCaptures,
    open: inspectorOpen,
    auto,
    onToggleAuto: setAuto,
    onToggleCapture: (session: string) => {
      setInspectorOpen((prev) => {
        const next = new Set(prev);
        next.add(session);
        post(captureAction(session));
        return next;
      });
    },
    onCloseCapture: (session: string) => {
      setInspectorOpen((prev) => {
        const next = new Set(prev);
        next.delete(session);
        return next;
      });
    },
    onAction: (a) => {
      if (a.type === "refresh") post(inspectorRefreshAction());
      else if (a.type === "reapDead") post(reapDeadAction());
      else if (a.type === "reapOrphans") post(reapOrphansAction());
      else if (a.type === "open") post(openAction(a.session));
      else if (a.type === "kill") post(killAction(a.session));
    },
  };

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
      onFleetStart={(name, wsHash) => post(fleetStartAction(name, wsHash))}
      onFleetStop={(name, wsHash) => post(fleetStopAction(name, wsHash))}
      onFleetTerminal={(name, wsHash) => post(fleetTerminalAction(name, wsHash))}
      onFleetActivity={(name, wsHash) => post(fleetActivityAction(name, wsHash))}
      onRevealPath={(path) => post(revealPathAction(path))}
      onCopyText={(text) => post(copyTextAction(text))}
      onOpenConfigFile={(wsHash) => post(openConfigFileAction(wsHash))}
      onPost={(action) => post(action)}
      missionVm={missionVm}
      missionError={missionError}
      missionDispatch={missionDispatch}
      approvalVm={approvalVm}
      approvalError={approvalError}
      approvalDispatch={approvalDispatch}
      validationsVm={validationsVm}
      validationsError={validationsError}
      validationsDispatch={validationsDispatch}
      runtimeSnapshot={runtimeSnapshot}
      onRuntimeSetProviderObservation={(provider: RuntimeOpsProviderV2, enabled: boolean) =>
        post(runtimeOpsSetProviderObservationAction(provider, enabled))
      }
      inspector={inspectorProps}
      pluginsVm={pluginsVm}
      pluginsConsent={pluginsConsent}
      pluginsBusy={pluginsBusy}
      pluginsToast={pluginsToast}
      pluginsDispatch={pluginsDispatch}
      onSetSection={(section: CockpitSectionId) => {
        setModel((prev) => (prev ? { ...prev, section } : prev));
        post(setSectionAction(section));
        if (section === "mission") post(requestSnapshotAction());
        if (section === "approvals") post(refreshApprovalsAction());
        if (section === "validations") post(refreshValidationsAction());
      }}
      onSwitchWorkspace={(wsHash: string) => {
        // t-d16a39 — optimistic model update (selector reflects the choice instantly); the host
        // re-sends the authoritative scoped model + the active section's module right after.
        setModel((prev) => (prev ? { ...prev, selectedWsHash: wsHash || undefined } : prev));
        post(switchControlWorkspaceAction(wsHash));
      }}
    />
  );
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
