import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { App } from "./App";
import {
  INIT,
  MODEL,
  readyMessage,
  refreshAction,
  copyDiagnosticsAction,
  openSettingsAction,
  openDoctorAction,
  setSectionAction,
  switchControlWorkspaceAction,
  fleetStartAction,
  fleetStopAction,
  fleetTerminalAction,
  fleetActivityAction,
  fleetProbesAction,
  fleetAgentStudioAction,
  revealPathAction,
  copyTextAction,
  openConfigFileAction,
  setCompanionTabToolsAction,
  setCompanionAllowedHostsAction,
  unpairCompanionDeviceAction,
  issueCompanionPairCodeAction,
  type CockpitStrings,
  type CompanionPairOffer,
} from "./messages";
import type { CockpitModel, CockpitSectionId } from "../../cockpit/model";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import type { MissionControlDispatch, TaskErrorEvent } from "../mission-control/App";
import type { MissionControlVM } from "../mission-control/messages";
import type { TaskDetailDispatch } from "../task-detail/App";
import {
  TASK,
  requestSnapshotAction as requestTaskSnapshotAction,
  updateTaskAction as updateTaskDetailAction,
  openTaskAction as openTaskDetailAction,
  openTaskStudioAction as openTaskDetailStudioAction,
  approvePrototypeAction,
  rejectPrototypeAction,
  notePrototypeAction,
  type TaskDetailVM,
} from "../task-detail/messages";
import type { ActivityDispatch } from "../activity/App";
import type { ActivityViewModel } from "../../activity/activityView";
import {
  ACTIVITY,
  IMAGE_DATA,
  copyShareTextMessage,
  shareExternalMessage,
  shareToAgentMessage,
} from "../activity/messages";
import type { ProbesVM } from "../probes/messages";
import { PROBES } from "../probes/messages";
import type { HandoffDispatch } from "../handoff/App";
import type { HandoffViewModel } from "../handoff/handoffViewModel";
import {
  HANDOFF,
  refreshAction as refreshHandoffAction,
  openFileAction as openHandoffFileAction,
  distillExistingAction,
  distillAdhocAction,
} from "../handoff/messages";
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
import type { StudioDispatch } from "../shared/studio/protocol";
import { dispatchStudioFreezeMessage, isStudioFreezeBusMessage } from "../shared/studio/studioFreezeBus";
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
  /** Ephemeral pair offer — not stored in polled model. */
  const [companionPairOffer, setCompanionPairOffer] = useState<CompanionPairOffer | undefined>(undefined);
  const [auto, setAuto] = useState(true);
  const [missionVm, setMissionVm] = useState<MissionControlVM | undefined>(undefined);
  const [missionError, setMissionError] = useState<TaskErrorEvent | undefined>(undefined);
  const [taskVm, setTaskVm] = useState<TaskDetailVM | undefined>(undefined);
  const [taskErrorSeq, setTaskErrorSeq] = useState(-1);
  const [taskErrorMessage, setTaskErrorMessage] = useState<string | undefined>(undefined);
  const [activityVm, setActivityVm] = useState<ActivityViewModel | undefined>(undefined);
  const [activityPrepended, setActivityPrepended] = useState(false);
  const [activityImages, setActivityImages] = useState<Record<string, string>>({});
  const [probesVm, setProbesVm] = useState<ProbesVM | undefined>(undefined);
  const [handoffVm, setHandoffVm] = useState<HandoffViewModel | undefined>(undefined);
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
  /** t-610705 (Phase D, D0) — the studio-envelope + nav-transaction protocols are forwarded raw (no
   *  decode/reshape here — command-studio-shell/App.tsx's own decodeStudioMessage handles it, same
   *  as it did as a standalone panel); `seq` guarantees change detection even across two arrivals
   *  with an identical shape (e.g. two "load" pushes for the same blank new-entity form). */
  const [studioIncoming, setStudioIncoming] = useState<{ seq: number; message: unknown } | undefined>(undefined);
  const studioSeq = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);
  const errorSeq = useRef(0);
  const taskErrorSeqCounter = useRef(0);
  /**
   * Track companion devices so a successful pair dismisses the ephemeral code card.
   * Fingerprint = sorted device ids (count alone is not enough if a device is replaced in place).
   */
  const companionPairSnapshot = useRef<{ paired: boolean; deviceKey: string } | null>(null);
  // t-610705 (Phase C.1) — mission-control's TASK_ERROR and task-detail's TASK_DETAIL_ERROR are the
  // SAME wire string ("taskError", identical {type,message} shape — ported verbatim from the two
  // panels' pre-410 messages.ts files, never meant to share a client). The onMsg listener below is
  // mounted once ([] deps), so it can't read fresh `model` state directly (stale closure) — this ref
  // is kept current from the MODEL branch so the taskError branch can tell which surface it's for.
  const activeRouteRef = useRef<CockpitModel["activeRoute"]>(undefined);
  // t-610705 (Phase D, D1a code-review finding) — `studioIncoming` is ONE shared state slot every
  // studio App reads via its `incoming` prop; a fresh studio component mount does NOT clear it (only
  // a NEW message does), so a stale `incoming` from the PREVIOUS studio binding is what a just-
  // mounted DIFFERENT studio's component sees on its first render — decodeStudioMessage only checks
  // `type`/`studioProtocolVersion`, not the studio-specific field shape, so a cross-studio residue
  // (e.g. Schedule's `load` envelope reaching a freshly-mounted Terminal component) is accepted as if
  // it were Terminal's own load and can crash on a field the two studios don't share (e.g. Terminal's
  // `firstToken(fields.cmd)` against Schedule's fields, which have no `cmd`). Tracked here (not in an
  // effect on the studio App side) because the fix must land BEFORE the new component's first render
  // — an effect that clears `studioIncoming` only runs AFTER that render already used the stale
  // value. Comparing `studioMountNonce` catches every rebind (cross-studio AND same-studio-different-
  // entity), same "identity" concept `ensureStudioBinding`/`useEffect([routeKey, mountNonce])` uses.
  //
  // A round-2 review pass asked whether a message legitimately posted for the OLD binding could
  // still arrive at the client AFTER this clear runs (this ref only clears what's ALREADY stored at
  // transition time — it has no way to reject a late arrival, since host->client studio-envelope
  // messages carry no routeKey/mountNonce, unlike client->host ones since round-5). Verified against
  // studioHost.ts/Cockpit.ts directly (not just reasoned about): `navigate()` — called SYNCHRONOUSLY
  // by every commit path (`beginStudioNavTransaction`'s `commit`) BEFORE `sendModel()`/`ensureStudio-
  // Binding` ever run for the NEW binding — tears the OLD binding down first via
  // `reconcileStudioTeardown` (`binding = undefined`). Every host-side post path for the old binding
  // (`sendStudioLoad`, `refreshStudioReferenceData`, `beginStudioSave`, `beginStudioNavTransaction`'s
  // own checkpoint/save flow) re-checks `binding !== b` (the captured old binding) immediately before
  // every `io.post(...)` — since `binding` is ALREADY torn down (or reassigned to the new one) before
  // `sendModel()`'s own internal `await deps.collect()` gap even opens, there is no window where the
  // OLD binding's async continuation can find `binding === b` and legitimately post AFTER the new
  // binding's own "model" push. This is the same generation/`binding !== b` invariant D0's own 6
  // review rounds already hardened for every host post path — this ref's job is only the CLIENT-side
  // half (drop a residue the host correctly never re-sends), not a second independent proof of it.
  const studioMountNonceRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const raw = e.data as Record<string, unknown> | undefined;
      if (!raw || typeof raw.type !== "string") return;
      const type = raw.type;

      if (type === INIT && raw.strings) setStrings(raw.strings as CockpitStrings);
      else if (type === MODEL && raw.model) {
        const next = raw.model as CockpitModel;
        const paired = next.companion?.paired === true;
        const deviceKey = (next.companion?.devices ?? [])
          .map((d) => d.id)
          .filter(Boolean)
          .slice()
          .sort()
          .join("|");
        const prev = companionPairSnapshot.current;
        // Dismiss offer when pairing lands: not-paired→paired, or connected-device set changes
        // (new/replaced device). Unpair also clears a stale offer. Fresh "Show pair code" while
        // already paired still shows until the next device change.
        if (prev && ((!prev.paired && paired) || prev.deviceKey !== deviceKey)) {
          setCompanionPairOffer(undefined);
        }
        companionPairSnapshot.current = { paired, deviceKey };
        // t-610705 (Phase C.2, hardening dueto probe-2d90286d) — Control hosts at most one active
        // Activity feed; a stale image lingering after navigating to a different agent/workspace is
        // low-risk (content-addressed ids rarely collide) but grows unbounded across a session, so
        // drop it the moment the identity actually changes (never on a same-identity re-push).
        const prevActivity = activeRouteRef.current?.kind === "agent-activity" ? activeRouteRef.current : undefined;
        const nextActivity = next.activeRoute?.kind === "agent-activity" ? next.activeRoute : undefined;
        if (!nextActivity || !prevActivity || prevActivity.wsHash !== nextActivity.wsHash || prevActivity.agent !== nextActivity.agent) {
          setActivityVm(undefined);
          setActivityImages({});
        }
        activeRouteRef.current = next.activeRoute;
        if (next.studioMountNonce !== studioMountNonceRef.current) {
          studioMountNonceRef.current = next.studioMountNonce;
          setStudioIncoming(undefined);
        }
        setModel(next);
      }
      else if (type === SNAPSHOT && raw.vm) setMissionVm(raw.vm as MissionControlVM);
      else if (type === TASK_ERROR && typeof raw.message === "string") {
        // mission-control's TASK_ERROR and task-detail's TASK_DETAIL_ERROR are the same wire
        // string — see activeRouteRef's doc comment above for why this can't be two `else if`s.
        if (activeRouteRef.current?.kind === "task-detail") {
          setTaskErrorSeq(++taskErrorSeqCounter.current);
          setTaskErrorMessage(raw.message);
        } else {
          setMissionError({
            seq: ++errorSeq.current,
            message: raw.message,
            ...(typeof raw.taskId === "string" ? { taskId: raw.taskId } : {}),
          });
        }
      } else if (type === TASK && raw.vm) {
        setTaskVm(raw.vm as TaskDetailVM);
      } else if (type === ACTIVITY && raw.vm) {
        // t-610705 (Phase C.2, hardening dueto probe-2d90286d) — every Activity message carries its
        // own feed identity (wsHash/agent); reject anything that doesn't match the CURRENT route
        // rather than trusting message-arrival order alone (a delayed post from a torn-down feed
        // must never repopulate whatever feed replaced it).
        const route = activeRouteRef.current;
        if (route?.kind === "agent-activity" && route.wsHash === raw.wsHash && route.agent === raw.agent) {
          setActivityVm(raw.vm as ActivityViewModel);
          setActivityPrepended(raw.prepended === true);
        }
      } else if (type === IMAGE_DATA && typeof raw.id === "string" && typeof raw.dataUri === "string") {
        const route = activeRouteRef.current;
        if (route?.kind === "agent-activity" && route.wsHash === raw.wsHash && route.agent === raw.agent) {
          const id = raw.id;
          const dataUri = raw.dataUri;
          setActivityImages((prev) => (prev[id] ? prev : { ...prev, [id]: dataUri }));
        }
      } else if (type === PROBES && raw.vm) {
        setProbesVm(raw.vm as ProbesVM);
      } else if (type === HANDOFF && raw.vm) {
        setHandoffVm(raw.vm as HandoffViewModel);
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
      } else if (type === "companionPairOffer" && raw.offer && typeof raw.offer === "object") {
        setCompanionPairOffer(raw.offer as CompanionPairOffer);
      } else if (isStudioFreezeBusMessage(raw)) {
        // t-610705 (Phase D, D0, round-3 blocker #3) — dispatched SYNCHRONOUSLY, not through React
        // state, so the mounted studio App's freeze can take effect before any subsequently-queued
        // input event is processed — see studioFreezeBus.ts's module doc for why this can't go
        // through the same setState+useEffect path as everything else in this listener.
        dispatchStudioFreezeMessage(raw);
      } else if (typeof raw.studioProtocolVersion === "number") {
        // t-610705 (Phase D, D0) — studio-envelope core/domain messages (load/error/restore/cwd/
        // save) forward here unmodified; the mounted studio App's own decodeStudioMessage sorts out
        // which is which.
        studioSeq.current += 1;
        setStudioIncoming({ seq: studioSeq.current, message: raw });
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

  const taskDetailDispatch: TaskDetailDispatch = useMemo(
    () => ({
      updateTask: (patch: TaskUpdateInput) => post(updateTaskDetailAction(patch)),
      openTask: (id: string) => post(openTaskDetailAction(id)),
      openStudio: () => post(openTaskDetailStudioAction()),
      refresh: () => post(requestTaskSnapshotAction()),
      approvePrototype: (id, expect, review) => post(approvePrototypeAction(id, expect, review)),
      rejectPrototype: (id, expect, review) => post(rejectPrototypeAction(id, expect, review)),
      notePrototype: (id, expect, review) => post(notePrototypeAction(id, expect, review)),
    }),
    [],
  );

  const activityDispatch: ActivityDispatch = useMemo(
    () => ({
      openFile: (path: string) => post({ type: "openFile", path }),
      terminal: () => post({ type: "terminal" }),
      loadOlder: () => post({ type: "loadOlder" }),
      copyShareText: (sequence, key) => post(copyShareTextMessage(sequence, key)),
      shareExternal: (sequence, key) => post(shareExternalMessage(sequence, key)),
      shareToAgent: (sequence, key) => post(shareToAgentMessage(sequence, key)),
    }),
    [],
  );

  const handoffDispatch: HandoffDispatch = useMemo(
    () => ({
      refresh: () => post(refreshHandoffAction()),
      openFile: () => post(openHandoffFileAction()),
      distillExisting: (agent: string, instructions?: string) => post(distillExistingAction(agent, instructions)),
      distillAdhoc: (profileId: string, args?: string, instructions?: string) => post(distillAdhocAction(profileId, args, instructions)),
    }),
    [],
  );

  // t-610705 (Phase D, D0/D1a) — {post} is the whole contract (StudioDispatch); every studio App
  // posts fully-formed enveloped messages itself (readyMessage/patchMessage/etc.), same as it did as
  // a standalone panel. ONE shared dispatch for every StudioId (D1a — was command-specific) since
  // only one studio binding is ever active at a time.
  const studioDispatch: StudioDispatch = useMemo(() => ({ post }), []);

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
      onOpenSettings={() => post(openSettingsAction())}
      onOpenDoctor={() => post(openDoctorAction())}
      onFleetStart={(name, wsHash) => post(fleetStartAction(name, wsHash))}
      onFleetStop={(name, wsHash) => post(fleetStopAction(name, wsHash))}
      onFleetTerminal={(name, wsHash) => post(fleetTerminalAction(name, wsHash))}
      onFleetActivity={(name, wsHash) => post(fleetActivityAction(name, wsHash))}
      onFleetProbes={(name, wsHash) => post(fleetProbesAction(name, wsHash))}
      onFleetAgentStudio={(name, wsHash) => post(fleetAgentStudioAction(name, wsHash))}
      onRevealPath={(path) => post(revealPathAction(path))}
      onCopyText={(text) => post(copyTextAction(text))}
      onOpenConfigFile={(wsHash) => post(openConfigFileAction(wsHash))}
      onSetCompanionTabTools={(wsHash, enabled) => post(setCompanionTabToolsAction(wsHash, enabled))}
      onSetCompanionAllowedHosts={(wsHash, hosts) => post(setCompanionAllowedHostsAction(wsHash, hosts))}
      onUnpairCompanionDevice={(wsHash) => post(unpairCompanionDeviceAction(wsHash))}
      onIssueCompanionPairCode={(wsHash) => post(issueCompanionPairCodeAction(wsHash))}
      companionPairOffer={companionPairOffer}
      onPost={(action) => post(action)}
      missionVm={missionVm}
      missionError={missionError}
      missionDispatch={missionDispatch}
      taskVm={taskVm}
      taskErrorSeq={taskErrorSeq}
      taskErrorMessage={taskErrorMessage}
      taskDetailDispatch={taskDetailDispatch}
      activityVm={activityVm}
      activityPrepended={activityPrepended}
      activityImages={activityImages}
      activityDispatch={activityDispatch}
      probesVm={probesVm}
      handoffVm={handoffVm}
      handoffDispatch={handoffDispatch}
      studioIncoming={studioIncoming}
      studioDispatch={studioDispatch}
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
        // t-610705 (Phase C.1) — a plain setSection always lands on that section's own top-level
        // route (never a subroute), so any activeRoute left over from a prior task-detail visit
        // must clear optimistically too — the App's render switch checks activeRoute BEFORE
        // section, so a stale task-detail route would otherwise flash until the host's real reply.
        setModel((prev) => (prev ? { ...prev, section, activeRoute: undefined } : prev));
        activeRouteRef.current = undefined;
        // t-610705 (Phase C.2) — same optimistic-clear reasoning as activeRoute above, for the
        // feed-identity state the MODEL branch's reset otherwise only clears on the host's next reply.
        setActivityVm(undefined);
        setActivityImages({});
        post(setSectionAction(section));
        if (section === "mission") post(requestSnapshotAction());
        if (section === "approvals") post(refreshApprovalsAction());
        if (section === "validations") post(refreshValidationsAction());
      }}
      onSwitchWorkspace={(wsHash: string) => {
        // t-d16a39 — optimistic model update (selector reflects the choice instantly); the host
        // re-sends the authoritative scoped model + the active section's module right after.
        setModel((prev) => (prev ? { ...prev, selectedWsHash: wsHash || undefined } : prev));
        setCompanionPairOffer(undefined);
        post(switchControlWorkspaceAction(wsHash));
      }}
    />
  );
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
