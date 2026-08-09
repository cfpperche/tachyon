import type { CockpitModel } from "../../cockpit/model";
import { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export { READY, readyMessage, type ReadyMessage };

/**
 * SDD 500 — one protocol where Overview's and Engine's were two. The union is the whole of it: every
 * action either screen posted survives under one name, because the merge is a merge of surfaces and
 * not a redesign of what they can do (spec.md § Non-goals). `openSection` is still only ever posted by
 * the "waiting on you" counter (t-3bcd57 removed the JUMP card that was its other caller).
 */
export const POLL = "pollSystem" as const;
export const SYSTEM_MODEL = "systemModel" as const;
export const SYSTEM_ERROR = "systemError" as const;

export type SystemAction = ReadyMessage
  | { type: typeof POLL }
  | { type: "openSection"; section: string }
  | { type: "copyDiagnostics" }
  | { type: "openDoctor" }
  | { type: "copyText"; text: string }
  | { type: "engineLogClear"; wsHash: string }
  | { type: "engineLogJournal"; wsHash: string };

export const pollSystemAction = (): SystemAction => ({ type: POLL });
export const systemModelMessage = (model: CockpitModel) => ({ type: SYSTEM_MODEL, model } as const);
export const systemErrorMessage = (message: string) => ({ type: SYSTEM_ERROR, message } as const);
