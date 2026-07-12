import { describe, it } from "vitest";
import {
  exerciseBoundDeliveryExecution,
  exerciseBoundDeliveryIdentitySnapshot,
  exerciseDeclaredDeliveryJoinBridgeStampRefresh,
} from "../helpers/boundDeliveryExecutionHarness.js";

describe("container-generated delegation behavior", () => {
  it("a failed Delivery join never cleans state the launch attempt did not acquire", async () => {
    await exerciseBoundDeliveryExecution();
  });

  it("keeps a live declared principal isolated while a bound execution uses one deep preflight snapshot", async () => {
    await exerciseBoundDeliveryIdentitySnapshot();
  });

  it("T13 R3 refreshes stale Bridge stamp for declared Delivery join", async () => {
    await exerciseDeclaredDeliveryJoinBridgeStampRefresh();
  });
});
