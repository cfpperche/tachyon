import type { CallerSnapshot } from "../bridge/callerIdentity.js";
import type { TachyonConfig } from "../config/loadConfig.js";
import type { AuthorityIntegrity } from "./authorityIntegrity.js";

export const DELIVERY_SCHEMA_VERSION = 1;

export interface DeliveryActor {
  kind: CallerSnapshot["kind"] | "system";
  name?: string;
}

export interface DeliveryContract {
  taskId?: string;
  baseSha: string;
  behaviorTest: string;
  owns: string[];
  taskRef: string;
  stubPath?: string;
  oracleHash?: string;
  executorHashes?: Record<string, string>;
  verifySettings?: TachyonConfig["settings"]["verify"];
}

export type DeliveryLeaseState = "free" | "pending" | "held" | "draining" | "verifying" | "quarantined" | "abandoned";

/**
 * t-cc6495 — what a caller refused because of this lease state is supposed to DO about it.
 *
 * A governed refusal that names no way forward pushes the operator out of the governed flow: the
 * next move becomes raw git or raw sqlite, which is the failure t-0cbcbd describes. The refusal
 * already carried `next: { action: "delivery_salvage" }`, but only for `held` and `quarantined`,
 * while the guard that produces it refuses EVERY state that is not `free`/`held`. So a caller
 * refused because a lease was `pending` or `draining` got a dead end and no hint.
 *
 * The point of this map is not that every state gets an action — some genuinely resolve on their
 * own — it is that "nothing to do" becomes a DECLARATION rather than an omission. `null` says a
 * human deliberately concluded the state is transitional; a missing key says nobody thought about
 * it, and the exhaustive `Record` makes the compiler refuse the second one when a state is added.
 */
export type LeaseDisposition =
  /**
   * t-e88c8a stage 1 — the `action` arm is gone. It named `delivery_salvage` and
   * `git_delivery_reconcile`, and both tools were retired with the rest of the Delivery surface. A
   * disposition pointing at a tool that no longer exists is the dead end wearing a helpful face —
   * exactly what this map was written to prevent — so the states that used it now say plainly that
   * no governed action remains, rather than naming one that would 404.
   */
  | { kind: "unavailable"; why: string }
  /** Terminal: the lease holds nothing, so there is nothing to dispose of. */
  | { kind: "terminal" }
  /** Transitional: it clears without operator action. `why` is shown, so the caller knows to retry. */
  | { kind: "transitional"; why: string };

export const LEASE_DISPOSITION: Record<DeliveryLeaseState, LeaseDisposition> = {
  free: { kind: "terminal" },
  abandoned: { kind: "terminal" },
  // A contender is mid-CAS; the winner settles it within one mutation.
  pending: { kind: "transitional", why: "another contender is mid-transition; retry" },
  // Releasing its tail. Becomes free or quarantined on its own.
  draining: { kind: "transitional", why: "the lease is releasing its tail; retry shortly" },
  held: { kind: "unavailable", why: "the governed salvage action was retired with the Delivery tools" },
  quarantined: { kind: "unavailable", why: "the governed salvage action was retired with the Delivery tools" },
  // A verification owns it. Reconciliation used to free it; that tool is retired too.
  verifying: { kind: "unavailable", why: "the governed reconcile action was retired with the Delivery tools" },
};

export interface DeliveryProcessIdentity {
  pid: number;
  processStart: string;
  bootId: string;
}

export interface DeliveryLeaseHolder {
  segmentId: string;
  executionAgent: string;
  principal?: string;
  process?: DeliveryProcessIdentity;
  reservationNonce?: string;
  executionNonce?: string;
}

export interface DeliveryVerificationPriorLease {
  state: "free" | "held";
  holder?: DeliveryLeaseHolder;
  expectedHeadSha?: string;
  reason?: string;
  changedAt: string;
}

export interface DeliveryVerificationIntent {
  nonce: string;
  ownerEpoch: string;
  actor: DeliveryActor;
  subjectSegmentId: string;
  deliveredHeadSha: string;
  temporaryCheckoutSha?: string;
  startedAt: string;
  operationId: string;
  priorLease: DeliveryVerificationPriorLease;
}

export interface DeliveryLease {
  state: DeliveryLeaseState;
  holder?: DeliveryLeaseHolder;
  expectedHeadSha?: string;
  reason?: string;
  verification?: DeliveryVerificationIntent;
  changedAt: string;
}

