import type { RuntimeConfigControlSnapshot } from "../../runtimeConfig/types.js";

export const RUNTIME_CONFIG_SNAPSHOT = "runtimeConfigSnapshot" as const;
export const RUNTIME_CONFIG_SNAPSHOT_UNAVAILABLE = "runtimeConfigSnapshotUnavailable" as const;

export interface RuntimeConfigSnapshotMessage {
  type: typeof RUNTIME_CONFIG_SNAPSHOT;
  snapshot: RuntimeConfigControlSnapshot;
}

export function runtimeConfigSnapshotMessage(snapshot: RuntimeConfigControlSnapshot): RuntimeConfigSnapshotMessage {
  return { type: RUNTIME_CONFIG_SNAPSHOT, snapshot };
}

export interface RuntimeConfigSnapshotUnavailableMessage {
  type: typeof RUNTIME_CONFIG_SNAPSHOT_UNAVAILABLE;
}

export function runtimeConfigSnapshotUnavailableMessage(): RuntimeConfigSnapshotUnavailableMessage {
  return { type: RUNTIME_CONFIG_SNAPSHOT_UNAVAILABLE };
}
