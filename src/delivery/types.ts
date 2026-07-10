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
}

export interface DeliveryLockOwner {
  schemaVersion: 1;
  nonce: string;
  pid: number;
  processStart: string;
  bootId: string;
  acquiredAt: string;
}

export interface DeliveryCorruptRecord {
  id: string;
  path: string;
  error: string;
}
