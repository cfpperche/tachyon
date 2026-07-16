import type { CockpitModel, CockpitSectionId } from "../../cockpit/model.js";
import { READY } from "../shared/ready.js";

export const INIT = "init" as const;
export const MODEL = "model" as const;

export interface CockpitStrings {
  title: string;
  subtitle: string;
  pocBanner: string;
  navOverview: string;
  navEngine: string;
  navFleet: string;
  navTmux: string;
  refresh: string;
  auto: string;
  empty: string;
  copyDiagnostics: string;
  openServerInspector: string;
  openMissionControl: string;
  copied: string;
  overviewTitle: string;
  overviewHint: string;
  engineTitle: string;
  fleetTitle: string;
  fleetBody: string;
  tmuxTitle: string;
  tmuxBody: string;
  workspaces: string;
  engines: string;
  agents: string;
  errors: string;
  bridges: string;
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
  checkedAt: string;
  sidebarNote: string;
}

export type CockpitAction =
  | { type: typeof READY }
  | { type: "refresh" }
  | { type: "copyDiagnostics" }
  | { type: "openServerInspector" }
  | { type: "openMissionControl" }
  | { type: "setSection"; section: CockpitSectionId };

export type CockpitHostMessage =
  | { type: typeof INIT; strings: CockpitStrings }
  | { type: typeof MODEL; model: CockpitModel }
  | { type: "toast"; text: string };

export const readyMessage = (): CockpitAction => ({ type: READY });
export const refreshAction = (): CockpitAction => ({ type: "refresh" });
export const copyDiagnosticsAction = (): CockpitAction => ({ type: "copyDiagnostics" });
export const openServerInspectorAction = (): CockpitAction => ({ type: "openServerInspector" });
export const openMissionControlAction = (): CockpitAction => ({ type: "openMissionControl" });
export const setSectionAction = (section: CockpitSectionId): CockpitAction => ({ type: "setSection", section });

export const initMessage = (strings: CockpitStrings): CockpitHostMessage => ({ type: INIT, strings });
export const modelMessage = (model: CockpitModel): CockpitHostMessage => ({ type: MODEL, model });
export const toastMessage = (text: string): CockpitHostMessage => ({ type: "toast", text });
