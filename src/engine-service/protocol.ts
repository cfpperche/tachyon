import { createHash } from "node:crypto";

export const ENGINE_BUNDLE_SCHEMA_VERSION = 1 as const;
export const ENGINE_SHELL_PROTOCOL = 1 as const;

export interface EngineProtocolRangeV1 {
  min: number;
  max: number;
}

export interface EngineBundleFileV1 {
  /** POSIX-style path relative to the bundle root. */
  path: string;
  sha256: string;
  executable?: boolean;
}

export interface EngineBundleManifestV1 {
  schemaVersion: typeof ENGINE_BUNDLE_SCHEMA_VERSION;
  engineVersion: string;
  protocol: EngineProtocolRangeV1;
  entrypoint: string;
  files: EngineBundleFileV1[];
  build: {
    commit: string;
    treeSha: string;
    workingTreeClean: boolean;
  };
}

export interface EngineServiceIdentityV1 {
  schemaVersion: 1;
  workspaceRoot: string;
  workspaceHash: string;
  instanceId: string;
  pid: number;
  processStartIdentity: string;
  startedAt: string;
  bundleId: string;
  engineVersion: string;
  protocol: EngineProtocolRangeV1;
  bridge: {
    instanceId: string;
    port: number;
  };
}

export interface EngineShellHelloV1 {
  schemaVersion: 1;
  op: "attach";
  workspaceRoot: string;
  workspaceHash: string;
  shell: {
    id: string;
    version: string;
    locale: string;
  };
  protocol: EngineProtocolRangeV1;
  capabilities: string[];
  settingsDigest: string;
}

export interface EngineShellSessionV1 {
  schemaVersion: 1;
  shellId: string;
  sessionToken: string;
  protocol: number;
  engine: EngineServiceIdentityV1;
  snapshotSeq: number;
  leaseExpiresAt: string;
}

export interface WorkspaceSnapshotEnvelopeV1 {
  schemaVersion: 1;
  engineInstanceId: string;
  seq: number;
  projections: Record<string, unknown>;
}

export interface WorkspaceEventV1 {
  schemaVersion: 1;
  engineInstanceId: string;
  seq: number;
  at: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface WorkspaceEventBatchV1 {
  schemaVersion: 1;
  engineInstanceId: string;
  afterSeq: number;
  oldestSeq: number;
  latestSeq: number;
  resyncRequired: boolean;
  events: WorkspaceEventV1[];
}

export type WorkspaceCommandMethodV1 =
  | "agent.start"
  | "agent.stop"
  | "agent.kill"
  | "agent.restart"
  | "agent.resume";

export interface WorkspaceCommandV1 {
  schemaVersion: 1;
  method: WorkspaceCommandMethodV1;
  input: { agent: string };
}

export type WorkspaceCommandResultV1 =
  | {
      schemaVersion: 1;
      method: WorkspaceCommandMethodV1;
      status: "ok";
    }
  | {
      schemaVersion: 1;
      method: WorkspaceCommandMethodV1;
      status: "error";
      code: string;
      message: string;
    };

export type EngineControlRequestV1 =
  | { schemaVersion: 1; op: "health"; workspaceHash: string }
  | { schemaVersion: 1; op: "attach"; workspaceHash: string; hello: EngineShellHelloV1 }
  | { schemaVersion: 1; op: "touch"; workspaceHash: string; shellId: string; sessionToken: string }
  | { schemaVersion: 1; op: "snapshot"; workspaceHash: string; shellId: string; sessionToken: string }
  | { schemaVersion: 1; op: "events"; workspaceHash: string; shellId: string; sessionToken: string; afterSeq: number; limit: number }
  | { schemaVersion: 1; op: "invoke"; workspaceHash: string; shellId: string; sessionToken: string; operationId: string; command: WorkspaceCommandV1 }
  | { schemaVersion: 1; op: "detach"; workspaceHash: string; shellId: string; sessionToken: string };

export type EngineControlResponseV1 =
  | { ok: true; op: "health"; engine: EngineServiceIdentityV1; shellCount: number }
  | { ok: true; op: "attach" | "touch"; session: EngineShellSessionV1 }
  | { ok: true; op: "snapshot"; snapshot: WorkspaceSnapshotEnvelopeV1 }
  | { ok: true; op: "events"; batch: WorkspaceEventBatchV1 }
  | { ok: true; op: "invoke"; operationId: string; result: WorkspaceCommandResultV1 }
  | { ok: true; op: "detach"; detached: true }
  | { ok: false; code: string; message: string };

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_ID_RE = /^[a-f0-9]{7,64}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const WORKSPACE_COMMAND_METHODS = new Set<WorkspaceCommandMethodV1>([
  "agent.start",
  "agent.stop",
  "agent.kill",
  "agent.restart",
  "agent.resume",
]);

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

export function isEngineOperationId(value: unknown): value is string {
  return typeof value === "string" && OPERATION_ID_RE.test(value);
}

export function isWorkspaceCommandV1(value: unknown): value is WorkspaceCommandV1 {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["schemaVersion", "method", "input"])
    || value.schemaVersion !== 1
    || typeof value.method !== "string"
    || !WORKSPACE_COMMAND_METHODS.has(value.method as WorkspaceCommandMethodV1)
    || !isRecord(value.input)
    || !hasOnlyKeys(value.input, ["agent"])) return false;
  return typeof value.input.agent === "string" && AGENT_NAME_RE.test(value.input.agent);
}

