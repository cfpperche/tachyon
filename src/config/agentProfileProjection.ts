import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import type { AgentDef } from "./loadConfig.js";
import {
  agentProfileRuntimeSelectorsSha256,
  resolveAgentProfile,
  type NativeRuntimeAttestation,
  type ExternalProfileReference,
  type ResolvedAgentProfile,
  type WorkspaceProfileDefaults,
} from "./agentProfileResolver.js";
import { agentProfileSchemaV1, type AgentProfileV1 } from "./agentProfileSchema.js";
import { authoritySnapshotFor, type AgentProfileAuthorityRecord } from "./agentProfileAuthority.js";
import {
  closeCanonicalAgentProfile,
  readCanonicalAgentProfile,
  type CanonicalAgentProfileSource,
} from "./agentProfileReader.js";
import { AgentCapabilitySourceError, captureCapabilitySourceAtRoot } from "./agentCapabilitySource.js";

const INSPECTOR_CONTRACT = "tachyon/codex-empty-native-input-inspector/v1";
const PI_INSPECTOR_CONTRACT = "tachyon/pi-private-capability-input-inspector/v1";
const PROFILE_ATTENTION_DEFAULT_SILENCE_SEC = 8;
const NATIVE_CONFIG_MAX_BYTES = 1024 * 1024;
export const CODEX_EMPTY_NATIVE_INPUT_INSPECTOR = Object.freeze({
  adapter: "codex",
  id: "tachyon.codex-empty-native-inputs",
  version: "1",
  sha256: crypto.createHash("sha256").update(INSPECTOR_CONTRACT).digest("hex"),
});
export const PI_PRIVATE_CAPABILITY_INPUT_INSPECTOR = Object.freeze({
  adapter: "pi",
  id: "tachyon.pi-private-capability-inputs",
  version: "1",
  sha256: crypto.createHash("sha256").update(PI_INSPECTOR_CONTRACT).digest("hex"),
});

export interface ProjectAgentProfileInput {
  workspaceRoot: string;
  agentName: string;
  authority: AgentProfileAuthorityRecord;
  workspaceDefaults?: WorkspaceProfileDefaults;
  homeDir?: string;
}

export type ProjectAgentProfileResult =
  | { ok: true; definition: AgentDef; resolved: ResolvedAgentProfile }
  | { ok: false; errors: string[] };

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // Preserve the inspection result.
  }
}

function descriptorPath(fd: number): string {
  const expected = fs.fstatSync(fd, { bigint: true });
  for (const base of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = `${base}/${fd}`;
    try {
      const actual = fs.statSync(candidate, { bigint: true });
      if (actual.dev === expected.dev && actual.ino === expected.ino) return candidate;
    } catch {
      // Try the next descriptor filesystem.
    }
  }
  throw new Error("host has no verified descriptor-relative filesystem path");
}

function inspectEmptyFileAt(root: string, segments: string[]): string | undefined {
  const label = path.join(root, ...segments);
  const noFollow = fs.constants.O_NOFOLLOW;
  const directory = fs.constants.O_DIRECTORY;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (typeof noFollow !== "number" || typeof directory !== "number" || typeof nonBlock !== "number") {
    return `profile/native-attestation: no-follow inspection is unsupported for ${label}`;
  }
  const opened: number[] = [];
  try {
    const canonicalRoot = fs.realpathSync.native(root);
    let parent = fs.openSync(canonicalRoot, fs.constants.O_RDONLY | directory | noFollow | nonBlock);
    opened.push(parent);
    for (const segment of segments.slice(0, -1)) {
      const candidate = `${descriptorPath(parent)}/${segment}`;
      let child: number;
      try {
        child = fs.openSync(candidate, fs.constants.O_RDONLY | directory | noFollow | nonBlock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        return `profile/native-attestation: cannot safely inspect ${label}`;
      }
      if (!fs.fstatSync(child).isDirectory()) {
        closeQuietly(child);
        return `profile/native-attestation: native config ancestry is not a regular no-follow directory: ${label}`;
      }
      opened.push(child);
      parent = child;
    }

    const candidate = `${descriptorPath(parent)}/${segments.at(-1)!}`;
    let file: number;
    try {
      file = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow | nonBlock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return `profile/native-attestation: cannot safely inspect ${label}`;
    }
    opened.push(file);
    const before = fs.fstatSync(file, { bigint: true });
    if (!before.isFile()) return `profile/native-attestation: native config source is not a regular no-follow file: ${label}`;
    if (before.size > BigInt(NATIVE_CONFIG_MAX_BYTES)) {
      return `profile/native-attestation: native config exceeds the inspection limit: ${label}`;
    }
    const text = fs.readFileSync(file, "utf8");
    const after = fs.fstatSync(file, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      return `profile/native-attestation: native config changed during inspection: ${label}`;
    }
    return text.trim().length > 0
      ? `profile/native-attestation: non-empty native config is not supported by the v1 Codex inspector: ${label}`
      : undefined;
  } catch {
    return `profile/native-attestation: cannot safely inspect ${label}`;
  } finally {
    for (const fd of opened.reverse()) closeQuietly(fd);
  }
}

function parseCanonicalProfile(workspaceRoot: string, agentName: string): { profile?: AgentProfileV1; errors: string[] } {
  let source: CanonicalAgentProfileSource | undefined;
  try {
    source = readCanonicalAgentProfile(workspaceRoot, agentName);
    if (!source) return { errors: [`profile/missing: .tachyon/agents/${agentName}/agent.yml`] };
    const doc = parseDocument(source.text, { uniqueKeys: true });
    if (doc.errors.length > 0) return { errors: [`profile/invalid-yaml: ${doc.errors[0]!.message}`] };
    const parsed = agentProfileSchemaV1.safeParse(doc.toJS());
    if (!parsed.success) return { errors: parsed.error.issues.map((issue) => `profile/schema: ${issue.path.join(".") || "profile"}: ${issue.message}`) };
    return { profile: parsed.data, errors: [] };
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)] };
  } finally {
    if (source) closeCanonicalAgentProfile(source);
  }
}

