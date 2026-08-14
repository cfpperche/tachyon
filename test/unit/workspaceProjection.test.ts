import { describe, expect, it } from "vitest";
import {
  assertWorkspacePresentationIdentity,
  projectWorkspacePresentation,
} from "../../apps/vscode-extension/src/runtime-api/workspaceProjection.js";
import { projectedAgent, projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";

describe("workspace presentation projection", () => {
  it("projects the closed workspace, bridge and agent roster slice", () => {
    const identity = projectionIdentity("/tmp/tachyon-projection-workspace");
    const snapshot = projectionSnapshot(identity, 7, [
      projectedAgent("worker", { running: true, attention: "needs-input", parent: "codex" }),
    ], { futureProjection: { remains: "opaque" } });

    const projected = projectWorkspacePresentation(snapshot);
    expect(projected).toMatchObject({
      engineInstanceId: identity.instanceId,
      seq: 7,
      workspace: { root: identity.workspaceRoot, hash: identity.workspaceHash, configValid: true },
      bridge: { instanceId: identity.bridge.instanceId, port: identity.bridge.port, direct: true },
      agents: { total: 1, truncated: false, items: [{ name: "worker", running: true, attention: "needs-input", parent: "codex" }] },
    });
    expect(projected).not.toHaveProperty("futureProjection");
  });

  it("preserves the configuration-pending lifecycle marker", () => {
    const identity = projectionIdentity("/tmp/tachyon-projection-workspace");
    const projected = projectWorkspacePresentation(projectionSnapshot(identity, 1, [
      projectedAgent("codex", { running: true, configurationPending: true }),
    ]));
    expect(projected.agents.items[0]?.configurationPending).toBe(true);
  });

  it("refuses contradictory, duplicate and identity-crossed projections", () => {
    const identity = projectionIdentity("/tmp/tachyon-projection-workspace");
    const contradictory = projectionSnapshot(identity);
    (contradictory.projections.workspace as Record<string, unknown>).configValid = false;
    expect(() => projectWorkspacePresentation(contradictory)).toThrow(/contradict/i);

    const duplicate = projectionSnapshot(identity, 0, [projectedAgent("worker"), projectedAgent("worker")]);
    expect(() => projectWorkspacePresentation(duplicate)).toThrow(/duplicate/i);

    const invalidAttention = projectionSnapshot(identity, 0, [projectedAgent("worker")]);
    (invalidAttention.projections.agents as { items: Array<Record<string, unknown>> }).items[0].attention = "unknown";
    expect(() => projectWorkspacePresentation(invalidAttention)).toThrow(/attention/i);

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