export function isWorkspaceCommandResultV1(value: unknown): value is WorkspaceCommandResultV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.method !== "string"
    || !WORKSPACE_COMMAND_METHODS.has(value.method as WorkspaceCommandMethodV1)) return false;
  if (value.status === "ok") {
    return hasOnlyKeys(value, ["schemaVersion", "method", "status"]);
  }
  return value.status === "error"
    && hasOnlyKeys(value, ["schemaVersion", "method", "status", "code", "message"])
    && typeof value.code === "string"
    && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code)
    && typeof value.message === "string"
    && value.message.length > 0
    && value.message.length <= 1_000;
}

/** Bundle paths are canonical POSIX relative paths on every host. */
export function isSafeBundlePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240) return false;
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("\\") || value.includes("\0")) return false;
  const segments = value.split("/");
  return segments.every((segment) => /^[A-Za-z0-9_@.+-]+$/.test(segment) && segment !== "." && segment !== "..");
}

export function isEngineProtocolRangeV1(value: unknown): value is EngineProtocolRangeV1 {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.min)
    && Number.isSafeInteger(value.max)
    && (value.min as number) > 0
    && (value.max as number) >= (value.min as number);
}

export function isEngineBundleManifestV1(value: unknown): value is EngineBundleManifestV1 {
  if (!isRecord(value) || value.schemaVersion !== ENGINE_BUNDLE_SCHEMA_VERSION) return false;
  if (typeof value.engineVersion !== "string" || value.engineVersion.trim().length === 0) return false;
  if (!isEngineProtocolRangeV1(value.protocol) || !isSafeBundlePath(value.entrypoint)) return false;
  if (!Array.isArray(value.files) || value.files.length === 0) return false;
  const seen = new Set<string>();
  let hasEntrypoint = false;
  for (const candidate of value.files) {
    if (!isRecord(candidate) || !isSafeBundlePath(candidate.path) || !isSha256(candidate.sha256)) return false;
    if (candidate.executable !== undefined && typeof candidate.executable !== "boolean") return false;
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    if (candidate.path === value.entrypoint) hasEntrypoint = true;
  }
  if (!hasEntrypoint || !isRecord(value.build)) return false;
  return typeof value.build.commit === "string"
    && GIT_ID_RE.test(value.build.commit)
    && typeof value.build.treeSha === "string"
    && GIT_ID_RE.test(value.build.treeSha)
    && typeof value.build.workingTreeClean === "boolean";
}

export function isEngineShellHelloV1(value: unknown): value is EngineShellHelloV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.op !== "attach") return false;
  if (typeof value.workspaceRoot !== "string" || value.workspaceRoot.length === 0) return false;
  if (typeof value.workspaceHash !== "string" || value.workspaceHash.length === 0) return false;
  if (!isRecord(value.shell)
    || typeof value.shell.id !== "string" || value.shell.id.length < 8 || value.shell.id.length > 128
    || typeof value.shell.version !== "string" || value.shell.version.length === 0
    || typeof value.shell.locale !== "string" || value.shell.locale.length === 0) return false;
  if (!isEngineProtocolRangeV1(value.protocol)) return false;
  if (!Array.isArray(value.capabilities)
    || value.capabilities.length > 128
    || value.capabilities.some((capability) => typeof capability !== "string" || capability.length === 0 || capability.length > 128)
    || new Set(value.capabilities).size !== value.capabilities.length) return false;
  return isSha256(value.settingsDigest);
}

export function isEngineServiceIdentityV1(value: unknown): value is EngineServiceIdentityV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.workspaceRoot !== "string" || value.workspaceRoot.length === 0 || value.workspaceRoot.length > 4_096) return false;
  if (typeof value.workspaceHash !== "string" || value.workspaceHash.length === 0 || value.workspaceHash.length > 128) return false;
  if (typeof value.instanceId !== "string" || value.instanceId.length < 8 || value.instanceId.length > 128) return false;
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return false;
  if (typeof value.processStartIdentity !== "string" || value.processStartIdentity.length === 0 || value.processStartIdentity.length > 256) return false;
  if (typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) return false;
  if (!isSha256(value.bundleId)) return false;
  if (typeof value.engineVersion !== "string" || value.engineVersion.length === 0 || value.engineVersion.length > 128) return false;
  if (!isEngineProtocolRangeV1(value.protocol) || !isRecord(value.bridge)) return false;
  return typeof value.bridge.instanceId === "string"
    && value.bridge.instanceId.length >= 8
    && value.bridge.instanceId.length <= 128
    && Number.isSafeInteger(value.bridge.port)
    && (value.bridge.port as number) > 0
    && (value.bridge.port as number) <= 65_535;
}

