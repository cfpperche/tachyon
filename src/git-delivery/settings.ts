import type { TachyonConfig } from "../config/loadConfig.js";
import type { GitDeliverySettings } from "./types.js";

export function resolveGitDeliverySettings(settings: TachyonConfig["settings"] | undefined): GitDeliverySettings {
  const raw = settings?.gitDelivery;
  return {
    prunePrincipals: raw?.prunePrincipals ?? [],
    integratePrincipals: raw?.integratePrincipals ?? [],
  };
}
