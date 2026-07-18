import type { CockpitModel, CockpitSectionId } from "../../cockpit/model.js";
import { READY } from "../shared/ready.js";

export const INIT = "init" as const;
export const MODEL = "model" as const;

export interface CockpitStrings {
  title: string;
  subtitle: string;
  navOverview: string;
  navEngine: string;
  navFleet: string;
  navApprovals: string;
  navMission: string;
  navValidations: string;
  navWorktrees: string;
  navDeliveries: string;
  navRuntime: string;
  navTmux: string;
  navPlugins: string;
  navSettings: string;
  refresh: string;
  auto: string;
  empty: string;
  copyDiagnostics: string;
  openServerInspector: string;
  openMissionControl: string;
  openPlugins: string;
  openSettings: string;
  openApprovals: string;
  openRuntimeOps: string;
  openDoctor: string;
  copied: string;
  overviewTitle: string;
  overviewHint: string;
  engineTitle: string;
  fleetTitle: string;
  fleetHint: string;
  approvalsTitle: string;
  approvalsHint: string;
  missionTitle: string;
  missionHint: string;
  validationsTitle: string;
  validationsHint: string;
  worktreesTitle: string;
  worktreesHint: string;
  deliveriesTitle: string;
  deliveriesHint: string;
  runtimeTitle: string;
  runtimeHint: string;
  tmuxTitle: string;
  tmuxHint: string;
  pluginsTitle: string;
  pluginsHint: string;
  settingsTitle: string;
  settingsHint: string;
  workspaces: string;
  engines: string;
  agents: string;
  errors: string;
  bridges: string;
  approvals: string;
  worktrees: string;
  deliveries: string;
  attached: string;
  error: string;
  none: string;
  state: string;
  pid: string;
  version: string;
  instance: string;
  started: string;
  bundle: string;
  protocol: string;
  url: string;
  port: string;
  auth: string;
  root: string;
  hash: string;
  running: string;
  stopped: string;
  checkedAt: string;
  open: string;
  noneListed: string;
  kind: string;
  branch: string;
  status: string;
  phase: string;
  path: string;
  name: string;
  start: string;
  stop: string;
  openTerminal: string;
  openActivity: string;
  reveal: string;
  copyPath: string;
  copyId: string;
  openConfig: string;
  settingsBody: string;
  settingsOpenTachyon: string;
  settingsOpenConfig: string;
  settingsDoctor: string;
  declared: string;
  adhoc: string;
  agent: string;
  change: string;
}

export type CockpitAction =
  | { type: typeof READY }
  | { type: "refresh" }
  | { type: "copyDiagnostics" }
  | { type: "openServerInspector" }
  | { type: "openMissionControl" }
  | { type: "openPlugins" }
  | { type: "openSettings" }
  | { type: "openApprovals" }
  | { type: "openRuntimeOps" }
  | { type: "openDoctor" }
  | { type: "setSection"; section: CockpitSectionId }
  | { type: "fleetStart"; name: string; wsHash?: string }
  | { type: "fleetStop"; name: string; wsHash?: string }
  | { type: "fleetTerminal"; name: string; wsHash?: string }
  | { type: "fleetActivity"; name: string; wsHash?: string }
  | { type: "revealPath"; path: string }
  | { type: "copyText"; text: string }
  | { type: "openConfigFile"; wsHash?: string }
  | { type: "engineLogClear"; wsHash: string }
  | { type: "engineLogJournal"; wsHash: string };

export type CockpitHostMessage =
  | { type: typeof INIT; strings: CockpitStrings }
  | { type: typeof MODEL; model: CockpitModel }
  | { type: "toast"; text: string };

export const readyMessage = (): CockpitAction => ({ type: READY });
export const refreshAction = (): CockpitAction => ({ type: "refresh" });
export const copyDiagnosticsAction = (): CockpitAction => ({ type: "copyDiagnostics" });
export const openServerInspectorAction = (): CockpitAction => ({ type: "openServerInspector" });
export const openMissionControlAction = (): CockpitAction => ({ type: "openMissionControl" });
export const openPluginsAction = (): CockpitAction => ({ type: "openPlugins" });
export const openSettingsAction = (): CockpitAction => ({ type: "openSettings" });
export const openApprovalsAction = (): CockpitAction => ({ type: "openApprovals" });
export const openRuntimeOpsAction = (): CockpitAction => ({ type: "openRuntimeOps" });
export const openDoctorAction = (): CockpitAction => ({ type: "openDoctor" });
export const setSectionAction = (section: CockpitSectionId): CockpitAction => ({ type: "setSection", section });
export const fleetStartAction = (name: string, wsHash?: string): CockpitAction => ({
  type: "fleetStart",
  name,
  ...(wsHash ? { wsHash } : {}),
});
export const fleetStopAction = (name: string, wsHash?: string): CockpitAction => ({
  type: "fleetStop",
  name,
  ...(wsHash ? { wsHash } : {}),
});
export const fleetTerminalAction = (name: string, wsHash?: string): CockpitAction => ({
  type: "fleetTerminal",
  name,
  ...(wsHash ? { wsHash } : {}),
});
export const fleetActivityAction = (name: string, wsHash?: string): CockpitAction => ({
  type: "fleetActivity",
  name,
  ...(wsHash ? { wsHash } : {}),
});
export const revealPathAction = (path: string): CockpitAction => ({ type: "revealPath", path });
export const copyTextAction = (text: string): CockpitAction => ({ type: "copyText", text });
export const openConfigFileAction = (wsHash?: string): CockpitAction => ({
  type: "openConfigFile",
  ...(wsHash ? { wsHash } : {}),
});
export const engineLogClearAction = (wsHash: string): CockpitAction => ({ type: "engineLogClear", wsHash });
export const engineLogJournalAction = (wsHash: string): CockpitAction => ({ type: "engineLogJournal", wsHash });

export const initMessage = (strings: CockpitStrings): CockpitHostMessage => ({ type: INIT, strings });
export const modelMessage = (model: CockpitModel): CockpitHostMessage => ({ type: MODEL, model });
export const toastMessage = (text: string): CockpitHostMessage => ({ type: "toast", text });
