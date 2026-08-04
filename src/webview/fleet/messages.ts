import type { CockpitModel } from "../../cockpit/model";
import { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export { READY, readyMessage, type ReadyMessage };
export const POLL = "pollFleet" as const;
export const FLEET_MODEL = "fleetModel" as const;
export const FLEET_ERROR = "fleetError" as const;

export type FleetAction = ReadyMessage
  | { type: typeof POLL }
  | { type: "openBoard" }
  | { type: "fleetStart"; name: string; wsHash?: string }
  | { type: "fleetStop"; name: string; wsHash?: string }
  | { type: "fleetTerminal"; name: string; wsHash?: string }
  | { type: "fleetActivity"; name: string; wsHash?: string }
  | { type: "fleetProbes"; name: string; wsHash?: string }
  | { type: "fleetAgentStudio"; name: string; wsHash?: string }
  | { type: "fleetContinueTask"; name: string; toName: string; wsHash?: string };

export const pollFleetAction = (): FleetAction => ({ type: POLL });
export const fleetModelMessage = (model: CockpitModel) => ({ type: FLEET_MODEL, model } as const);
export const fleetErrorMessage = (message: string) => ({ type: FLEET_ERROR, message } as const);
