import type { CockpitModel } from "../../cockpit/model";
import { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export { READY, readyMessage, type ReadyMessage };
export const POLL = "pollOverview" as const;
export const OVERVIEW_MODEL = "overviewModel" as const;

export type OverviewAction = ReadyMessage
  | { type: typeof POLL }
  | { type: "openSection"; section: string }
  | { type: "openDoctor" }
  | { type: "copyDiagnostics" };

export const pollOverviewAction = (): OverviewAction => ({ type: POLL });
export const overviewModelMessage = (model: CockpitModel) => ({ type: OVERVIEW_MODEL, model } as const);
