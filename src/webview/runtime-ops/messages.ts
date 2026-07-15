import {
  unavailableRuntimeOpsSnapshot,
  type RuntimeOpsProviderV2,
  type RuntimeOpsSnapshot,
} from "../../runtimeOps/types";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export const RUNTIME_OPS_SNAPSHOT = "runtimeOpsSnapshot" as const;
export const RUNTIME_OPS_LOADING = "runtimeOpsLoading" as const;
export const RUNTIME_OPS_SET_PROVIDER_OBSERVATION = "runtimeOpsSetProviderObservation" as const;

export interface RuntimeOpsSnapshotMessage {
  type: typeof RUNTIME_OPS_SNAPSHOT;
  snapshot: RuntimeOpsSnapshot;
}

/** Explicit host state so previews and a later refresh can show the same loading surface as initial mount. */
export interface RuntimeOpsLoadingMessage {
  type: typeof RUNTIME_OPS_LOADING;
}

export interface RuntimeOpsSetProviderObservationAction {
  type: typeof RUNTIME_OPS_SET_PROVIDER_OBSERVATION;
  provider: RuntimeOpsProviderV2;
  enabled: boolean;
}

export function runtimeOpsSnapshotMessage(snapshot: RuntimeOpsSnapshot): RuntimeOpsSnapshotMessage {
  return { type: RUNTIME_OPS_SNAPSHOT, snapshot };
}

export function runtimeOpsLoadingMessage(): RuntimeOpsLoadingMessage {
  return { type: RUNTIME_OPS_LOADING };
}

export function runtimeOpsSnapshotUnavailableMessage(): RuntimeOpsSnapshotMessage {
  return runtimeOpsSnapshotMessage(unavailableRuntimeOpsSnapshot());
}

export type RuntimeOpsHostMessage = RuntimeOpsSnapshotMessage | RuntimeOpsLoadingMessage;

export function runtimeOpsSetProviderObservationAction(
  provider: RuntimeOpsProviderV2,
  enabled: boolean,
): RuntimeOpsSetProviderObservationAction {
  return { type: RUNTIME_OPS_SET_PROVIDER_OBSERVATION, provider, enabled };
}

export function isRuntimeOpsSetProviderObservationAction(
  value: unknown,
): value is RuntimeOpsSetProviderObservationAction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  return Object.keys(action).length === 3
    && action.type === RUNTIME_OPS_SET_PROVIDER_OBSERVATION
    && (action.provider === "codex" || action.provider === "claude")
    && typeof action.enabled === "boolean";
}
