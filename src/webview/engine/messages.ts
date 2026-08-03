import type { CockpitModel } from "../../cockpit/model";
import { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export { READY, readyMessage, type ReadyMessage };
export const POLL = "pollEngine" as const;
export const ENGINE_MODEL = "engineModel" as const;
export const ENGINE_ERROR = "engineError" as const;

export type EngineAction = ReadyMessage
  | { type: typeof POLL }
  | { type: "openDoctor" }
  | { type: "copyText"; text: string }
  | { type: "engineLogClear"; wsHash: string }
  | { type: "engineLogJournal"; wsHash: string };

export const pollEngineAction = (): EngineAction => ({ type: POLL });
export const engineModelMessage = (model: CockpitModel) => ({ type: ENGINE_MODEL, model } as const);
export const engineErrorMessage = (message: string) => ({ type: ENGINE_ERROR, message } as const);
