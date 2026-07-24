import type { CodexRuntimeConfigInventory } from "../../runtimeConfig/codexInventory.js";

export const RUNTIME_CONFIG_SNAPSHOT = "runtimeConfigSnapshot" as const;

export interface RuntimeConfigSnapshotMessage {
  type: typeof RUNTIME_CONFIG_SNAPSHOT;
  snapshot: CodexRuntimeConfigInventory;
}

export function runtimeConfigSnapshotMessage(snapshot: CodexRuntimeConfigInventory): RuntimeConfigSnapshotMessage {
  return { type: RUNTIME_CONFIG_SNAPSHOT, snapshot };
}
