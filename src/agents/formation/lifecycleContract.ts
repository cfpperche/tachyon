import { FORMATION_GOVERNED_LANES } from "./sessionPolicy.js";
import type { FormationLaneName } from "./domain.js";

export const FORMATION_LIFECYCLE_CONTRACT_VERSION = 1 as const;

export interface FormationLaneLifecycleHook {
  readonly lane: FormationLaneName;
  inspect(agentId: string): unknown | Promise<unknown>;
  recover(agentId: string): unknown | Promise<unknown>;
  retire(agentId: string): unknown | Promise<unknown>;
  /** Clone/import may only stage inactive bytes; activation remains lane-authorized. */
  importInactiveCandidate?(agentId: string, source: unknown): unknown | Promise<unknown>;
}

export interface FormationLifecycleConsumerContract {
  readonly schemaVersion: typeof FORMATION_LIFECYCLE_CONTRACT_VERSION;
  readonly hooks: Readonly<Record<FormationLaneName, FormationLaneLifecycleHook>>;
}

/** The lifecycle orchestrator consumes exactly one hook per governed lane; plugins are not a lane. */
export function formationLifecycleConsumerContract(
  hooks: readonly FormationLaneLifecycleHook[],
): FormationLifecycleConsumerContract {
  const byLane = new Map<FormationLaneName, FormationLaneLifecycleHook>();
  for (const hook of hooks) {
    if (!FORMATION_GOVERNED_LANES.includes(hook.lane) || byLane.has(hook.lane)) {
      throw new Error(`invalid or duplicate formation lifecycle lane '${hook.lane}'`);
    }
    byLane.set(hook.lane, hook);
  }
  for (const lane of FORMATION_GOVERNED_LANES) {
    if (!byLane.has(lane)) throw new Error(`formation lifecycle hook '${lane}' is missing`);
  }
  return Object.freeze({
    schemaVersion: FORMATION_LIFECYCLE_CONTRACT_VERSION,
    hooks: Object.freeze(Object.fromEntries(byLane) as Record<FormationLaneName, FormationLaneLifecycleHook>),
  });
}
