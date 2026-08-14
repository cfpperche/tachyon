import type {
  RuntimeConfigChange,
  RuntimeConfigControlSnapshot,
  RuntimeConfigRuntime,
} from "../../runtimeConfig/types.js";

export const READY = "ready" as const;
export const POLL = "pollRuntimeConfig" as const;

export interface RuntimeConfigStrings {
  none: string;
  runtimeConfigAlwaysThinking: string;
  runtimeConfigCapabilities: string;
  runtimeConfigClaude: string;
  runtimeConfigCodex: string;
  runtimeConfigConfigured: string;
  runtimeConfigDetected: string;
  runtimeConfigEditable: string;
  runtimeConfigFolderTrust: string;
  runtimeConfigGlobalConfig: string;
  runtimeConfigGlobalSettings: string;
  runtimeConfigGlobalWarning: string;
  runtimeConfigGrok: string;
  runtimeConfigHiddenRecords: string;
  runtimeConfigHint: string;
  runtimeConfigOpaqueSections: string;
  runtimeConfigOpenFile: string;
  runtimeConfigOther: string;
  runtimeConfigOverriddenBy: string;
  runtimeConfigReadError: string;
  runtimeConfigReadOnly: string;
  runtimeConfigReadOnlyDocument: string;
  runtimeConfigReducedMotion: string;
  runtimeConfigRuntime: string;
  runtimeConfigSave: string;
  runtimeConfigScope: string;
  runtimeConfigSourceFile: string;
  runtimeConfigSpinnerTips: string;
  runtimeConfigTerminalProgress: string;
  runtimeConfigTheme: string;
  runtimeConfigTitle: string;
  runtimeConfigTurnDuration: string;
  runtimeConfigUnavailable: string;
  runtimeConfigUnset: string;
  runtimeConfigUsedBy: string;
  runtimeConfigViewRaw: string;
  runtimeConfigWorkspaceConfig: string;
  runtimeConfigWorkspaceMcp: string;
  runtimeConfigWorkspaceSettings: string;
}

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

export const readyMessage = () => ({ type: READY });
export const pollRuntimeConfigAction = () => ({ type: POLL });
export const openRuntimeConfigSourceAction = (path: string) => ({ type: "openRuntimeConfigSource", path });
export const saveRuntimeConfigChangesAction = (
  runtime: RuntimeConfigRuntime,
  documentId: string,
  expectedRevision: string | undefined,
  changes: RuntimeConfigChange[],
) => ({ type: "saveRuntimeConfigChanges", runtime, documentId, expectedRevision, changes });
