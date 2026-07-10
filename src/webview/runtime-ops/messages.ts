import type { RuntimeOpsSnapshotV1 } from "../../runtimeOps/types";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export const RUNTIME_OPS_SNAPSHOT = "runtimeOpsSnapshot" as const;

export interface RuntimeOpsSnapshotMessage {
  type: typeof RUNTIME_OPS_SNAPSHOT;
  snapshot: RuntimeOpsSnapshotV1;
}

export function runtimeOpsSnapshotMessage(snapshot: RuntimeOpsSnapshotV1): RuntimeOpsSnapshotMessage {
  return { type: RUNTIME_OPS_SNAPSHOT, snapshot };
}

export type RuntimeOpsHostMessage = RuntimeOpsSnapshotMessage;
