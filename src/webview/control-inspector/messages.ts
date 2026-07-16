import type { ControlInspectorModel } from "../../control-inspector/model.js";
import { READY } from "../shared/ready.js";

export const INIT = "init" as const;
export const MODEL = "model" as const;

export interface ControlInspectorStrings {
  title: string;
  subtitle: string;
  pocBanner: string;
  refresh: string;
  auto: string;
  empty: string;
  copyDiagnostics: string;
  openServerInspector: string;
  copied: string;
  summary: string;
  workspaces: string;
  engine: string;
  bridge: string;
  workspace: string;
  agents: string;
  notes: string;
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
  attached: string;
  error: string;
  none: string;
  running: string;
  checkedAt: string;
  openTmux: string;
}

export type ControlInspectorAction =
  | { type: typeof READY }
  | { type: "refresh" }
  | { type: "copyDiagnostics" }
  | { type: "openServerInspector" };

export type ControlInspectorHostMessage =
  | { type: typeof INIT; strings: ControlInspectorStrings }
  | { type: typeof MODEL; model: ControlInspectorModel }
  | { type: "toast"; text: string };

export const readyMessage = (): ControlInspectorAction => ({ type: READY });
export const refreshAction = (): ControlInspectorAction => ({ type: "refresh" });
export const copyDiagnosticsAction = (): ControlInspectorAction => ({ type: "copyDiagnostics" });
export const openServerInspectorAction = (): ControlInspectorAction => ({ type: "openServerInspector" });

export const initMessage = (strings: ControlInspectorStrings): ControlInspectorHostMessage => ({ type: INIT, strings });
export const modelMessage = (model: ControlInspectorModel): ControlInspectorHostMessage => ({ type: MODEL, model });
export const toastMessage = (text: string): ControlInspectorHostMessage => ({ type: "toast", text });
