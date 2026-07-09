import type { TachyonConfig } from "../config/loadConfig.js";
import type { GitDeliveryProfile, GitDeliverySettings } from "./types.js";

const PROFILE_DEFAULTS: Record<GitDeliveryProfile, Omit<GitDeliverySettings, "profile" | "prunePrincipals" | "integratePrincipals">> = {
  solo: { autoOpen: false, requireNonSelfAccept: false, autoPrune: false },
  balanced: { autoOpen: true, requireNonSelfAccept: false, autoPrune: false },
  strict: { autoOpen: true, requireNonSelfAccept: true, autoPrune: false },
  custom: { autoOpen: false, requireNonSelfAccept: false, autoPrune: false },
};

export function resolveGitDeliverySettings(settings: TachyonConfig["settings"] | undefined): GitDeliverySettings {
  const raw = settings?.gitDelivery;
  const profile = raw?.profile ?? "balanced";
  const base = PROFILE_DEFAULTS[profile];
  return {
    profile,
    autoOpen: raw?.autoOpen ?? base.autoOpen,
    requireNonSelfAccept: raw?.requireNonSelfAccept ?? base.requireNonSelfAccept,
    autoPrune: raw?.autoPrune ?? base.autoPrune,
    prunePrincipals: raw?.prunePrincipals ?? [],
    integratePrincipals: raw?.integratePrincipals ?? [],
  };
}
