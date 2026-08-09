import type { SectionsModel } from "../../sections/model.js";
import { READY, readyMessage, type ReadyMessage } from "../shared/ready.js";

export { READY, readyMessage, type ReadyMessage };
export const POLL = "pollSettings" as const;
export const MODEL = "settingsModel" as const;
export const pairOfferMessageType = "companionPairOffer" as const;
export type SettingsAction = ReadyMessage | { type: typeof POLL };
export const pollSettingsAction = (): SettingsAction => ({ type: POLL });
export const settingsModelMessage = (model: SectionsModel) => ({ type: MODEL, model } as const);