export function isWorkspaceSnapshotEnvelopeV1(value: unknown): value is WorkspaceSnapshotEnvelopeV1 {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.engineInstanceId === "string"
    && value.engineInstanceId.length >= 8
    && value.engineInstanceId.length <= 128
    && Number.isSafeInteger(value.seq)
    && (value.seq as number) >= 0
    && isRecord(value.projections);
}

export function isEngineShellSessionV1(value: unknown): value is EngineShellSessionV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.shellId !== "string" || value.shellId.length < 8 || value.shellId.length > 128) return false;
  if (typeof value.sessionToken !== "string" || value.sessionToken.length < 32 || value.sessionToken.length > 256) return false;
  if (!Number.isSafeInteger(value.protocol) || (value.protocol as number) <= 0) return false;
  if (!isEngineServiceIdentityV1(value.engine)) return false;
  if (!Number.isSafeInteger(value.snapshotSeq) || (value.snapshotSeq as number) < 0) return false;
  return typeof value.leaseExpiresAt === "string" && Number.isFinite(Date.parse(value.leaseExpiresAt));
}

export function isWorkspaceEventV1(value: unknown): value is WorkspaceEventV1 {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.engineInstanceId === "string"
    && value.engineInstanceId.length >= 8
    && value.engineInstanceId.length <= 128
    && Number.isSafeInteger(value.seq)
    && (value.seq as number) > 0
    && typeof value.at === "string"
    && Number.isFinite(Date.parse(value.at))
    && typeof value.kind === "string"
    && /^[a-z][a-z0-9.-]{0,63}$/.test(value.kind)
    && isRecord(value.payload);
}

export function isWorkspaceEventBatchV1(value: unknown): value is WorkspaceEventBatchV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.engineInstanceId !== "string" || value.engineInstanceId.length < 8 || value.engineInstanceId.length > 128) return false;
  if (!Number.isSafeInteger(value.afterSeq) || (value.afterSeq as number) < 0
    || !Number.isSafeInteger(value.oldestSeq) || (value.oldestSeq as number) < 1
    || !Number.isSafeInteger(value.latestSeq) || (value.latestSeq as number) < 0
    || typeof value.resyncRequired !== "boolean" || !Array.isArray(value.events) || value.events.length > 200) return false;
  if ((value.oldestSeq as number) > (value.latestSeq as number) + 1) return false;
  const shouldResync = (value.afterSeq as number) > (value.latestSeq as number)
    || (value.afterSeq as number) < (value.oldestSeq as number) - 1;
  if (value.resyncRequired !== shouldResync) return false;
  let previous = value.afterSeq as number;
  for (const event of value.events) {
    if (!isWorkspaceEventV1(event)
      || event.engineInstanceId !== value.engineInstanceId
      || event.seq !== previous + 1
      || event.seq > (value.latestSeq as number)) return false;
    previous = event.seq;
  }
  if (value.resyncRequired && value.events.length > 0) return false;
  if (!value.resyncRequired && (value.afterSeq as number) < (value.latestSeq as number) && value.events.length === 0) return false;
  return true;
}

export function isEngineControlResponseV1(value: unknown): value is EngineControlResponseV1 {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) {
    return typeof value.code === "string"
      && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code)
      && typeof value.message === "string"
      && value.message.length > 0
      && value.message.length <= 4_096;
  }
  if (value.op === "health") {
    return isEngineServiceIdentityV1(value.engine)
      && Number.isSafeInteger(value.shellCount)
      && (value.shellCount as number) >= 0;
  }
  if (value.op === "attach" || value.op === "touch") return isEngineShellSessionV1(value.session);
  if (value.op === "snapshot") return isWorkspaceSnapshotEnvelopeV1(value.snapshot);
  if (value.op === "events") return isWorkspaceEventBatchV1(value.batch);
  if (value.op === "invoke") {
    return isEngineOperationId(value.operationId)
      && isWorkspaceCommandResultV1(value.result);
  }
  return value.op === "detach" && value.detached === true;
}

/** Highest mutually supported protocol, or undefined when the ranges do not overlap. */
export function negotiateEngineShellProtocol(
  engine: EngineProtocolRangeV1,
  shell: EngineProtocolRangeV1,
): number | undefined {
  const lower = Math.max(engine.min, shell.min);
  const upper = Math.min(engine.max, shell.max);
  return lower <= upper ? upper : undefined;
}

/** Stable id for a byte-identical manifest; field order supplied by callers cannot change it. */
export function engineBundleId(manifest: EngineBundleManifestV1): string {
  const normalized = {
    schemaVersion: manifest.schemaVersion,
    engineVersion: manifest.engineVersion,
    protocol: { min: manifest.protocol.min, max: manifest.protocol.max },
    entrypoint: manifest.entrypoint,
    files: [...manifest.files]
      .map((file) => ({ path: file.path, sha256: file.sha256, executable: file.executable === true }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    build: {
      commit: manifest.build.commit,
      treeSha: manifest.build.treeSha,
      workingTreeClean: manifest.build.workingTreeClean,
    },
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
