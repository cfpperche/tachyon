import { unavailableRuntimeOpsSnapshot, type RuntimeOpsSnapshotV1 } from "../../runtimeOps/types";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export const RUNTIME_OPS_SNAPSHOT = "runtimeOpsSnapshot" as const;
export const RUNTIME_OPS_LOADING = "runtimeOpsLoading" as const;

export interface RuntimeOpsSnapshotMessage {
  type: typeof RUNTIME_OPS_SNAPSHOT;
  snapshot: RuntimeOpsSnapshotV1;
}

/** Explicit host state so previews and a later refresh can show the same loading surface as initial mount. */
export interface RuntimeOpsLoadingMessage {
  type: typeof RUNTIME_OPS_LOADING;
}

export function runtimeOpsSnapshotMessage(snapshot: RuntimeOpsSnapshotV1): RuntimeOpsSnapshotMessage {
  return { type: RUNTIME_OPS_SNAPSHOT, snapshot };
}

export function runtimeOpsLoadingMessage(): RuntimeOpsLoadingMessage {
  return { type: RUNTIME_OPS_LOADING };
}

export function runtimeOpsSnapshotUnavailableMessage(): RuntimeOpsSnapshotMessage {
  return runtimeOpsSnapshotMessage(unavailableRuntimeOpsSnapshot());
}

export type RuntimeOpsHostMessage = RuntimeOpsSnapshotMessage | RuntimeOpsLoadingMessage;