export type DelegationSegmentRole = "implementer" | "reviewer" | "fixer" | "recovery" | "verifier";

export interface DelegationSegment {
  id: string;
  index: number;
  role: DelegationSegmentRole;
  executionAgent: string;
  principal?: string;
  grantedBy: DeliveryActor;
  ownsSubset: string[];
  grantedHeadSha: string;
  grantedAt: string;
  releasedHeadSha?: string;
  releasedAt?: string;
  outcome?: "completed" | "interrupted" | "rejected";
}

export interface DeliveryEvent {
  id: string;
  at: string;
  type: string;
  by: DeliveryActor;
  detail?: Record<string, unknown>;
}

export interface Delivery {
  schemaVersion: 1;
  id: string;
  version: number;
  workspaceId: string;
  createdBy: DeliveryActor;
  contract: DeliveryContract;
  lease: DeliveryLease;
  segments: DelegationSegment[];
  events: DeliveryEvent[];
  gitDeliveryId?: string;
  createdAt: string;
  updatedAt: string;
  /** Host-authenticated seal over the complete durable authority record. */
  authorityIntegrity?: AuthorityIntegrity;
}

/** Exact public receipt for creation of a new tracked canonical Delivery. */
export interface CanonicalDeliverySpawnReceipt {
  deliveryId: string;
  projectionId: string;
  segmentId: string;
  worktree: string;
  branch: string;
  head: string;
}

export interface DeliveryCreateInput {
  id?: string;
  workspaceId: string;
  createdBy: DeliveryActor;
  contract: DeliveryContract;
  lease?: DeliveryLease;
  segments?: DelegationSegment[];
  events?: DeliveryEvent[];
  gitDeliveryId?: string;
  /** Stable caller-supplied key used to replay a create after its response was lost. */
  operationId?: string;
}

export interface DeliveryMutationOptions {
  /** Stable caller-supplied key used to replay a committed mutation exactly once. */
  operationId?: string;
  /** Serializable, stable description of the caller's intended mutation. Required with operationId. */
  intent?: unknown;
}

export interface DeliveryStoreCapabilityContext {
  workspaceRoot: string;
  databasePath: string;
  runtimeNodeVersion: string;
  filesystemType: number;
}

export type DeliveryStoreCapability =
  | { supported: true; domain: string }
  | { supported: false; reason: string };

export type DeliveryStoreCapabilityValidator =
  (context: DeliveryStoreCapabilityContext) => DeliveryStoreCapability;

export type DeliveryStoreErrorCode = "DELIVERY_STORE_UNSUPPORTED" | "DELIVERY_STORE_BUSY";

export interface StructuredDeliveryStoreError {
  code: DeliveryStoreErrorCode;
  retryable: boolean;
}

export interface DeliveryCorruptRecord {
  id: string;
  path: string;
  error: string;
}

/** Owner identity for a durable per-Delivery projection claim (SDD 368 T15). */
export interface DeliveryProjectionOwnerIdentity {
  pid: number;
  processStart: string;
  bootId: string;
  /** Linux PID-namespace inode identity (e.g. from `/proc/self/ns/pid`). */
  pidNamespace: string;
}

/**
 * Opaque claim capability returned by `DeliveryStore.claimProjection`.
 * Only the projection service may pair this with `updateUnderProjectionClaim`.
 */
export interface DeliveryProjectionClaimCapability {
  readonly deliveryId: string;
  readonly nonce: string;
}

export type DeliveryProjectionAction = "open" | "integrate" | "prune";

/** Typed detail for append-only `projection.intent` Delivery events. */
export interface DeliveryProjectionIntentDetail {
  projectionSequence: number;
  operationId: string;
  gitDeliveryId: string;
  action: DeliveryProjectionAction;
  expected: {
    deliveryVersion?: number;
    gitDeliveryVersion?: number;
    headSha?: string;
    baseRef?: string;
    branchRef?: string;
    worktreePath?: string;
    phase?: string;
    abandon?: boolean;
    forceLoseCommits?: boolean;
    doomedShas?: string[];
  };
  actor: DeliveryActor;
  payload: Record<string, unknown>;
}

export const PROJECTION_INTENT_EVENT_TYPE = "projection.intent";
