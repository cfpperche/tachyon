import { describe, it } from "vitest";
import {
  boundDeliveryNewSessionFailureCases,
  exerciseBoundDeliveryNewSessionFailure,
  boundDeliveryCleanupOrderingCases,
  exerciseBoundDeliveryCleanupOrdering,
} from "../helpers/boundDeliveryExecutionHarness.js";

/**
 * t-13c2b6 — residual B3/B4 fault-injection coverage for the Delivery join, carved out of T13's
 * acceptance boundary (docs/specs/368-delivery-worktree-leases/notes.md, "T13 closure course
 * correction"). Test-only: production stays frozen unless one of these proves a concrete defect.
 *
 * B3 — launch and confirmation failure ownership (the residual gap: an outright `newSession`
 * failure inside a Delivery-bound launch). Confirmation failure, readiness rejection and the
 * cmd-ad-hoc readiness path are already covered by exerciseBoundDeliveryExecution.
 */
describe("Delivery join B3: newSession failure ownership", () => {
  it.each(boundDeliveryNewSessionFailureCases)("%s", async (kind) => {
    await exerciseBoundDeliveryNewSessionFailure(kind);
  });
});

/**
 * B4 — cleanup dependency ordering: every fallible step inside cleanupFailedDeliveryExecution's
 * "completed session" branch, independently forced and in meaningful combination.
 */
describe("Delivery join B4: cleanup dependency ordering", () => {
  it.each(boundDeliveryCleanupOrderingCases)("%s", async (kind) => {
    await exerciseBoundDeliveryCleanupOrdering(kind);
  });
});
