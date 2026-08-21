export const READY = "ready" as const;
export const MODEL = "designModeModel" as const;
export const ERROR = "designModeError" as const;

export interface DesignModeModel {
  enabled: boolean;
  running: boolean;
  cdp: string;
  url: string;
  designModeOn: boolean;
}

export interface DesignModeStrings {
  title: string;
  hint: string;
  off: string;
  disabledTitle: string;
  disabledBody: string;
  openSettings: string;
  armed: string;
  disarmed: string;
  on: string;
  armedBody: string;
  disarmedBody: string;
  revealBrowser: string;
  openBrowser: string;
  disarm: string;
  arm: string;
}

export type DesignModeAction =
  | { type: typeof READY }
  | { type: "openBrowser" }
  | { type: "setDesignMode"; on: boolean }
  | { type: "openSettings" };

export const readyMessage = (): DesignModeAction => ({ type: READY });
export const modelMessage = (model: DesignModeModel) => ({ type: MODEL, model } as const);
export const errorMessage = (message: string) => ({ type: ERROR, message } as const);
