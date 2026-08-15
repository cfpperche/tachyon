import path from "node:path";
import { isNativeSuppressionConfirmed } from "../../runtime/nativeLaneSuppression.js";
import { FormationAuthorityStore } from "./authorityStore.js";
import type { FormationLifecyclePort } from "./lifecycleConsumer.js";

export interface FormationLifecycleHostInput {
  hostRoot: string;
  agentIdOf: (agentName: string) => string | undefined;
  now?: () => string;
}

/**
 * Recheck used at snapshot publication. This host is read-only, so the store never invokes it
 * on the spawn path; it still must not be `() => false` for every adapter (t-4c3d90).
 * MAC verification of a receipt belongs on a write host that holds the suppression key.
 */
export function verifyLifecycleNativeSuppression(input: { evidence: { runtimeAdapter: string } }): boolean {
  return isNativeSuppressionConfirmed(input.evidence.runtimeAdapter);
}

/** Read-only lifecycle seam that decides whether runtime-native lanes must be suppressed. */
export function createFormationLifecycleHost(input: FormationLifecycleHostInput): FormationLifecyclePort {
  const store = new FormationAuthorityStore(path.join(input.hostRoot, "formation"), {
    now: input.now,
    authorizeLaunch: () => true,
    resolvePayload: () => {
      throw new Error("formation lifecycle host is read-only: payload publication is unavailable");
    },
    authorizeMutation: () => false,
    authorizeSelectorRevocation: () => false,
    authorizeSelectorRead: () => false,
    verifyNativeSuppression: verifyLifecycleNativeSuppression,
  });
  return {
    suppressionRequired(agentName): boolean {
      const agentId = input.agentIdOf(agentName);
      if (!agentId) return false;
      const vector = store.currentVector(agentId);
      return !!vector && Object.values(vector.profile.lanes).some((lane) => lane.mode === "profile");
    },
    nativeSuppressionConfirmed: isNativeSuppressionConfirmed,
  };
}
