import type { RuntimeOpsSnapshot } from "../runtimeOps/types.js";
import { mergeRuntimeOpsSnapshotsV1 } from "@tachyon/engine/runtime-api/runtimeOpsProjection.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import { workspacePresentationTarget, type WorkspacePresentationTarget } from "./WorkspacePresentation.js";

export interface WorkspaceRuntimeOpsTarget extends WorkspacePresentationTarget {
  runtimeOpsView(refreshDetection?: boolean): Promise<RuntimeOpsSnapshot>;
}

export function workspaceRuntimeOpsTarget(client: WorkspaceClient): WorkspaceRuntimeOpsTarget {
  return {
    ...workspacePresentationTarget(client),
    runtimeOpsView: async (refreshDetection = false) => {
      const input = refreshDetection ? { refreshDetection: true as const } : {};
      const result = await client.query({ schemaVersion: 1, method: "runtime-ops.view", input });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "runtime-ops.view") throw new Error("Runtime Ops query returned the wrong view");
      return result.view;
    },
  };
}

export async function runtimeOpsFleetView(
  targets: readonly WorkspaceRuntimeOpsTarget[],
  refreshDetection = false,
): Promise<RuntimeOpsSnapshot> {
  return mergeRuntimeOpsSnapshotsV1(await Promise.all(targets.map((target) => target.runtimeOpsView(refreshDetection))));
}
