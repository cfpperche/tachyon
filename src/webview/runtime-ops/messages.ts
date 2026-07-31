import {
  unavailableRuntimeOpsSnapshot,
  type RuntimeOpsProviderV2,
  type RuntimeOpsSnapshot,
} from "../../runtimeOps/types";
import type { InspectedSession } from "../../runtimeOps/sessionInspection";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export const RUNTIME_OPS_SNAPSHOT = "runtimeOpsSnapshot" as const;
export const RUNTIME_OPS_LOADING = "runtimeOpsLoading" as const;
export const RUNTIME_OPS_SET_PROVIDER_OBSERVATION = "runtimeOpsSetProviderObservation" as const;
export const RUNTIME_OPS_INSPECT_SESSION = "runtimeOpsInspectSession" as const;
export const RUNTIME_OPS_SESSION_INSPECTION = "runtimeOpsSessionInspection" as const;

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

/**
 * t-283149 — one agent's session inspection, requested on expand rather than carried by the snapshot.
 *
 * The snapshot is a fleet-wide poll; reading `/proc` and four settings files for every agent on every
 * refresh would pay that cost for rows nobody opened. Keyed by `agentKey` (`<wsHash>:<name>`, the same
 * identity the snapshot's agent rows carry) so a reply that arrives after the person collapsed one row
 * and opened another lands on the row it belongs to.
 */
export interface RuntimeOpsInspectSessionAction {
  type: typeof RUNTIME_OPS_INSPECT_SESSION;
  workspaceKey: string;
  agent: string;
}

export interface RuntimeOpsSessionInspectionMessage {
  type: typeof RUNTIME_OPS_SESSION_INSPECTION;
  agentKey: string;
  /** Present on success. Absent with `error` set when the host could not inspect. */
  inspection?: InspectedSession;
  error?: string;
}

/** Per-row state for an expanded agent: the request is in flight, it answered, or it failed. */
export type SessionInspectionState =
  | { status: "loading" }
  | { status: "ready"; inspection: InspectedSession }
  | { status: "error"; message: string };

export function runtimeOpsInspectSessionAction(workspaceKey: string, agent: string): RuntimeOpsInspectSessionAction {
  return { type: RUNTIME_OPS_INSPECT_SESSION, workspaceKey, agent };
}

export function runtimeOpsSessionInspectionMessage(
  agentKey: string,
  result: { inspection: InspectedSession } | { error: string },
): RuntimeOpsSessionInspectionMessage {
  return { type: RUNTIME_OPS_SESSION_INSPECTION, agentKey, ...result };
}

export function isRuntimeOpsInspectSessionAction(value: unknown): value is RuntimeOpsInspectSessionAction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  return Object.keys(action).length === 3
    && action.type === RUNTIME_OPS_INSPECT_SESSION
    && typeof action.workspaceKey === "string" && action.workspaceKey.length > 0
    && typeof action.agent === "string" && action.agent.length > 0;
}

export type RuntimeOpsHostMessage =
  | RuntimeOpsSnapshotMessage
  | RuntimeOpsLoadingMessage
  | RuntimeOpsSessionInspectionMessage;

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
