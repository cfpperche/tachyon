import { describe, expect, it } from "vitest";
import {
  assertWorkspacePresentationIdentity,
  projectWorkspacePresentation,
} from "../../src/runtime-api/workspaceProjection.js";
import { projectedAgent, projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";

describe("workspace presentation projection", () => {
  it("projects the closed workspace, bridge and agent roster slice", () => {
    const identity = projectionIdentity("/tmp/tachyon-projection-workspace");
    const snapshot = projectionSnapshot(identity, 7, [
      projectedAgent("worker", { running: true, parent: "codex" }),
    ], { futureProjection: { remains: "opaque" } });

    const projected = projectWorkspacePresentation(snapshot);
    expect(projected).toMatchObject({
      engineInstanceId: identity.instanceId,
      seq: 7,
      workspace: { root: identity.workspaceRoot, hash: identity.workspaceHash, configValid: true },
      bridge: { instanceId: identity.bridge.instanceId, port: identity.bridge.port, direct: true },
      agents: { total: 1, truncated: false, items: [{ name: "worker", running: true, parent: "codex" }] },
    });
    expect(projected).not.toHaveProperty("futureProjection");
  });

  it("refuses contradictory, duplicate and identity-crossed projections", () => {
    const identity = projectionIdentity("/tmp/tachyon-projection-workspace");
    const contradictory = projectionSnapshot(identity);
    (contradictory.projections.workspace as Record<string, unknown>).configValid = false;
    expect(() => projectWorkspacePresentation(contradictory)).toThrow(/contradict/i);

    const duplicate = projectionSnapshot(identity, 0, [projectedAgent("worker"), projectedAgent("worker")]);
    expect(() => projectWorkspacePresentation(duplicate)).toThrow(/duplicate/i);

    const projected = projectWorkspacePresentation(projectionSnapshot(identity));
    expect(() => assertWorkspacePresentationIdentity(projected, {
      workspaceRoot: identity.workspaceRoot,
      workspaceHash: identity.workspaceHash,
      engineInstanceId: "other-engine",
      bridgeInstanceId: identity.bridge.instanceId,
      bridgePort: identity.bridge.port,
    })).toThrow(/attached engine identity/i);
  });
});
