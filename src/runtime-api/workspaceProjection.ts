import type { WorkspaceSnapshotEnvelopeV1 } from "../engine-service/protocol.js";

export interface WorkspaceConfigFailureProjectionV1 {
  file: string;
  errors: string[];
  at: string;
}

export interface WorkspaceIdentityProjectionV1 {
  root: string;
  hash: string;
  folderName: string;
  configValid: boolean;
  configFailure: WorkspaceConfigFailureProjectionV1 | null;
}

export interface WorkspaceBridgeProjectionV1 {
  instanceId: string;
  port: number;
  url: string | null;
  direct: boolean;
}

export interface WorkspaceAgentProjectionV1 {
  name: string;
  session: string;
  kind: "agent" | "terminal";
  running: boolean;
  stopping: boolean;
  stopFailed: boolean;
  declared: boolean;
  dead: boolean;
  crashed: boolean;
  attention?: "working" | "idle" | "needs-input" | "throttled";
  /** t-a39c7d — finished turn not yet viewed. */
  unseen?: boolean;
  /** SDD 446 C — current session still uses the prior native runtime source. */
  configurationPending?: boolean;
  exitCode?: number;
  parent?: string;
  delegator?: string;
  declaredOwner?: string;
}

export interface BoundedProjectionListV1<T> {
  total: number;
  truncated: boolean;
  items: T[];
}

/** The first presentation-safe slice consumed without concrete Workspace access. */
export interface WorkspaceCoreProjectionsV1 {
  workspace: WorkspaceIdentityProjectionV1;
  bridge: WorkspaceBridgeProjectionV1;
  agents: BoundedProjectionListV1<WorkspaceAgentProjectionV1>;
}

export interface WorkspacePresentationSnapshotV1 extends WorkspaceCoreProjectionsV1 {
  engineInstanceId: string;
  seq: number;
}

export class WorkspaceProjectionError extends Error {
  constructor(readonly code: "INVALID_PROJECTION" | "IDENTITY_MISMATCH", message: string) {
    super(message);
    this.name = "WorkspaceProjectionError";
  }
}

/**
 * Converts an untrusted engine envelope into the closed core presentation model.  Extra top-level
 * projections remain available for later slices, but every field consumed here is exact and bounded.
 */
export function projectWorkspacePresentation(
  snapshot: WorkspaceSnapshotEnvelopeV1,
): WorkspacePresentationSnapshotV1 {
  if (typeof snapshot.engineInstanceId !== "string"
    || snapshot.engineInstanceId.length < 8
    || snapshot.engineInstanceId.length > 128
    || !Number.isSafeInteger(snapshot.seq)
    || snapshot.seq < 0) {
    throw invalid("snapshot identity or sequence is invalid");
  }
  const projections = record(snapshot.projections, "snapshot projections");
  return {
    engineInstanceId: snapshot.engineInstanceId,
    seq: snapshot.seq,
    workspace: projectWorkspaceIdentity(projections.workspace),
    bridge: projectBridge(projections.bridge),
    agents: projectAgents(projections.agents),
  };
}

export function assertWorkspacePresentationIdentity(
  projected: WorkspacePresentationSnapshotV1,
  expected: {
    workspaceRoot: string;
    workspaceHash: string;
    engineInstanceId: string;
    bridgeInstanceId: string;
    bridgePort: number;
  },
): void {
  if (projected.workspace.root !== expected.workspaceRoot
    || projected.workspace.hash !== expected.workspaceHash
    || projected.engineInstanceId !== expected.engineInstanceId
    || projected.bridge.instanceId !== expected.bridgeInstanceId
    || projected.bridge.port !== expected.bridgePort
    || !projected.bridge.direct
    || projected.bridge.url !== `http://127.0.0.1:${expected.bridgePort}/mcp`) {
    throw new WorkspaceProjectionError(
      "IDENTITY_MISMATCH",
      "workspace projection does not match the attached engine identity",
    );
  }
}

function projectWorkspaceIdentity(value: unknown): WorkspaceIdentityProjectionV1 {
  const input = exactRecord(value, ["root", "hash", "folderName", "configValid", "configFailure"], "workspace projection");
  const configValid = boolean(input.configValid, "workspace configValid");
  const configFailure = input.configFailure === null ? null : projectConfigFailure(input.configFailure);
  if (configValid !== (configFailure === null)) {
    throw invalid("workspace configValid and configFailure contradict each other");
  }
  return {
    root: boundedString(input.root, 1, 4_096, "workspace root"),
    hash: boundedString(input.hash, 1, 128, "workspace hash"),
    folderName: boundedString(input.folderName, 1, 256, "workspace folderName"),
    configValid,
    configFailure,
  };
}

