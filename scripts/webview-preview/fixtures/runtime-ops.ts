import { emptyRuntimeOpsSnapshot } from "../../../src/runtimeOps/types";
import type { RuntimeOpsSnapshotV1 } from "../../../src/runtimeOps/types";
import type { Fixture } from "../routes";

export const runtimeOpsFixtures: Record<string, Fixture<RuntimeOpsSnapshotV1>> = {
  empty: {
    provenance: "synthetic-edge",
    vm: emptyRuntimeOpsSnapshot(new Date("2026-07-09T21:00:00.000Z")),
  },
};
