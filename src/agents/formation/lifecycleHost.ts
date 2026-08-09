import path from "node:path";
import { FormationAuthorityStore } from "./authorityStore.js";
import type { FormationLifecyclePort } from "./lifecycleConsumer.js";

export interface FormationLifecycleHostInput {
  hostRoot: string;
  agentIdOf: (agentName: string) => string | undefined;
  now?: () => string;
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
    verifyNativeSuppression: () => false,
  });
  return {
    suppressionRequired(agentName): boolean {
      const agentId = input.agentIdOf(agentName);
      if (!agentId) return false;
      const vector = store.currentVector(agentId);
      return !!vector && Object.values(vector.profile.lanes).some((lane) => lane.mode === "profile");
    },
  };
}
