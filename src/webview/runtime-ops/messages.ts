import {
  unavailableRuntimeOpsSnapshot,
  type RuntimeOpsProviderV2,
  type RuntimeOpsSnapshot,
} from "../../runtimeOps/types";
import type { InspectedSession } from "../../runtimeOps/sessionInspection";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

/**
 * SDD 485 D3 — webview → host: "re-read the snapshot, nothing has been asked for". The app's own 3s timer,
 * which is the timer CONTROL used to own: inside Control the runtime snapshot was re-posted as a side
 * effect of `sendSectionModule()` running every three seconds for whatever section was active, so this
 * surface never had a refresh message of its own at all.
 *
 * D2 had to separate this word from `refresh` because Plugins' `refresh` carried a side effect (dropping
 * every update check) that a periodic re-gather must not have. The check was run here before assuming the
 * same, and the answer is different: **Runtime Ops has no `refresh` message and never had one** — the only
 * two things this client ever posts are the two actions below. So there is no word to collide with, and
 * `POLL` is minted rather than borrowed for the opposite reason: it keeps `refresh` FREE, so a future
 * human-pressed Refresh button can mean whatever it needs to without inheriting the poll's meaning. The
 * word the gate claims and the word a human presses are separate by construction, in the same shape D2
 * arrived at by paying for it.
 */
export const POLL = "runtimeOpsPoll" as const;
export interface RuntimeOpsPollAction {
  type: typeof POLL;
}
export function runtimeOpsPollAction(): RuntimeOpsPollAction {
  return { type: POLL };
}

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