function inspectMeasuredNativeInputs(input: ProjectAgentProfileInput, profile: AgentProfileV1): NativeRuntimeAttestation | string[] {
  if (!(["codex", "pi"].includes(profile.runtime.adapter)) || profile.runtime.executable !== profile.runtime.adapter) {
    return ["profile/native-attestation: measured profile projection supports only literal 'codex' and 'pi' executables"];
  }
  if (profile.runtime.model || profile.runtime.provider || profile.runtime.reasoningEffort || profile.runtime.serviceTier) {
    return ["profile/native-attestation: runtime selector migration requires a later measured projector"];
  }
  const expected = profile.runtime.adapter === "codex" ? CODEX_EMPTY_NATIVE_INPUT_INSPECTOR : PI_PRIVATE_CAPABILITY_INPUT_INSPECTOR;
  const actual = input.authority.runtimeInspector;
  if (actual.adapter !== expected.adapter || actual.id !== expected.id || actual.version !== expected.version || actual.sha256 !== expected.sha256) {
    return [`profile/native-attestation: host authority does not select the registered ${expected.adapter} inspector`];
  }

  const hasCapabilities = [
    ...(profile.capabilities?.skills ?? []),
    ...(profile.capabilities?.mcp ?? []),
    ...(profile.capabilities?.hooks ?? []),
    ...Object.values(profile.capabilities?.pi ?? {}).flatMap((values) => values ?? []),
  ].length > 0;

  if (profile.runtime.adapter === "codex") {
    const home = input.homeDir ?? os.homedir();
    const candidates: Array<[string, string[]]> = [
      [home, [".codex", "config.toml"]],
      [input.workspaceRoot, [".codex", "config.toml"]],
      ...(!hasCapabilities ? [[input.workspaceRoot, [".tachyon", "harness", input.agentName, "config.toml"]] as [string, string[]]] : []),
    ];
    const blockers: string[] = [];
    for (const [root, segments] of candidates) {
      const blocker = inspectEmptyFileAt(root, segments);
      if (blocker) blockers.push(blocker);
    }
    if (blockers.length > 0) return blockers;
  }

  const runtime = {
    adapter: profile.runtime.adapter,
    executable: profile.runtime.executable,
  };
  return {
    adapter: profile.runtime.adapter,
    exhaustive: true,
    authorityRevision: input.authority.revision,
    selectorsSha256: agentProfileRuntimeSelectorsSha256(runtime),
    inspector: { id: expected.id, version: expected.version, sha256: expected.sha256 },
    observations: hasCapabilities ? [{
      field: profile.runtime.adapter === "pi" ? "capabilities.pi" : "capabilities.mcp",
      source: "private-runtime-config",
      suppressed: true,
    }] : [],
  };
}

const CAPABILITY_REFERENCE_KINDS = new Set(["skill", "mcp", "hook", "pi-extension", "pi-prompt", "pi-theme", "pi-package"]);

function captureProjectCapabilities(input: ProjectAgentProfileInput, profile: AgentProfileV1): ExternalProfileReference[] | string[] {
  const external: ExternalProfileReference[] = [];
  const selected = new Set([
    ...(profile.capabilities?.skills ?? []),
    ...(profile.capabilities?.mcp ?? []),
    ...(profile.capabilities?.hooks ?? []),
    ...Object.values(profile.capabilities?.pi ?? {}).flatMap((values) => values ?? []),
  ]);
  for (const reference of profile.references ?? []) {
    if (reference.scope !== "project" || !CAPABILITY_REFERENCE_KINDS.has(reference.kind) || !selected.has(reference.id)) continue;
    try {
      const capturedCapability = captureCapabilitySourceAtRoot(input.workspaceRoot, reference.path, reference.sha256!);
      external.push({
        id: reference.id,
        scope: "project",
        owner: reference.owner,
        path: reference.path,
        sha256: capturedCapability.sha256,
        ...(reference.version ? { version: reference.version } : {}),
        capturedCapability,
      });
    } catch (error) {
      if (error instanceof AgentCapabilitySourceError) return [`${error.code}: ${error.message}`];
      return [`profile/reference-unavailable: ${reference.path}: project capability could not be captured`];
    }
  }
  return external;
}

