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

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_ID_RE = /^[a-f0-9]{7,64}$/;

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
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
