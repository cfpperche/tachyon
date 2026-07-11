import type { CallerSnapshot } from "../bridge/callerIdentity.js";

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
}

export type DeliveryLeaseState = "free" | "pending" | "held" | "draining" | "verifying" | "quarantined";

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
}

export interface DeliveryLease {
  state: DeliveryLeaseState;
  holder?: DeliveryLeaseHolder;
  expectedHeadSha?: string;
  reason?: string;
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

export interface DeliveryLegacySource {
  delegationId?: string;
  sourcePath?: string;
  importedAt?: string;
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
  legacy?: DeliveryLegacySource;
  createdAt: string;
  updatedAt: string;
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
  legacy?: DeliveryLegacySource;
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