function projectConfigFailure(value: unknown): WorkspaceConfigFailureProjectionV1 {
  const input = exactRecord(value, ["file", "errors", "at"], "workspace configFailure");
  if (!Array.isArray(input.errors) || input.errors.length === 0 || input.errors.length > 10) {
    throw invalid("workspace configFailure errors must contain 1-10 rows");
  }
  const errors = input.errors.map((error) => boundedString(error, 1, 500, "workspace configFailure error"));
  const at = boundedString(input.at, 1, 64, "workspace configFailure timestamp");
  if (!Number.isFinite(Date.parse(at))) throw invalid("workspace configFailure timestamp is invalid");
  return {
    file: boundedString(input.file, 1, 160, "workspace configFailure file"),
    errors,
    at,
  };
}

function projectBridge(value: unknown): WorkspaceBridgeProjectionV1 {
  const input = exactRecord(value, ["instanceId", "port", "url", "direct"], "bridge projection");
  const port = safeInteger(input.port, 1, 65_535, "bridge port");
  const url = input.url === null ? null : boundedString(input.url, 1, 2_048, "bridge url");
  if (url !== null && url !== `http://127.0.0.1:${port}/mcp`) {
    throw invalid("bridge url does not match its loopback port");
  }
  return {
    instanceId: boundedString(input.instanceId, 8, 128, "bridge instanceId"),
    port,
    url,
    direct: boolean(input.direct, "bridge direct"),
  };
}

function projectAgents(value: unknown): BoundedProjectionListV1<WorkspaceAgentProjectionV1> {
  const input = exactRecord(value, ["total", "truncated", "items"], "agents projection");
  const total = safeInteger(input.total, 0, 1_000_000, "agents total");
  const truncated = boolean(input.truncated, "agents truncated");
  if (!Array.isArray(input.items) || input.items.length > 256 || input.items.length > total) {
    throw invalid("agents items exceed their bounded total");
  }
  if (truncated !== (total > input.items.length)) {
    throw invalid("agents truncated flag contradicts its total");
  }
  const items = input.items.map(projectAgent);
  if (new Set(items.map((agent) => agent.name)).size !== items.length) {
    throw invalid("agents projection contains duplicate names");
  }
  return { total, truncated, items };
}

function projectAgent(value: unknown): WorkspaceAgentProjectionV1 {
  const input = record(value, "agent projection");
  const allowed = [
    "name", "session", "kind", "running", "stopping", "stopFailed", "declared", "dead", "crashed",
    "attention", "unseen", "configurationPending", "exitCode", "parent", "delegator", "declaredOwner",
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw invalid("agent projection has unknown fields");
  const required = allowed.slice(0, 9);
  if (required.some((key) => !(key in input))) throw invalid("agent projection is incomplete");
  if (input.kind !== "agent" && input.kind !== "terminal") throw invalid("agent kind is invalid");
  const projected: WorkspaceAgentProjectionV1 = {
    name: boundedString(input.name, 1, 128, "agent name"),
    session: boundedString(input.session, 1, 256, "agent session"),
    kind: input.kind,
    running: boolean(input.running, "agent running"),
    stopping: boolean(input.stopping, "agent stopping"),
    stopFailed: boolean(input.stopFailed, "agent stopFailed"),
    declared: boolean(input.declared, "agent declared"),
    dead: boolean(input.dead, "agent dead"),
    crashed: boolean(input.crashed, "agent crashed"),
  };
  if (input.attention !== undefined) {
    if (input.attention !== "working" && input.attention !== "idle"
      && input.attention !== "needs-input" && input.attention !== "throttled") {
      throw invalid("agent attention is invalid");
    }
    projected.attention = input.attention;
  }
  if (input.unseen !== undefined) {
    if (typeof input.unseen !== "boolean") throw invalid("agent unseen is invalid");
    if (input.unseen) projected.unseen = true;
  }
  if (input.configurationPending !== undefined) {
    if (typeof input.configurationPending !== "boolean") throw invalid("agent configurationPending is invalid");
    if (input.configurationPending) projected.configurationPending = true;
  }
  if (input.exitCode !== undefined) projected.exitCode = safeInteger(input.exitCode, -65_535, 65_535, "agent exitCode");
  if (input.parent !== undefined) projected.parent = boundedString(input.parent, 1, 128, "agent parent");
  if (input.delegator !== undefined) projected.delegator = boundedString(input.delegator, 1, 128, "agent delegator");
  if (input.declaredOwner !== undefined) projected.declaredOwner = boundedString(input.declaredOwner, 1, 128, "agent declaredOwner");
  return projected;
}

function exactRecord(value: unknown, keys: string[], label: string): Record<string, unknown> {
  const input = record(value, label);
  const actual = Object.keys(input);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw invalid(`${label} has unknown or missing fields`);
  }
  return input;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, min: number, max: number, label: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max) throw invalid(`${label} is invalid`);
  return value;
}

function safeInteger(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw invalid(`${label} is invalid`);
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${label} is invalid`);
  return value;
}

function invalid(message: string): WorkspaceProjectionError {
  return new WorkspaceProjectionError("INVALID_PROJECTION", message);
}