function projectDefinition(resolved: ResolvedAgentProfile): AgentDef | string[] {
  const definition = resolved.definition;
  const errors: string[] = [];
  if (!(["codex", "pi"].includes(definition.runtime.adapter)) || definition.runtime.executable !== definition.runtime.adapter || definition.runtime.args?.length) {
    errors.push("profile/projection: unsupported runtime projection");
  }
  if (definition.environment?.secrets && Object.keys(definition.environment.secrets).length > 0) {
    errors.push("profile/projection: secret injection belongs to a later slice");
  }
  if (definition.prompt?.soul || definition.prompt?.instructions || definition.prompt?.evolution || definition.prompt?.memory) {
    errors.push("profile/projection: Soul, instructions, Evolution and memory belong to t-a2827d");
  }
  const nonCapabilityReferences = resolved.references.filter((reference) => !CAPABILITY_REFERENCE_KINDS.has(reference.kind));
  if (nonCapabilityReferences.length > 0) errors.push("profile/projection: referenced setup/prompt materialization is not available yet");
  if (definition.workspace?.verify || definition.workspace?.worktree?.setup?.length) {
    errors.push("profile/projection: verification/setup references are not materialized yet");
  }
  if (definition.workspace?.worktree?.base) {
    errors.push("profile/projection: per-agent worktree.base is not representable by the current runtime");
  }
  const attention = definition.lifecycle?.attention;
  if (attention?.silenceSec === 0) errors.push("profile/projection: attention.silenceSec must be at least 1 for the current runtime");
  if (errors.length > 0) return errors;

  const projected: AgentDef = {
    cmd: definition.runtime.executable,
    autostart: definition.lifecycle?.autostart ?? false,
    watch: [...(definition.lifecycle?.watch ?? [])],
    attention: {
      enabled: attention?.enabled ?? true,
      silenceSec: attention?.silenceSec ?? PROFILE_ATTENTION_DEFAULT_SILENCE_SEC,
      patterns: [...(attention?.patterns ?? [])],
    },
    restart: definition.lifecycle?.restart ?? "never",
    kind: "agent",
  };
  if (definition.workspace?.cwd) projected.cwd = definition.workspace.cwd;
  if (definition.environment?.values) projected.env = { ...definition.environment.values };
  if (definition.prompt?.role) projected.role = definition.prompt.role;
  if (definition.workspace?.worktree?.enabled !== undefined) projected.worktree = definition.workspace.worktree.enabled;
  if (definition.workspace?.worktree?.branch) projected.branch = definition.workspace.worktree.branch;
  if (definition.isolation) projected.isolate = definition.isolation;
  if (definition.ownership?.subagents) projected.subagents = [...definition.ownership.subagents];
  if (resolved.capabilityProjection) {
    projected.profileCapabilities = { ...resolved.capabilityProjection, effectiveProfileSha256: resolved.effectiveSha256 };
  }
  return projected;
}

export function projectCanonicalAgentProfile(input: ProjectAgentProfileInput): ProjectAgentProfileResult {
  const parsed = parseCanonicalProfile(input.workspaceRoot, input.agentName);
  if (!parsed.profile) return { ok: false, errors: parsed.errors };
  if (parsed.profile.agentId !== input.authority.agentId || input.authority.agentName !== input.agentName) {
    return { ok: false, errors: ["profile/authority-boundary: authority identity does not match canonical profile"] };
  }
  const externalReferences = captureProjectCapabilities(input, parsed.profile);
  if (Array.isArray(externalReferences) && externalReferences.length > 0 && typeof externalReferences[0] === "string") {
    return { ok: false, errors: externalReferences as string[] };
  }
  const attestation = inspectMeasuredNativeInputs(input, parsed.profile);
  if (Array.isArray(attestation)) return { ok: false, errors: attestation };
  const resolved = resolveAgentProfile({
    workspaceRoot: input.workspaceRoot,
    agentName: input.agentName,
    authority: authoritySnapshotFor(input.authority),
    nativeRuntime: attestation,
    workspaceDefaults: input.workspaceDefaults,
    externalReferences: externalReferences as ExternalProfileReference[],
  });
  if (!resolved.ok) return { ok: false, errors: resolved.errors.map((error) => `${error.code}: ${error.message}`) };
  const definition = projectDefinition(resolved.value);
  if (Array.isArray(definition)) return { ok: false, errors: definition };
  return { ok: true, definition, resolved: resolved.value };
}
