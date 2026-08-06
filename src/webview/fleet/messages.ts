import type { FleetVM } from "../../sidebar/types";
import type { ActionId } from "../../sidebar/actions";
import { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export { READY, readyMessage, type ReadyMessage };
export const POLL = "pollFleet" as const;
export const FLEET_MODEL = "fleetModel" as const;
export const FLEET_ERROR = "fleetError" as const;

/**
 * t-41117e — Fleet tab message envelope.
 * Host pushes one project's FleetVM (same shape as the sidebar), not CockpitModel.fleet.
 */
export type FleetAction = ReadyMessage
  | { type: typeof POLL }
  | { type: "openBoard" }
  | { type: "action"; id: ActionId; agent: string }
  | { type: "continueTask"; fromName: string; toName: string };

export const pollFleetAction = (): FleetAction => ({ type: POLL });
export const fleetModelMessage = (fleet: FleetVM) => ({ type: FLEET_MODEL, fleet } as const);
export const fleetErrorMessage = (message: string) => ({ type: FLEET_ERROR, message } as const);
