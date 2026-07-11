import type { DelegationRecord, FixerAttempt } from "../bridge/delegationRecord.js";
import type { Delivery } from "./types.js";

/**
 * Read-only compatibility view for the existing verifier. Delivery remains the
 * authority; this object is never persisted as a DelegationRecord.
 */
export function deliveryToVerificationRecord(delivery: Delivery): DelegationRecord {
  const first = delivery.segments[0];
  if (!first) throw new Error(`Delivery '${delivery.id}' has no delegation segments`);

  const fixerAttempts: FixerAttempt[] = delivery.segments.slice(1).map((segment) => ({
    occupantAgent: segment.executionAgent,
    requestedOwnsSubset: [...segment.ownsSubset],
    grantedAt: segment.grantedAt,
    branchHeadAtGrant: segment.grantedHeadSha,
  }));

  return {
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
}
