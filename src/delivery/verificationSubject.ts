import type {
  DelegationSegment,
  Delivery,
  DeliveryActor,
  DeliveryContract,
} from "./types.js";

export type DeliveryIdentityErrorCode = "DELIVERY_SEGMENTS_MISSING" | "DELIVERY_IDENTITY_AMBIGUOUS";

export class DeliveryIdentityError extends Error {
  constructor(readonly code: DeliveryIdentityErrorCode, message: string) {
    super(message);
    this.name = "DeliveryIdentityError";
  }
}

export interface DeliveryVerificationSubject {
  deliveryId: string;
  contract: DeliveryContract;
  segments: DelegationSegment[];
  currentSegment: DelegationSegment;
  occupants: string[];
  createdBy: DeliveryActor;
  createdAt: string;
}

function ambiguous(delivery: Delivery, reason: string): DeliveryIdentityError {
  return new DeliveryIdentityError(
    "DELIVERY_IDENTITY_AMBIGUOUS",
    `Delivery '${delivery.id}' has no provable current occupant: ${reason}; refusing to guess`,
  );
}

/** Re-prove the current segment at the verification boundary instead of trusting a cached name. */
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

  const currentSegment = segments[segments.length - 1]!;
  if (!currentSegment.executionAgent) {
    throw ambiguous(delivery, `tail segment '${currentSegment.id}' names no execution agent`);
  }

  const open = segments.filter((segment) => !segment.releasedAt);
  if (open.length > 1) throw ambiguous(delivery, `${open.length} segments are still open`);
  if (open.length === 1 && open[0]!.id !== currentSegment.id) {
    throw ambiguous(delivery, `open segment '${open[0]!.id}' is not the tail segment '${currentSegment.id}'`);
  }

  const holder = delivery.lease.holder;
  if (holder) {
    if (holder.segmentId !== currentSegment.id) {
      throw ambiguous(delivery, `lease holder holds segment '${holder.segmentId}', not the tail segment '${currentSegment.id}'`);
    }
    if (holder.executionAgent !== currentSegment.executionAgent) {
      throw ambiguous(
        delivery,
        `lease holder is agent '${holder.executionAgent}' but tail segment '${currentSegment.id}' names '${currentSegment.executionAgent}'`,
      );
    }
  }

  return currentSegment;
}

export function deliveryVerificationSubject(delivery: Delivery): DeliveryVerificationSubject {
  const currentSegment = resolveOperationalSegment(delivery);
  return {
    deliveryId: delivery.id,
    contract: structuredClone(delivery.contract),
    segments: structuredClone(delivery.segments),
    currentSegment: structuredClone(currentSegment),
    occupants: delivery.segments.map((segment) => segment.executionAgent),
    createdBy: structuredClone(delivery.createdBy),
    createdAt: delivery.createdAt,
  };
}
