import type { CallerSnapshot } from "../bridge/callerIdentity.js";

export const GIT_DELIVERY_SCHEMA_VERSION = 1;

export type GitDeliveryPhase =
  | "open"
  | "in_review"
  | "accepted"
  | "changes_requested"
  | "integrated"
  | "integrated_unverified"
  | "abandoned"
  | "pruned";

export type GitDeliveryProfile = "solo" | "balanced" | "strict" | "custom";

export interface GitDeliveryActor {
  kind: CallerSnapshot["kind"] | "system";
  name?: string;
}

export interface GitDeliveryTaskLink {
  taskId: string;
  linkedAt: string;
}

export interface GitDeliveryTransition {
  at: string;
  from?: GitDeliveryPhase;
  to: GitDeliveryPhase;
  by: GitDeliveryActor;
  reason?: string;
}

export interface GitDeliveryReview {
  verdict: string;
  path?: string;
  by?: GitDeliveryActor;
  at: string;
  reviewedHeadSha?: string;
}

export interface GitDeliveryIntegration {
  kind: "ancestor" | "cherry-pick" | "merge" | "patch-id" | "manual";
  at: string;
  by?: GitDeliveryActor;
  integratedSha?: string;
  patchIds?: string[];
  evidence?: Record<string, unknown>;
}

export interface GitDelivery {
  schemaVersion: 1;
  id: string;
  version: number;
  workspaceId: string;
  /** Canonical lifecycle aggregate. Absent only on legacy projections. */
  deliveryId?: string;
  createdBy: GitDeliveryActor;
  agent: string;
  branchRef: string;
  worktreePath: string;
  tachyonCreatedBranch: boolean;
  baseRef: string;
  currentHeadSha?: string;
  reviewedHeadSha?: string;
  integratedSha?: string;
  phase: GitDeliveryPhase;
  taskLinks: GitDeliveryTaskLink[];
  review?: GitDeliveryReview;
  integration?: GitDeliveryIntegration;
  transitions: GitDeliveryTransition[];
  /** Last applied canonical projection sequence (SDD 368 T15). */
  lastAppliedProjectionSequence?: number;
  /** Operation id of the last applied canonical projection intent. */
  lastAppliedOperationId?: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface GitDeliverySettings {
  profile: GitDeliveryProfile;
  autoOpen: boolean;
  requireNonSelfAccept: boolean;
  autoPrune: boolean;
  prunePrincipals: string[];
  integratePrincipals: string[];
}

export type HygieneCategory =
  | "ready_to_prune"
  | "candidate_orphan"
  | "landed_without_integrated"
  | "missing_ref"
  | "integrated_unverified"
  | "corrupt_record"
  | "cherry_pick_unrecorded"
  | "delivery_unavailable";

export type ProjectionSyncState = "in_sync" | "pending" | "diverged" | "unlinked" | "unknown";

export interface GitDeliveryLiveState {
  currentHeadSha?: string;
  containedInBase: boolean;
  cherryPickedWithoutMetadata: boolean;
  missingRef: boolean;
  branchExists: boolean;
  worktreeExists: boolean;
  clean: boolean;
  liveState: "live" | "not_live" | "unknown";
  reasons: string[];
}

export interface GitDeliveryListRow extends GitDeliveryLiveState {
  id: string;
  version: number;
  agent: string;
  branchRef: string;
  worktreePath: string;
  baseRef: string;
  phase: GitDeliveryPhase;
  taskLinks: GitDeliveryTaskLink[];
  review?: GitDeliveryReview;
  /** Canonical Delivery id when linked (SDD 368 T15 list safety metadata). */
  deliveryId?: string;
  /** Canonical lease state when the Delivery is readable. */
  leaseState?: string;
  /** T14 reload safety class, or unknown when snapshot/Delivery is unavailable. */
  safetyClass?: string;
  /** Projection intent application sync relative to the canonical intent log. */
  projectionSync?: ProjectionSyncState;
}

export interface HygieneFinding {
  category: HygieneCategory;
  deliveryId?: string;
  agent?: string;
  taskId?: string;
  reason: string;
}

export interface HygieneReport {
  generatedAt: string;
  findings: HygieneFinding[];
  rows: GitDeliveryListRow[];
}

export interface GitDeliveryOpenInput {
  workspaceId: string;
  createdBy: GitDeliveryActor;
  deliveryId?: string;
  /** Deterministic id for canonical gated open (SDD 368 T15). */
  id?: string;
  agent: string;
  branchRef: string;
  worktreePath: string;
  tachyonCreatedBranch: boolean;
  baseRef: string;
  currentHeadSha?: string;
  taskLinks?: GitDeliveryTaskLink[];
  reason?: string;
}

export interface GitDeliveryCorruptRecord {
  id: string;
  path: string;
  error: string;
}
