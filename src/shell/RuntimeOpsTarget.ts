import type { RuntimeOpsSnapshotV1 } from "../runtimeOps/types.js";
import { mergeRuntimeOpsSnapshotsV1 } from "../runtime-api/runtimeOpsProjection.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import { workspacePresentationTarget, type WorkspacePresentationTarget } from "./WorkspacePresentation.js";

export interface WorkspaceRuntimeOpsTarget extends WorkspacePresentationTarget {
  runtimeOpsView(): Promise<RuntimeOpsSnapshotV1>;
}

export function workspaceRuntimeOpsTarget(client: WorkspaceClient): WorkspaceRuntimeOpsTarget {
  return {
    ...workspacePresentationTarget(client),
    runtimeOpsView: async () => {
      const result = await client.query({ schemaVersion: 1, method: "runtime-ops.view", input: {} });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "runtime-ops.view") throw new Error("Runtime Ops query returned the wrong view");
      return result.view;
    },
  };
}

export async function runtimeOpsFleetView(
  targets: readonly WorkspaceRuntimeOpsTarget[],
): Promise<RuntimeOpsSnapshotV1> {
  return mergeRuntimeOpsSnapshotsV1(await Promise.all(targets.map((target) => target.runtimeOpsView())));
}
