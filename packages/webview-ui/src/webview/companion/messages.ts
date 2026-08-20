import type { CompanionSettings } from "../../sections/model.js";
import { readyMessage as sharedReady } from "../shared/ready.js";
export const MODEL = "companionModel" as const;
export const POLL = "pollCompanion" as const;
export type CompanionModel = { companion?: CompanionSettings; needsWorkspacePick?: boolean };
export const readyMessage = () => sharedReady();
export const pollMessage = () => ({ type: POLL } as const);
