import type { DelegationRecord, FixerAttempt } from "../bridge/delegationRecord.js";
import type { DelegationSegment, Delivery } from "./types.js";

export type DeliveryIdentityErrorCode = "DELIVERY_SEGMENTS_MISSING" | "DELIVERY_IDENTITY_AMBIGUOUS";

export class DeliveryIdentityError extends Error {
  constructor(readonly code: DeliveryIdentityErrorCode, message: string) {
    super(message);
    this.name = "DeliveryIdentityError";
  }
}

/**
 * The two identities a Delivery carries, kept apart on purpose.
 *
 * `legacy` is the original occupant (segment 0) — the anchor the contract's `owns` was granted to, and
 * the name a pre-Delivery DelegationRecord would have carried. `canonical` is the CURRENT occupant (the
 * tail segment) — the agent that actually holds the worktree right now. On a single-segment Delivery the
 * two coincide; the moment a fixer takes over they diverge, and every operational act (is-it-still-
 * running, the worktree lock, the doorbell, waiver authorization) must name `canonical`.
 */
export interface DeliveryIdentity {
  legacy: string;
  canonical: string;
  deliveryId: string;
  segmentId: string;
  segmentIndex: number;
}

export interface DeliveryVerificationView {
  /** Compatibility view for the existing verifier's scope/contract logic. Never persisted. */
  record: DelegationRecord;
  identity: DeliveryIdentity;
}

function ambiguous(delivery: Delivery, reason: string): DeliveryIdentityError {
  return new DeliveryIdentityError(
    "DELIVERY_IDENTITY_AMBIGUOUS",
    `Delivery '${delivery.id}' has no provable current occupant: ${reason}; refusing to guess`,
  );
}

/**
 * F2 — resolve the Delivery's operational identity: the CURRENT occupant, never `segments[0]`.
 *
 * The store's invariants already give us a well-defined tail (indexes contiguous, ids unique, only the
 * tail may be open), but this is a security boundary, so it re-proves them here instead of trusting the
 * value it was handed: a Delivery whose segment chain or lease holder disagree with each other has no
 * single provable occupant, and picking one anyway is how the wrong agent gets verified. Reconciling a
 * contested tail is T9's job — until then such a Delivery is refused, not guessed (fail closed).
 */
export function resolveOperationalSegment(delivery: Delivery): DelegationSegment {
  const segments = delivery.segments;
  if (segments.length === 0) {
    throw new DeliveryIdentityError(
      "DELIVERY_SEGMENTS_MISSING",
      `Delivery '${delivery.id}' has no delegation segments`,
    );
  }

  const ids = new Set(segments.map((segment) => segment.id));
  if (ids.size !== segments.length) throw ambiguous(delivery, "segment ids are not unique");
  segments.forEach((segment, position) => {
    if (segment.index !== position) {
      throw ambiguous(delivery, `segment '${segment.id}' claims index ${segment.index} at position ${position}`);
    }
  });

  const tail = segments[segments.length - 1]!;
  if (!tail.executionAgent) throw ambiguous(delivery, `tail segment '${tail.id}' names no execution agent`);

  // Only the tail may still be open. An earlier open segment means two agents believe they hold the
  // worktree, and we cannot tell which one produced the commits under verification.
  const open = segments.filter((segment) => !segment.releasedAt);
  if (open.length > 1) throw ambiguous(delivery, `${open.length} segments are still open`);
  if (open.length === 1 && open[0]!.id !== tail.id) {
    throw ambiguous(delivery, `open segment '${open[0]!.id}' is not the tail segment '${tail.id}'`);
  }

  // A live lease is the strongest statement about who holds the worktree; if it names anyone other than
  // the tail, the two sources of truth disagree and neither wins.
  const holder = delivery.lease.holder;
  if (holder) {
    if (holder.segmentId !== tail.id) {
      throw ambiguous(delivery, `lease holder holds segment '${holder.segmentId}', not the tail segment '${tail.id}'`);
    }
    if (holder.executionAgent !== tail.executionAgent) {
      throw ambiguous(
        delivery,
        `lease holder is agent '${holder.executionAgent}' but tail segment '${tail.id}' names '${tail.executionAgent}'`,
      );
    }
  }

  return tail;
}

/**
 * Read-only compatibility view for the existing verifier. Delivery remains the authority; this object is
 * never persisted as a DelegationRecord.
 *
 * The contract (baseSha / taskRef / owns / behaviorTest) is copied through immutably — the adapter only
 * reshapes identity, it never renegotiates what was delegated. `record.agent` stays the ORIGINAL occupant
 * because that is the anchor the scope checker pairs with `record.owns` (each later segment brings its own
 * `ownsSubset` as a fixer attempt); the current occupant travels separately, in `identity.canonical`.
 */
export function deliveryToVerificationRecord(delivery: Delivery): DeliveryVerificationView {
  const tail = resolveOperationalSegment(delivery);
  const first = delivery.segments[0]!;

  const fixerAttempts: FixerAttempt[] = delivery.segments.slice(1).map((segment) => ({
    occupantAgent: segment.executionAgent,
    requestedOwnsSubset: [...segment.ownsSubset],
    grantedAt: segment.grantedAt,
    branchHeadAtGrant: segment.grantedHeadSha,
  }));

  const record: DelegationRecord = {
    id: delivery.legacy?.delegationId,
    agent: first.executionAgent,
    ...(delivery.createdBy.name ? { delegator: delivery.createdBy.name } : {}),
    ...(delivery.contract.taskId ? { taskId: delivery.contract.taskId } : {}),
    baseSha: delivery.contract.baseSha,
    taskRef: delivery.contract.taskRef,
    owns: [...delivery.contract.owns],
    behaviorTest: delivery.contract.behaviorTest,
    ...(delivery.contract.stubPath ? { stubPath: delivery.contract.stubPath } : {}),
    contract: { task: delivery.contract.taskId ?? delivery.id },
    createdAt: delivery.createdAt,
    ...(fixerAttempts.length ? { fixerAttempts } : {}),
  };

  return {
    record,
    identity: {
      legacy: first.executionAgent,
      canonical: tail.executionAgent,
      deliveryId: delivery.id,
      segmentId: tail.id,
      segmentIndex: tail.index,
    },
  };
}
