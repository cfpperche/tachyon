import path from "node:path";
import type {
  EngineServiceIdentityV1,
  WorkspaceSnapshotEnvelopeV1,
} from "../../../src/engine-service/protocol.js";
import type { WorkspaceAgentProjectionV1 } from "../../../src/runtime-api/workspaceProjection.js";

export function projectionIdentity(
  workspaceRoot: string,
  overrides: Partial<EngineServiceIdentityV1> = {},
): EngineServiceIdentityV1 {
  return {
    schemaVersion: 1,
    workspaceRoot,
    workspaceHash: "workspace-hash-1",
    instanceId: "engine-instance-1",
    pid: process.pid,
    processStartIdentity: "linux:test:1",
    startedAt: new Date(0).toISOString(),
    bundleId: "a".repeat(64),
    engineVersion: "0.57.0-test",
    protocol: { min: 1, max: 1 },
    bridge: { instanceId: "bridge-instance-1", port: 42_897 },
    ...overrides,
  };
}

export function projectedAgent(
  name: string,
  overrides: Partial<WorkspaceAgentProjectionV1> = {},
): WorkspaceAgentProjectionV1 {
  return {
    name,
    session: `tachyon-workspace-${name}`,
    kind: "agent",
    running: false,
    stopping: false,
    stopFailed: false,
    declared: true,
    dead: false,
    crashed: false,
    ...overrides,
  };
}

export function projectionSnapshot(
  identity: EngineServiceIdentityV1,
  seq = 0,
  agents: WorkspaceAgentProjectionV1[] = [],
  extra: Record<string, unknown> = {},
): WorkspaceSnapshotEnvelopeV1 {
  return {
    schemaVersion: 1,
    engineInstanceId: identity.instanceId,
    seq,
    projections: {
      workspace: {
        root: identity.workspaceRoot,
        hash: identity.workspaceHash,
        folderName: path.basename(identity.workspaceRoot) || "workspace",
        configValid: true,
        configFailure: null,
      },
      bridge: {
        instanceId: identity.bridge.instanceId,
        port: identity.bridge.port,
        url: `http://127.0.0.1:${identity.bridge.port}/mcp`,
        direct: true,
      },
      agents: { total: agents.length, truncated: false, items: agents },
      ...extra,
    },
  };
}
