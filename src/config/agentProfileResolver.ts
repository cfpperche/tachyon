import crypto from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { AgentEntry } from "./loadConfig.js";
import {
  AgentProfileReadError,
  closeCanonicalAgentProfile,
  readAgentProfileReference,
  readCanonicalAgentProfile,
  type CanonicalAgentProfileSource,
} from "./agentProfileReader.js";
import {
  AGENT_PROFILE_SCHEMA_VERSION,
  agentProfileSchemaV1,
  type AgentProfileReferenceV1,
  type AgentProfileV1,
} from "./agentProfileSchema.js";
import {
  AgentCapabilitySourceError,
  captureCapabilitySourceFromDirectory,
  type CapturedCapabilitySource,
} from "./agentCapabilitySource.js";
import { parseCodexHooksBlock } from "../plugins/adapters/codex.js";
import { parseClaudeHooksBlock } from "../plugins/adapters/claude.js";
import type { WithheldCapability } from "./withheldCapability.js";

export type AgentProfileDiagnosticCode =
  | "profile/missing"
  | "profile/double-authority"
  | "profile/invalid-yaml"
  | "profile/unsupported-version"
  | "profile/schema"
  | "profile/missing-inheritance"
  | "profile/reference-unavailable"
  | "profile/reference-conflict"
  | "profile/capability"
  | "profile/capability-authority"
  | "profile/capability-collision"
  | "profile/authority-boundary"
  | "profile/native-attestation"
  | "profile/native-override"
  | "profile/provenance"
  | AgentProfileReadError["code"];

export interface AgentProfileDiagnostic {
  code: AgentProfileDiagnosticCode;
  source: string;
  field?: string;
  message: string;
}

export interface AgentProfileFieldProvenance {
  field: string;
  sourceKind: "profile" | "legacy" | "workspace" | "environment" | "project" | "product";
  source: string;
  sha256?: string;
  referenceId?: string;
  referenceMode?: "pinned" | "floating";
}

export interface ExternalProfileReference {
  id: string;
  scope: "project" | "product";
  owner: string;
  path: string;
  sha256: string;
  version?: string;
  /** Exact owner-custodied bytes for selected non-plugin capabilities. */
  capturedCapability?: CapturedCapabilitySource;
}

export interface ResolvedProfileReference extends AgentProfileReferenceV1 {
  resolvedSha256: string;
  capturedCapability?: CapturedCapabilitySource;
}

export type AgentCapabilityHookClass = "capability" | "prompt-transform" | "observability" | "enforcement";

export interface AgentCapabilityGrant {
  referenceId: string;
  sourceSha256: string;
  adapter: "claude" | "codex" | "pi";
  kind: "skill" | "mcp" | "hook" | "pi-extension" | "pi-package";
  hookClass?: AgentCapabilityHookClass;
}

export interface ResolvedAgentCapabilitySource {
  referenceId: string;
  kind: AgentProfileReferenceV1["kind"];
  scope: AgentProfileReferenceV1["scope"];
  owner: string;
  path: string;
  sha256: string;
}

export interface ResolvedAgentCapabilityProjection {
  schemaVersion: 1;
  adapter: "claude" | "codex" | "grok" | "pi";
  sha256: string;
  /** Added only to the launch copy after the complete profile digest is known. */
  effectiveProfileSha256?: string;
  sources: ResolvedAgentCapabilitySource[];
  skills: Array<{ name: string; source: CapturedCapabilitySource }>;
  /** Why each skill is in this launch snapshot. Absent on legacy/profile-only snapshots. */
  skillOrigins?: Record<string, Array<{ kind: "profile" | "delegator"; agent: string }>>;
  mcp: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  hooks: Record<string, unknown>;
  pi: {
    extensions: Array<{ name: string; source: CapturedCapabilitySource }>;
    prompts: Array<{ name: string; source: CapturedCapabilitySource }>;
    themes: Array<{ name: string; source: CapturedCapabilitySource }>;
    packages: Array<{ name: string; source: CapturedCapabilitySource }>;
  };
}

export interface WorkspaceProfileDefaults {
  worktreeBase?: string;
  worktreeBranch?: string;
  verify?: { referenceId: string; sha256: string };
  bridgeGuidance?: boolean;
  projectGuidance?: Array<{ sourcePath: string; sha256: string }>;
}

export interface NativeRuntimeObservation {
  field: "runtime.model" | "runtime.provider" | "runtime.reasoningEffort" | "runtime.serviceTier" | `environment.${string}` | `capabilities.${string}`;
  source: "command-flag" | "environment" | "private-runtime-config";
  /** True only when the adapter guarantees this input cannot reach the launched runtime. */
  suppressed: boolean;
}

export interface NativeRuntimeAttestation {
  adapter: string;
  exhaustive: true;
  authorityRevision: string;
  selectorsSha256: string;
  inspector: {
    id: string;
    version: string;
    sha256: string;
  };
  observations: readonly NativeRuntimeObservation[];
}

export type AgentProfileAuthoritySnapshot = {
  revision: string;
  canonical: { state: "absent" } | { state: "present"; sha256: string };
  runtimeInspector: {
    adapter: string;
    id: string;
    version: string;
    sha256: string;
  };
  capabilityGrants?: AgentCapabilityGrant[];
};

export interface ResolveAgentProfileInput {
  workspaceRoot: string;
  agentName: string;
  legacy?: {
    source?: string;
    definition: AgentEntry;
    /** Trusted public adapter identity; never parsed from the opaque legacy command. */
    runtime: { adapterId: string; executableId: string };
  };
  inheritedEnvironment?: Readonly<Record<string, {
    value: string;
    classification: "non-secret";
    owner: string;
  } | undefined>>;
  workspaceDefaults?: WorkspaceProfileDefaults;
  externalReferences?: readonly ExternalProfileReference[];
  /**
   * t-b0cfd4 — capability references the OWNER could not deliver, withheld by id.
   *
   * The owner captures project-scoped bytes and is therefore the only layer that can see a pin go
   * stale; this resolver would only see the reference missing and call it `reference-unavailable`,
   * which is the whole-agent refusal this replaces. Passing the ids in makes the withholding one
   * decision made once: the capability leaves the selection, the projection is built without it, and
   * everything else about the agent resolves normally.
   */
  withheldCapabilities?: readonly string[];
  /** Host-custodied profile-head snapshot; workspace path presence is not authority by itself. */
  authority: AgentProfileAuthoritySnapshot;
  /** Complete, digest-bound result from the selected runtime adapter's native-input inspector. */
  nativeRuntime: NativeRuntimeAttestation;
}

export interface NormalizedAgentEnvironment extends NonNullable<AgentProfileV1["environment"]> {
  /** Compatibility mode exposes names only; values stay in the legacy private launch input. */
  legacyUnclassifiedNames?: string[];
}

export interface NormalizedAgentWorkspace extends Omit<NonNullable<AgentProfileV1["workspace"]>, "worktree"> {
  worktree?: NonNullable<NonNullable<AgentProfileV1["workspace"]>["worktree"]> & {
    /** Compatibility provenance only; raw setup commands stay in the legacy launch input. */
    legacySetupSha256?: string[];
  };
  /** Compatibility provenance only; raw verifier stays in the legacy launch input. */
  legacyVerifySha256?: string;
}

export interface NormalizedAgentDefinition {
  runtime: {
    adapter: string;
    executable: string;
    args?: string[];
    model?: string;
    provider?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    /** Compatibility provenance only; raw command/argv remain in the legacy private launch input. */
    legacyCommandSha256?: string;
  };
  environment?: NormalizedAgentEnvironment;
  prompt?: AgentProfileV1["prompt"] & {
    legacyInstructionsSha256?: string;
    legacySoulEnabled?: boolean;
    legacyEvolutionEnabled?: boolean;
  };
  lifecycle?: AgentProfileV1["lifecycle"];
  workspace?: NormalizedAgentWorkspace;
  isolation?: AgentProfileV1["isolation"];
  ownership?: AgentProfileV1["ownership"];
  capabilities?: AgentProfileV1["capabilities"];
  nativeConfig?: AgentProfileV1["nativeConfig"];
  guidance?: AgentProfileV1["guidance"];
  inherited?: {
    bridgeGuidance?: boolean;
    projectGuidance?: Array<{ sourcePath: string; sha256: string }>;
  };
}

export interface ResolvedAgentProfile {
  schemaVersion: typeof AGENT_PROFILE_SCHEMA_VERSION;
  mode: "canonical" | "legacy";
  agentName: string;
  agentId?: string;
  displayName?: string;
  source: string;
  sourceSha256: string;
  authorityRevision: string;
  effectiveSha256: string;
  definition: NormalizedAgentDefinition;
  references: ResolvedProfileReference[];
  provenance: AgentProfileFieldProvenance[];
  nativeRuntime: NativeRuntimeAttestation;
  capabilityProjection?: ResolvedAgentCapabilityProjection;
  /**
   * t-b0cfd4 — the capabilities this resolution held back, by name, with why and the repair.
   *
   * Deliberately NOT part of `effectiveSha256`: what a withholding changes about the effective
   * profile is already there — the capability is absent from `definition.capabilities` and from
   * `capabilityProjection`. This list is the EXPLANATION of that absence, carried so the surfaces
   * that render an agent (and the delegation that copies from it) can say what is missing and how to
   * get it back, instead of showing a silently smaller agent.
   */
  withheldCapabilities?: WithheldCapability[];
}

export type ResolveAgentProfileResult =
  | { ok: true; value: ResolvedAgentProfile; warnings: AgentProfileDiagnostic[] }
  | { ok: false; errors: AgentProfileDiagnostic[]; warnings: AgentProfileDiagnostic[] };

const SHA256_RE = /^[a-f0-9]{64}$/;
const PUBLIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/;
const publicIdSchema = z.string().regex(PUBLIC_ID_RE).max(256);
const digestSchema = z.string().regex(SHA256_RE);
const inspectorDescriptorSchema = z.object({
  adapter: publicIdSchema,
  id: publicIdSchema,
  version: publicIdSchema,
  sha256: digestSchema,
}).strict();
const authoritySnapshotSchema = z.object({
  revision: publicIdSchema,
  canonical: z.discriminatedUnion("state", [
    z.object({ state: z.literal("absent") }).strict(),
    z.object({ state: z.literal("present"), sha256: digestSchema }).strict(),
  ]),
  runtimeInspector: inspectorDescriptorSchema,
  capabilityGrants: z.array(z.object({
    referenceId: publicIdSchema,
    sourceSha256: digestSchema,
    adapter: z.enum(["claude", "codex", "pi"]),
    kind: z.enum(["skill", "mcp", "hook", "pi-extension", "pi-package"]),
    hookClass: z.enum(["capability", "prompt-transform", "observability", "enforcement"]).optional(),
  }).strict()).max(256).optional(),
}).strict().superRefine((authority, ctx) => {
  const seen = new Set<string>();
  for (let index = 0; index < (authority.capabilityGrants ?? []).length; index++) {
    const grant = authority.capabilityGrants![index]!;
    if (seen.has(grant.referenceId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilityGrants", index, "referenceId"], message: "duplicates another capability grant" });
    }
    seen.add(grant.referenceId);
    if (grant.kind === "hook" && !grant.hookClass) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilityGrants", index, "hookClass"], message: "is required for a hook grant" });
    }
    if (grant.kind !== "hook" && grant.hookClass) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilityGrants", index, "hookClass"], message: "is allowed only for a hook grant" });
    }
  }
});
const nativeObservationSchema = z.object({
  field: z.string().refine((field) =>
    ["runtime.model", "runtime.provider", "runtime.reasoningEffort", "runtime.serviceTier"].includes(field)
      || /^environment\.[A-Za-z_][A-Za-z0-9_]*$/.test(field)
      || /^capabilities\.(?:skills|mcp|hooks|pi)(?:\..+)?$/.test(field), "unknown runtime-native field"),
  source: z.enum(["command-flag", "environment", "private-runtime-config"]),
  suppressed: z.boolean(),
}).strict();
const nativeAttestationSchema = z.object({
  adapter: publicIdSchema,
  exhaustive: z.literal(true),
  authorityRevision: publicIdSchema,
  selectorsSha256: digestSchema,
  inspector: z.object({ id: publicIdSchema, version: publicIdSchema, sha256: digestSchema }).strict(),
  observations: z.array(nativeObservationSchema).max(512),
}).strict().superRefine((attestation, ctx) => {
  const seen = new Set<string>();
  for (let index = 0; index < attestation.observations.length; index++) {
    const observation = attestation.observations[index]!;
    const key = `${observation.field}\0${observation.source}`;
    if (seen.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["observations", index], message: "duplicates another field/source observation" });
    }
    seen.add(key);
  }
});

function diagnostic(code: AgentProfileDiagnosticCode, source: string, message: string, field?: string): AgentProfileDiagnostic {
  return { code, source, ...(field ? { field } : {}), message };
}

function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Locale-independent UTF-16 code-unit ordering for hashes and public arrays. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function leaves(value: unknown, prefix = ""): string[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object" || Buffer.isBuffer(value)) return prefix ? [prefix] : [];
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
  if (entries.length === 0) return prefix ? [prefix] : [];
  return entries.flatMap(([key, entry]) => leaves(entry, prefix ? `${prefix}.${key}` : key));
}

function provenanceFor(
  value: unknown,
  sourceKind: AgentProfileFieldProvenance["sourceKind"],
  source: string,
  digest?: string,
): AgentProfileFieldProvenance[] {
  return leaves(value).map((field) => ({ field, sourceKind, source, ...(digest ? { sha256: digest } : {}) }));
}

function parseAgentProfile(source: CanonicalAgentProfileSource): { profile?: AgentProfileV1; errors: AgentProfileDiagnostic[] } {
  const document = parseDocument(source.text, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    return {
      errors: document.errors.map((error) => diagnostic("profile/invalid-yaml", source.source, error.message)),
    };
  }
  const raw = document.toJS() as unknown;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const version = (raw as { schemaVersion?: unknown }).schemaVersion;
    if (version !== undefined && version !== AGENT_PROFILE_SCHEMA_VERSION) {
      return { errors: [diagnostic("profile/unsupported-version", source.source, `unsupported schemaVersion ${JSON.stringify(version)}; expected ${AGENT_PROFILE_SCHEMA_VERSION}`, "schemaVersion")] };
    }
  }
  const parsed = agentProfileSchemaV1.safeParse(raw);
  if (!parsed.success) {
    return {
      errors: parsed.error.issues
        .map((issue) => diagnostic("profile/schema", source.source, issue.message, issue.path.join(".")))
        .sort((left, right) => compareText(`${left.field}:${left.message}`, `${right.field}:${right.message}`)),
    };
  }
  return { profile: parsed.data, errors: [] };
}

function externalReferenceIndex(values: readonly ExternalProfileReference[] | undefined): {
  references: Map<string, ExternalProfileReference>;
  duplicates: Set<string>;
} {
  const references = new Map<string, ExternalProfileReference>();
  const duplicates = new Set<string>();
  for (const value of values ?? []) {
    if (references.has(value.id)) duplicates.add(value.id);
    else references.set(value.id, value);
  }
  return { references, duplicates };
}

const CAPABILITY_REFERENCE_KINDS = new Set<AgentProfileReferenceV1["kind"]>([
  "skill",
  "mcp",
  "hook",
  "pi-extension",
  "pi-prompt",
  "pi-theme",
  "pi-package",
]);

function resolveReferences(
  source: CanonicalAgentProfileSource,
  profile: AgentProfileV1,
  externalValues: readonly ExternalProfileReference[] | undefined,
): {
  references: ResolvedProfileReference[];
  errors: AgentProfileDiagnostic[];
  provenance: AgentProfileFieldProvenance[];
  withheld: WithheldCapability[];
} {
  const external = externalReferenceIndex(externalValues);
  const references: ResolvedProfileReference[] = [];
  const errors: AgentProfileDiagnostic[] = [];
  const provenance: AgentProfileFieldProvenance[] = [];
  const withheld: WithheldCapability[] = [];
  const selectedCapabilities = new Set([
    ...(profile.capabilities?.skills ?? []),
    ...(profile.capabilities?.mcp ?? []),
    ...(profile.capabilities?.hooks ?? []),
    ...Object.values(profile.capabilities?.pi ?? {}).flatMap((values) => values ?? []),
  ]);
  for (const reference of [...(profile.references ?? [])].sort((left, right) => compareText(left.id, right.id))) {
    if (CAPABILITY_REFERENCE_KINDS.has(reference.kind) && !selectedCapabilities.has(reference.id)) continue;
    if (reference.scope === "profile") {
      try {
        if (CAPABILITY_REFERENCE_KINDS.has(reference.kind)) {
          const captured = captureCapabilitySourceFromDirectory(source.profileDirectoryFd, source.profileRoot, reference.path, reference.sha256!);
          references.push({ ...reference, resolvedSha256: captured.sha256, capturedCapability: captured });
          provenance.push({
            field: `references.${reference.id}`,
            sourceKind: "profile",
            source: `${source.source}#${reference.path}`,
            sha256: captured.sha256,
            referenceId: reference.id,
            referenceMode: reference.mode,
          });
          continue;
        }
        const file = readAgentProfileReference(source, reference.path, reference.sha256!);
        references.push({ ...reference, resolvedSha256: file.sha256 });
        provenance.push({
          field: `references.${reference.id}`,
          sourceKind: "profile",
          source: `${source.source}#${reference.path}`,
          sha256: file.sha256,
          referenceId: reference.id,
          referenceMode: reference.mode,
        });
      } catch (error) {
        // t-b0cfd4 — a CAPABILITY that cannot be captured is withheld by name; anything else still
        // fails the profile. The distinction is what the failure costs: a capability is one tool the
        // agent will not have, and the agent without it is still the agent. A prompt lane, an
        // Evolution selector or a setup reference is part of what the agent IS, so resolving it
        // wrong would produce a different agent rather than a smaller one.
        if (CAPABILITY_REFERENCE_KINDS.has(reference.kind) && error instanceof AgentCapabilitySourceError) {
          withheld.push(withheldFrom(reference, error));
          continue;
        }
        if (error instanceof AgentProfileReadError || error instanceof AgentCapabilitySourceError) {
          errors.push(diagnostic(error.code, error.source, error.message, `references.${reference.id}`));
        } else {
          errors.push(diagnostic("profile/reference-unavailable", reference.path, "profile-local reference could not be resolved", `references.${reference.id}`));
        }
      }
      continue;
    }

    if (external.duplicates.has(reference.id)) {
      errors.push(diagnostic("profile/reference-conflict", reference.path, `external owner supplied duplicate facts for reference ${JSON.stringify(reference.id)}`, `references.${reference.id}`));
      continue;
    }
    const resolved = external.references.get(reference.id);
    if (!resolved) {
      errors.push(diagnostic("profile/reference-unavailable", reference.path, `external reference ${JSON.stringify(reference.id)} was not supplied by its owner`, `references.${reference.id}`));
      continue;
    }
    if (!SHA256_RE.test(resolved.sha256)
      || resolved.scope !== reference.scope
      || resolved.owner !== reference.owner
      || resolved.path !== reference.path
      || (reference.version !== undefined && resolved.version !== reference.version)
      || (reference.sha256 !== undefined && resolved.sha256 !== reference.sha256)
      || (resolved.capturedCapability !== undefined && resolved.capturedCapability.sha256 !== resolved.sha256)) {
      errors.push(diagnostic("profile/reference-conflict", reference.path, `external reference ${JSON.stringify(reference.id)} does not match its declared owner, identity, version or digest`, `references.${reference.id}`));
      continue;
    }
    references.push({
      ...reference,
      resolvedSha256: resolved.sha256,
      ...(resolved.capturedCapability ? { capturedCapability: resolved.capturedCapability } : {}),
    });
    provenance.push({
      field: `references.${reference.id}`,
      sourceKind: reference.scope,
      source: reference.path,
      sha256: resolved.sha256,
      referenceId: reference.id,
      referenceMode: reference.mode,
    });
  }
  return { references, errors, provenance, withheld };
}

/** t-b0cfd4 — the failure, restated as what the human lost and what repairs it. */
export function withheldFrom(reference: AgentProfileReferenceV1, error: AgentCapabilitySourceError): WithheldCapability {
  return {
    referenceId: reference.id,
    name: path.posix.basename(reference.path),
    kind: reference.kind,
    path: reference.path,
    code: error.code,
    ...(error.expectedSha256 ? { expectedSha256: error.expectedSha256 } : {}),
    ...(error.consumedSha256 ? { consumedSha256: error.consumedSha256 } : {}),
    ...(reference.version ? { version: reference.version } : {}),
    detail: error.message,
  };
}

/**
 * t-b0cfd4 — the same profile with the withheld ids no longer selected.
 *
 * Withholding has to happen HERE, on the selection, and not by dropping the resolved reference:
 * `resolveCapabilities` reads `profile.capabilities`, so a selection left in place with no reference
 * behind it becomes `selected capability has no owner-captured payload` — a whole-agent refusal
 * describing a state nobody chose. Removing the selection makes the projection simply not contain
 * it, which is exactly what "the agent runs without that capability" means.
 */
function withoutSelectedCapabilities(profile: AgentProfileV1, withheldIds: readonly string[]): AgentProfileV1 {
  if (withheldIds.length === 0 || !profile.capabilities) return profile;
  const drop = new Set(withheldIds);
  const keep = (values: string[] | undefined): string[] | undefined =>
    values === undefined ? undefined : values.filter((id) => !drop.has(id));
  const pi = profile.capabilities.pi;
  const next: NonNullable<AgentProfileV1["capabilities"]> = {
    ...profile.capabilities,
    ...(profile.capabilities.skills ? { skills: keep(profile.capabilities.skills)! } : {}),
    ...(profile.capabilities.mcp ? { mcp: keep(profile.capabilities.mcp)! } : {}),
    ...(profile.capabilities.hooks ? { hooks: keep(profile.capabilities.hooks)! } : {}),
    ...(pi
      ? {
        pi: Object.fromEntries(Object.entries(pi).map(([target, values]) => [target, keep(values as string[] | undefined)])) as typeof pi,
      }
      : {}),
  };
  return { ...profile, capabilities: next };
}

function canonicalDefinition(profile: AgentProfileV1): NormalizedAgentDefinition {
  return {
    runtime: clone(profile.runtime),
    ...(profile.environment ? { environment: clone(profile.environment) } : {}),
    ...(profile.prompt ? { prompt: clone(profile.prompt) } : {}),
    ...(profile.lifecycle ? { lifecycle: clone(profile.lifecycle) } : {}),
    ...(profile.workspace ? { workspace: clone(profile.workspace) } : {}),
    ...(profile.isolation ? { isolation: profile.isolation } : {}),
    ...(profile.ownership ? { ownership: clone(profile.ownership) } : {}),
    ...(profile.capabilities ? { capabilities: clone(profile.capabilities) } : {}),
    ...(profile.nativeConfig ? { nativeConfig: clone(profile.nativeConfig) } : {}),
    ...(profile.guidance ? { guidance: clone(profile.guidance) } : {}),
  };
}

const capabilityMcpSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/),
  command: z.string().min(1).max(4096).refine((value) => !containsUnsafeCapabilityText(value), "must not contain control characters"),
  args: z.array(z.string().max(16 * 1024).refine((value) => !containsUnsafeCapabilityText(value), "must not contain control characters")).max(256).optional(),
  env: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z.string().regex(/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/, "must be an exact ${VAR} secret reference"),
  ).optional(),
}).strict().superRefine((server, ctx) => {
  for (const [name, reference] of Object.entries(server.env ?? {})) {
    if (reference !== `\${${name}}`) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["env", name], message: `the env key must match its reference ('\${${name}}')` });
    }
  }
});

const capabilityHookSchema = z.object({
  schemaVersion: z.literal(1),
  class: z.enum(["capability", "prompt-transform", "observability", "enforcement"]),
  hooks: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/), z.unknown()),
}).strict().refine((value) => Object.keys(value.hooks).length > 0, { path: ["hooks"], message: "must not be empty" });

function containsUnsafeCapabilityText(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function capturedFileText(reference: ResolvedProfileReference): string | undefined {
  const captured = reference.capturedCapability;
  if (!captured || captured.type !== "file") return undefined;
  const bytes = captured.entries.find((entry) => entry.type === "file")?.bytes;
  if (!bytes) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function parseCapabilityYaml<T>(reference: ResolvedProfileReference, schema: z.ZodType<T>): T | string {
  const text = capturedFileText(reference);
  if (text === undefined) return "must resolve to one UTF-8 regular file";
  const doc = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) return `contains invalid YAML: ${doc.errors[0]!.message}`;
  const parsed = schema.safeParse(doc.toJS());
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return `${issue.path.join(".") || "payload"}: ${issue.message}`;
  }
  return parsed.data;
}

function sourceSummary(reference: ResolvedProfileReference): ResolvedAgentCapabilitySource {
  return {
    referenceId: reference.id,
    kind: reference.kind,
    scope: reference.scope,
    owner: reference.owner,
    path: reference.path,
    sha256: reference.resolvedSha256,
  };
}

function projectionDigestInput(projection: Omit<ResolvedAgentCapabilityProjection, "sha256">): unknown {
  const summarize = (entry: { name: string; source: CapturedCapabilitySource }) => ({ name: entry.name, sha256: entry.source.sha256 });
  return {
    schemaVersion: projection.schemaVersion,
    adapter: projection.adapter,
    sources: projection.sources,
    skills: projection.skills.map(summarize),
    mcp: projection.mcp,
    hooks: projection.hooks,
    pi: {
      extensions: projection.pi.extensions.map(summarize),
      prompts: projection.pi.prompts.map(summarize),
      themes: projection.pi.themes.map(summarize),
      packages: projection.pi.packages.map(summarize),
    },
  };
}

/**
 * t-dfc4de — per-capability refusals withhold the capability; they do not refuse the agent.
 *
 * A refusal must be the size of what it protects. Capture failures already withhold (t-b0cfd4).
 * The cases that still lived here as whole-agent errors are the same shape, one item at a time:
 *
 *   - `profile/capability` — payload captured cleanly but does not validate (skill tree with no
 *     root SKILL.md, MCP/hook that does not parse, Pi resource of the wrong type, adapter-
 *     incompatible selection for that one id, missing captured payload, product scope without a
 *     V1 resolver).
 *   - `profile/capability-authority` — selection with no exact host-custodied grant.
 *   - `profile/capability-collision` — two capabilities claim one delivered name, OR the same
 *     reference id is selected more than once, OR an MCP name is reserved for the Bridge.
 *
 * ## Collision decision (withhold BOTH)
 *
 * When two claimants race for one delivered name, withholding only the second would silently pick
 * the first as winner and hide the conflict from the human who has to rename or deselect. Withholding
 * both is the honest answer: neither reaches the agent, the notice names the collision, and the
 * repair is "make the name unique". Choosing a winner is a profile-author decision, not a resolver
 * one.
 *
 * ## Where whole-agent refusal stays correct
 *
 * This function no longer fails the profile for the cases above. Whole-agent refusal remains correct
 * OUTSIDE this function, when the failure is about what the agent *is* rather than one tool it has:
 *
 *   - profile parse / schema / unsupported version / missing agentId (`parseAgentProfile`)
 *   - host authority boundary on the profile head (`authorityErrors`)
 *   - double authority (canonical + legacy at once)
 *   - non-capability reference failures (instructions, evolution, setup) — those define the agent
 *   - inheritance / native attestation / provenance coverage failures
 *
 * Those are not "one capability costs itself"; resolving them wrong would produce a different agent
 * or an unattested one, not a smaller one.
 */
function resolveCapabilities(
  profile: AgentProfileV1,
  references: readonly ResolvedProfileReference[],
  authority: AgentProfileAuthoritySnapshot,
): { projection?: ResolvedAgentCapabilityProjection; errors: AgentProfileDiagnostic[]; withheld: WithheldCapability[] } {
  const selected = profile.capabilities;
  const ids = [
    ...(selected?.skills ?? []),
    ...(selected?.mcp ?? []),
    ...(selected?.hooks ?? []),
    ...(selected?.pi?.extensions ?? []),
    ...(selected?.pi?.prompts ?? []),
    ...(selected?.pi?.themes ?? []),
    ...(selected?.pi?.packages ?? []),
  ];
  if (ids.length === 0) return { errors: [], withheld: [] };

  const byId = new Map(references.map((reference) => [reference.id, reference]));
  const grants = new Map((authority.capabilityGrants ?? []).map((grant) => [grant.referenceId, grant]));
  const withheld = new Map<string, WithheldCapability>();
  const markWithheld = (entry: WithheldCapability): void => {
    if (!withheld.has(entry.referenceId)) withheld.set(entry.referenceId, entry);
  };
  const withholdId = (id: string, code: AgentProfileDiagnosticCode, detail: string, fallbackPath = "agent.yml"): void => {
    const reference = byId.get(id);
    if (reference) {
      markWithheld(withheldFromDiagnostic(reference, code, detail));
      return;
    }
    markWithheld({
      referenceId: id,
      name: id,
      kind: "capability",
      path: fallbackPath,
      code,
      detail,
    });
  };

  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  for (const id of [...new Set(duplicateIds)].sort(compareText)) {
    withholdId(id, "profile/capability-collision", `capability reference ${JSON.stringify(id)} is selected more than once`);
  }

  const adapter = profile.runtime.adapter;
  if (adapter !== "claude" && adapter !== "codex" && adapter !== "pi") {
    for (const id of [...new Set(ids)].sort(compareText)) {
      withholdId(
        id,
        "profile/capability",
        `adapter ${JSON.stringify(adapter)} has no measured profile capability projection`,
        "runtime adapter",
      );
    }
    return { errors: [], withheld: [...withheld.values()] };
  }

  const piIds = [
    ...(selected?.pi?.extensions ?? []),
    ...(selected?.pi?.prompts ?? []),
    ...(selected?.pi?.themes ?? []),
    ...(selected?.pi?.packages ?? []),
  ];
  if ((adapter === "claude" || adapter === "codex") && piIds.length > 0) {
    for (const id of [...new Set(piIds)].sort(compareText)) {
      withholdId(id, "profile/capability", `Pi resources are not supported by the ${adapter} projection`, "capabilities.pi");
    }
  }
  if (adapter === "pi") {
    for (const id of [...new Set([...(selected?.mcp ?? []), ...(selected?.hooks ?? [])])].sort(compareText)) {
      withholdId(
        id,
        "profile/capability",
        "Pi profile projections support skills and explicit Pi resources, not MCP or hooks",
        "capabilities",
      );
    }
  }

  type PendingSkill = { referenceId: string; name: string; source: CapturedCapabilitySource };
  type PendingMcp = {
    referenceId: string;
    name: string;
    server: ResolvedAgentCapabilityProjection["mcp"][string];
  };
  type PendingHook = { referenceId: string; event: string; value: unknown };
  type PendingPi = { referenceId: string; name: string; source: CapturedCapabilitySource };

  const pendingSkills: PendingSkill[] = [];
  const pendingMcp: PendingMcp[] = [];
  const pendingHooks: PendingHook[] = [];
  const pendingPi: Record<keyof ResolvedAgentCapabilityProjection["pi"], PendingPi[]> = {
    extensions: [],
    prompts: [],
    themes: [],
    packages: [],
  };
  const deliveredSourceIds = new Set<string>();
  const claims = new Map<string, string>();

  /** Reserve a delivered name. On collision, withhold BOTH claimants — never pick a silent winner. */
  const claim = (namespace: string, name: string, referenceId: string): boolean => {
    if (withheld.has(referenceId)) return false;
    const key = `${namespace}:${name.normalize("NFC").toLocaleLowerCase("en-US")}`;
    const prior = claims.get(key);
    if (prior && prior !== referenceId) {
      const detail = `${namespace} name ${JSON.stringify(name)} collides between ${JSON.stringify(prior)} and ${JSON.stringify(referenceId)}`;
      withholdId(prior, "profile/capability-collision", detail, "capability projection");
      withholdId(referenceId, "profile/capability-collision", detail, "capability projection");
      claims.delete(key);
      return false;
    }
    if (!prior) claims.set(key, referenceId);
    return !withheld.has(referenceId);
  };

  const get = (id: string): ResolvedProfileReference | undefined => {
    if (withheld.has(id)) return undefined;
    const reference = byId.get(id);
    if (!reference?.capturedCapability) {
      withholdId(id, "profile/capability", `selected capability ${JSON.stringify(id)} has no owner-captured payload`);
      return undefined;
    }
    if (reference.scope === "product") {
      markWithheld(withheldFromDiagnostic(
        reference,
        "profile/capability",
        `product-scoped capability ${JSON.stringify(id)} has no registered V1 payload resolver`,
      ));
      return undefined;
    }
    return reference;
  };

  const requireGrant = (reference: ResolvedProfileReference, kind: AgentCapabilityGrant["kind"], hookClass?: AgentCapabilityHookClass): boolean => {
    const grant = grants.get(reference.id);
    if (!grant || grant.sourceSha256 !== reference.resolvedSha256 || grant.adapter !== adapter || grant.kind !== kind || grant.hookClass !== hookClass) {
      markWithheld(withheldFromDiagnostic(
        reference,
        "profile/capability-authority",
        `capability ${JSON.stringify(reference.id)} lacks an exact host-custodied ${kind} grant`,
      ));
      return false;
    }
    return true;
  };

  const markDelivered = (reference: ResolvedProfileReference): void => {
    deliveredSourceIds.add(reference.id);
  };

  for (const id of selected?.skills ?? []) {
    const reference = get(id);
    if (!reference) continue;
    const captured = reference.capturedCapability!;
    const hasSkill = captured.type === "tree" && captured.entries.some((entry) => entry.type === "file" && entry.path === "SKILL.md");
    if (!hasSkill) {
      markWithheld(withheldFromDiagnostic(
        reference,
        "profile/capability",
        `skill ${JSON.stringify(id)} must be a directory tree with a root SKILL.md`,
      ));
      continue;
    }
    const name = path.posix.basename(reference.path);
    if (adapter === "claude" && !requireGrant(reference, "skill")) continue;
    if (claim("skills", name, id)) {
      pendingSkills.push({ referenceId: id, name, source: captured });
      markDelivered(reference);
    }
  }

  for (const id of selected?.mcp ?? []) {
    const reference = get(id);
    if (!reference || (adapter !== "claude" && adapter !== "codex")) continue;
    const parsed = parseCapabilityYaml(reference, capabilityMcpSchema);
    if (typeof parsed === "string") {
      markWithheld(withheldFromDiagnostic(reference, "profile/capability", `MCP declaration ${JSON.stringify(id)} ${parsed}`));
      continue;
    }
    if (["tachyon", "tachyon_bridge"].includes(parsed.name)) {
      markWithheld(withheldFromDiagnostic(
        reference,
        "profile/capability-collision",
        `MCP name ${JSON.stringify(parsed.name)} is reserved for the Tachyon Bridge`,
      ));
      continue;
    }
    if (!requireGrant(reference, "mcp") || !claim("mcp", parsed.name, id)) continue;
    pendingMcp.push({
      referenceId: id,
      name: parsed.name,
      server: { command: parsed.command, ...(parsed.args ? { args: parsed.args } : {}), ...(parsed.env ? { env: parsed.env } : {}) },
    });
    markDelivered(reference);
  }

  for (const id of selected?.hooks ?? []) {
    const reference = get(id);
    if (!reference || (adapter !== "claude" && adapter !== "codex")) continue;
    const parsed = parseCapabilityYaml(reference, capabilityHookSchema);
    if (typeof parsed === "string") {
      markWithheld(withheldFromDiagnostic(reference, "profile/capability", `hook declaration ${JSON.stringify(id)} ${parsed}`));
      continue;
    }
    const normalized = adapter === "claude"
      ? parseClaudeHooksBlock(JSON.stringify(parsed.hooks))
      : parseCodexHooksBlock(JSON.stringify(parsed.hooks));
    if (!normalized.hooks) {
      markWithheld(withheldFromDiagnostic(
        reference,
        "profile/capability",
        `hook declaration ${JSON.stringify(id)} is not a valid ${adapter} hook block: ${normalized.errors.join("; ")}`,
      ));
      continue;
    }
    if (!requireGrant(reference, "hook", parsed.class)) continue;
    let deliveredAny = false;
    for (const [event, value] of Object.entries(normalized.hooks).sort(([left], [right]) => compareText(left, right))) {
      if (claim("hooks", event, id)) {
        pendingHooks.push({ referenceId: id, event, value });
        deliveredAny = true;
      }
    }
    if (deliveredAny && !withheld.has(id)) markDelivered(reference);
  }

  const addPi = (idsForKind: readonly string[], target: keyof ResolvedAgentCapabilityProjection["pi"], kind: AgentCapabilityGrant["kind"] | undefined, validate: (reference: ResolvedProfileReference) => string | undefined) => {
    for (const id of idsForKind) {
      const reference = get(id);
      if (!reference || adapter !== "pi") continue;
      const invalid = validate(reference);
      if (invalid) {
        markWithheld(withheldFromDiagnostic(
          reference,
          "profile/capability",
          `${target} capability ${JSON.stringify(id)} ${invalid}`,
        ));
        continue;
      }
      if (kind && !requireGrant(reference, kind)) continue;
      const name = path.posix.basename(reference.path);
      if (claim(`pi.${target}`, name, id)) {
        pendingPi[target].push({ referenceId: id, name, source: reference.capturedCapability! });
        markDelivered(reference);
      }
    }
  };
  const extensionValid = (reference: ResolvedProfileReference): string | undefined => {
    const source = reference.capturedCapability!;
    if (source.type === "file") return /\.(?:ts|js)$/.test(reference.path) ? undefined : "must be a .ts or .js file";
    return source.entries.some((entry) => entry.type === "file" && ["index.ts", "index.js"].includes(entry.path)) ? undefined : "must contain root index.ts or index.js";
  };
  const regularExtension = (extension: string) => (reference: ResolvedProfileReference): string | undefined =>
    reference.capturedCapability!.type === "file" && reference.path.endsWith(extension) ? undefined : `must be one ${extension} file`;
  const themeValid = (reference: ResolvedProfileReference): string | undefined => {
    const basic = regularExtension(".json")(reference);
    if (basic) return basic;
    const text = capturedFileText(reference);
    try {
      const parsed = JSON.parse(text ?? "") as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? undefined : "must contain one JSON object";
    } catch {
      return "must contain valid JSON";
    }
  };
  const packageClaims = (reference: ResolvedProfileReference): { claims?: Array<{ namespace: string; name: string }>; error?: string } => {
    const source = reference.capturedCapability!;
    if (source.type !== "tree") return { error: "must be a directory tree" };
    const entries = new Map(source.entries.map((entry) => [entry.path, entry]));
    const validateResource = (kind: string, raw: string): string | undefined => {
      const candidate = raw.replace(/^[!+-]/, "").trim();
      if (!candidate || candidate.includes("..") || candidate.startsWith("~") || path.posix.isAbsolute(candidate)
        || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate)) return `${kind} contains an unsafe entry`;
      const entry = entries.get(candidate);
      if (!entry) return `${kind} entry ${JSON.stringify(candidate)} is missing`;
      const validateLeaf = (leaf: string): string | undefined => {
        const leafEntry = entries.get(leaf);
        if (!leafEntry) return `${leaf} is missing`;
        if (kind === "extensions") {
          if (leafEntry.type === "file") return /\.(?:ts|js)$/.test(leaf) ? undefined : `${leaf} must end in .ts or .js`;
          return ["index.ts", "index.js"].some((name) => entries.get(`${leaf}/${name}`)?.type === "file") ? undefined : `${leaf} must contain index.ts or index.js`;
        }
        if (kind === "skills") return leafEntry.type === "directory" && entries.get(`${leaf}/SKILL.md`)?.type === "file" ? undefined : `${leaf} must be a skill directory with SKILL.md`;
        if (kind === "prompts") return leafEntry.type === "file" && leaf.endsWith(".md") ? undefined : `${leaf} must be a .md file`;
        if (kind === "themes") {
          if (leafEntry.type !== "file" || !leaf.endsWith(".json") || !leafEntry.bytes) return `${leaf} must be a .json file`;
          try {
            const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(leafEntry.bytes)) as unknown;
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? undefined : `${leaf} must contain a JSON object`;
          } catch {
            return `${leaf} must contain valid JSON`;
          }
        }
        return `unsupported package resource kind ${kind}`;
      };
      const direct = validateLeaf(candidate);
      if (!direct) return undefined;
      if (entry.type !== "directory") return direct;
      const children = new Set<string>();
      for (const item of source.entries) {
        if (!item.path.startsWith(`${candidate}/`)) continue;
        const immediate = item.path.slice(candidate.length + 1).split("/")[0]!;
        if (immediate) children.add(`${candidate}/${immediate}`);
      }
      if (children.size === 0) return `${candidate} must not be empty`;
      for (const child of [...children].sort(compareText)) {
        const invalid = validateLeaf(child);
        if (invalid) return invalid;
      }
      return undefined;
    };
    const claimed: Array<{ namespace: string; name: string }> = [];
    const add = (kind: string, value: string): string | undefined => {
      const invalid = validateResource(kind, value);
      if (invalid) return invalid;
      const candidate = value.replace(/^[!+-]/, "").trim();
      const entry = entries.get(candidate)!;
      const directDirectory = entry.type === "directory" && (kind === "extensions"
        ? ["index.ts", "index.js"].some((name) => entries.get(`${candidate}/${name}`)?.type === "file")
        : kind === "skills" && entries.get(`${candidate}/SKILL.md`)?.type === "file");
      if (entry.type === "directory" && !directDirectory) {
        const children = new Set<string>();
        for (const item of source.entries) {
          if (!item.path.startsWith(`${candidate}/`)) continue;
          const immediate = item.path.slice(candidate.length + 1).split("/")[0]!;
          if (immediate) children.add(immediate);
        }
        for (const name of [...children].sort(compareText)) claimed.push({ namespace: `pi.${kind}`, name });
      } else {
        claimed.push({ namespace: `pi.${kind}`, name: path.posix.basename(candidate) });
      }
      return undefined;
    };
    const manifest = source.entries.find((entry) => entry.type === "file" && entry.path === "package.json")?.bytes;
    if (manifest) {
      try {
        const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest)) as Record<string, unknown>;
        if (!parsed.pi || typeof parsed.pi !== "object" || Array.isArray(parsed.pi)) return { error: "package.json must contain a pi object" };
        for (const [kind, values] of Object.entries(parsed.pi as Record<string, unknown>)) {
          if (!["extensions", "skills", "prompts", "themes"].includes(kind)) continue;
          if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) return { error: `package.json pi.${kind} must be a string list` };
          for (const value of values as string[]) {
            const invalid = add(kind, value);
            if (invalid) return { error: `package.json pi.${kind} ${invalid}` };
          }
        }
      } catch {
        return { error: "package.json must contain valid UTF-8 JSON" };
      }
    } else {
      for (const kind of ["extensions", "skills", "prompts", "themes"]) {
        const root = entries.get(kind);
        if (!root) continue;
        if (root.type !== "directory") return { error: `conventional ${kind} root must be a directory` };
        const names = new Set<string>();
        for (const entry of source.entries) {
          if (!entry.path.startsWith(`${kind}/`)) continue;
          const immediate = entry.path.slice(kind.length + 1).split("/")[0]!;
          if (immediate) names.add(immediate);
        }
        if (names.size === 0) return { error: `conventional ${kind} root must not be empty` };
        for (const name of [...names].sort(compareText)) {
          const invalid = add(kind, `${kind}/${name}`);
          if (invalid) return { error: invalid };
        }
      }
    }
    return claimed.length > 0 ? { claims: claimed } : { error: "must expose at least one validated Pi resource" };
  };
  const packageValid = (reference: ResolvedProfileReference): string | undefined => packageClaims(reference).error;
  addPi(selected?.pi?.extensions ?? [], "extensions", "pi-extension", extensionValid);
  addPi(selected?.pi?.prompts ?? [], "prompts", undefined, regularExtension(".md"));
  addPi(selected?.pi?.themes ?? [], "themes", undefined, themeValid);
  addPi(selected?.pi?.packages ?? [], "packages", "pi-package", packageValid);
  for (const id of selected?.pi?.packages ?? []) {
    if (withheld.has(id)) continue;
    const reference = byId.get(id);
    if (!reference?.capturedCapability || adapter !== "pi" || packageValid(reference)
      || !pendingPi.packages.some((entry) => entry.referenceId === id && !withheld.has(id))) continue;
    for (const resource of packageClaims(reference).claims ?? []) claim(resource.namespace, resource.name, id);
  }

  // Drop anything that collision-withholding invalidated after it was staged as pending.
  const keep = (referenceId: string): boolean => !withheld.has(referenceId);
  for (const id of withheld.keys()) deliveredSourceIds.delete(id);

  const skills = pendingSkills
    .filter((entry) => keep(entry.referenceId))
    .map(({ name, source }) => ({ name, source }))
    .sort((left, right) => compareText(left.name, right.name));
  const mcp = Object.fromEntries(
    pendingMcp
      .filter((entry) => keep(entry.referenceId))
      .sort((left, right) => compareText(left.name, right.name))
      .map((entry) => [entry.name, entry.server]),
  );
  const hooks = Object.fromEntries(
    pendingHooks
      .filter((entry) => keep(entry.referenceId))
      .sort((left, right) => compareText(left.event, right.event))
      .map((entry) => [entry.event, entry.value]),
  );
  const pi: ResolvedAgentCapabilityProjection["pi"] = {
    extensions: [],
    prompts: [],
    themes: [],
    packages: [],
  };
  for (const target of ["extensions", "prompts", "themes", "packages"] as const) {
    pi[target] = pendingPi[target]
      .filter((entry) => keep(entry.referenceId))
      .map(({ name, source }) => ({ name, source }))
      .sort((left, right) => compareText(left.name, right.name));
  }

  const sources = [...deliveredSourceIds]
    .map((id) => byId.get(id))
    .filter((reference): reference is ResolvedProfileReference => reference !== undefined)
    .map(sourceSummary)
    .sort((left, right) => compareText(`${left.scope}:${left.owner}:${left.referenceId}`, `${right.scope}:${right.owner}:${right.referenceId}`));

  const withheldList = [...withheld.values()].sort((left, right) => compareText(left.referenceId, right.referenceId));
  const deliveredAnything = sources.length > 0
    || skills.length > 0
    || Object.keys(mcp).length > 0
    || Object.keys(hooks).length > 0
    || Object.values(pi).some((values) => values.length > 0);
  if (!deliveredAnything) return { errors: [], withheld: withheldList };

  const withoutDigest: Omit<ResolvedAgentCapabilityProjection, "sha256"> = {
    schemaVersion: 1,
    adapter,
    sources,
    skills,
    mcp,
    hooks,
    pi,
  };
  return {
    projection: { ...withoutDigest, sha256: sha256(stableJson(projectionDigestInput(withoutDigest))) },
    errors: [],
    withheld: withheldList,
  };
}

/** t-dfc4de — a resolveCapabilities diagnostic restated as a withheld capability. */
function withheldFromDiagnostic(
  reference: Pick<AgentProfileReferenceV1, "id" | "kind" | "path" | "version">,
  code: AgentProfileDiagnosticCode,
  detail: string,
): WithheldCapability {
  return {
    referenceId: reference.id,
    name: path.posix.basename(reference.path),
    kind: reference.kind,
    path: reference.path,
    code,
    ...(reference.version ? { version: reference.version } : {}),
    detail,
  };
}

function legacyDefinition(definition: AgentEntry, runtime: { adapterId: string; executableId: string }): NormalizedAgentDefinition {
  const legacyEnvironmentNames = Object.keys(definition.env ?? {}).sort(compareText);
  return {
    runtime: {
      adapter: runtime.adapterId,
      executable: runtime.executableId,
      legacyCommandSha256: sha256(definition.cmd),
    },
    ...(legacyEnvironmentNames.length > 0 ? { environment: { legacyUnclassifiedNames: legacyEnvironmentNames } } : {}),
    ...((definition.instructions || definition.role || definition.soul || definition.selfEvolution) ? {
      prompt: {
        ...(definition.instructions ? { legacyInstructionsSha256: sha256(definition.instructions) } : {}),
        ...(definition.role ? { role: definition.role } : {}),
        ...(definition.soul ? { legacySoulEnabled: true } : {}),
        ...(definition.selfEvolution?.enabled ? { legacyEvolutionEnabled: true } : {}),
      },
    } : {}),
    lifecycle: {
      autostart: definition.autostart,
      watch: [...definition.watch],
      attention: clone(definition.attention),
      restart: definition.restart,
    },
    ...((definition.cwd || definition.worktree !== undefined || definition.branch || definition.worktreeSetup || definition.verify) ? {
      workspace: {
        ...(definition.cwd ? { cwd: definition.cwd } : {}),
        ...((definition.worktree !== undefined || definition.branch || definition.worktreeSetup) ? {
          worktree: {
            ...(definition.worktree !== undefined ? { enabled: definition.worktree } : {}),
            ...(definition.branch ? { branch: definition.branch } : {}),
            ...(definition.worktreeSetup ? { legacySetupSha256: definition.worktreeSetup.map((command) => sha256(command)) } : {}),
          },
        } : {}),
        ...(definition.verify ? { legacyVerifySha256: sha256(definition.verify) } : {}),
      },
    } : {}),
    ...(definition.isolate ? { isolation: definition.isolate } : {}),
    ...(definition.subagents ? { ownership: { subagents: [...definition.subagents] } } : {}),
  };
}

function applyInheritance(
  profile: AgentProfileV1,
  definition: NormalizedAgentDefinition,
  input: ResolveAgentProfileInput,
  resolvedReferences: readonly ResolvedProfileReference[],
): { errors: AgentProfileDiagnostic[]; provenance: AgentProfileFieldProvenance[] } {
  const errors: AgentProfileDiagnostic[] = [];
  const provenance: AgentProfileFieldProvenance[] = [];
  const environmentNames = [...new Set(profile.inherit?.environment ?? [])].sort();
  for (const name of environmentNames) {
    if (definition.environment?.values?.[name] !== undefined || definition.environment?.secrets?.[name] !== undefined) continue;
    const inheritedValue = input.inheritedEnvironment?.[name];
    if (!inheritedValue
      || inheritedValue.classification !== "non-secret"
      || typeof inheritedValue.value !== "string"
      || typeof inheritedValue.owner !== "string"
      || !inheritedValue.owner.trim()) {
      errors.push(diagnostic("profile/missing-inheritance", "inherited environment", `named environment ${JSON.stringify(name)} is unavailable`, `environment.${name}`));
      continue;
    }
    definition.environment ??= {};
    definition.environment.values ??= {};
    definition.environment.values[name] = inheritedValue.value;
    provenance.push({ field: `environment.values.${name}`, sourceKind: "environment", source: inheritedValue.owner });
  }

  const inherited = new Set(profile.inherit?.workspace ?? []);
  const defaults = input.workspaceDefaults;
  const missing = (field: string) => errors.push(diagnostic("profile/missing-inheritance", "workspace defaults", `named workspace default ${JSON.stringify(field)} is unavailable`, field));
  if (inherited.has("worktree.base") && definition.workspace?.worktree?.base === undefined) {
    if (defaults?.worktreeBase === undefined) missing("workspace.worktree.base");
    else {
      definition.workspace ??= {};
      definition.workspace.worktree ??= {};
      definition.workspace.worktree.base = defaults.worktreeBase;
      provenance.push({ field: "workspace.worktree.base", sourceKind: "workspace", source: "settings.worktree.base" });
    }
  }
  if (inherited.has("worktree.branch") && definition.workspace?.worktree?.branch === undefined) {
    if (defaults?.worktreeBranch === undefined) missing("workspace.worktree.branch");
    else {
      definition.workspace ??= {};
      definition.workspace.worktree ??= {};
      definition.workspace.worktree.branch = defaults.worktreeBranch;
      provenance.push({ field: "workspace.worktree.branch", sourceKind: "workspace", source: "settings.worktree.branch" });
    }
  }
  if (inherited.has("verify") && definition.workspace?.verify === undefined) {
    const inheritedVerifier = defaults?.verify;
    const resolvedVerifier = inheritedVerifier
      ? resolvedReferences.find((reference) => reference.id === inheritedVerifier.referenceId)
      : undefined;
    if (!inheritedVerifier
      || !SHA256_RE.test(inheritedVerifier.sha256)
      || !resolvedVerifier
      || resolvedVerifier.kind !== "verification"
      || resolvedVerifier.mode !== "pinned"
      || resolvedVerifier.resolvedSha256 !== inheritedVerifier.sha256) {
      missing("workspace.verify");
    }
    else {
      definition.workspace ??= {};
      definition.workspace.verify = inheritedVerifier.referenceId;
      provenance.push({ field: "workspace.verify", sourceKind: "workspace", source: "settings.worktree.verify", sha256: inheritedVerifier.sha256 });
    }
  }
  if (inherited.has("bridgeGuidance")) {
    if (defaults?.bridgeGuidance === undefined) missing("inherited.bridgeGuidance");
    else {
      definition.inherited ??= {};
      definition.inherited.bridgeGuidance = defaults.bridgeGuidance;
      provenance.push({ field: "inherited.bridgeGuidance", sourceKind: "product", source: "settings.bridgeGuidance" });
    }
  }
  if (inherited.has("projectGuidance")) {
    if (!defaults?.projectGuidance?.length
      || defaults.projectGuidance.some((source) => typeof source.sourcePath !== "string" || !source.sourcePath || !SHA256_RE.test(source.sha256))) {
      missing("inherited.projectGuidance");
    }
    else {
      definition.inherited ??= {};
      definition.inherited.projectGuidance = clone(defaults.projectGuidance);
      for (const [index, source] of defaults.projectGuidance.entries()) {
        provenance.push(
          { field: `inherited.projectGuidance.${index}.sourcePath`, sourceKind: "project", source: source.sourcePath, sha256: source.sha256 },
          { field: `inherited.projectGuidance.${index}.sha256`, sourceKind: "project", source: source.sourcePath, sha256: source.sha256 },
        );
      }
    }
  }
  return { errors, provenance };
}

function provenanceCoverageErrors(
  definition: NormalizedAgentDefinition,
  provenance: readonly AgentProfileFieldProvenance[],
): AgentProfileDiagnostic[] {
  const counts = new Map<string, number>();
  for (const entry of provenance) counts.set(entry.field, (counts.get(entry.field) ?? 0) + 1);
  const errors: AgentProfileDiagnostic[] = [];
  for (const field of leaves(definition)) {
    const count = counts.get(field) ?? 0;
    if (count === 0) errors.push(diagnostic("profile/provenance", "resolved profile", "effective field has no provenance", field));
    else if (count > 1) errors.push(diagnostic("profile/provenance", "resolved profile", "effective field has more than one provenance owner", field));
  }
  return errors;
}

export function agentProfileRuntimeSelectorsSha256(runtime: NormalizedAgentDefinition["runtime"]): string {
  return sha256(stableJson(runtime));
}

function nativeAttestationErrors(
  attestation: NativeRuntimeAttestation | undefined,
  runtime: NormalizedAgentDefinition["runtime"],
  authority: AgentProfileAuthoritySnapshot,
): AgentProfileDiagnostic[] {
  if (!attestation) {
    return [diagnostic("profile/native-attestation", "runtime adapter", "complete native-input attestation is required")];
  }
  const parsed = nativeAttestationSchema.safeParse(attestation);
  if (!parsed.success) {
    return [diagnostic("profile/native-attestation", "runtime adapter", "native-input attestation has an invalid or incomplete runtime shape")];
  }
  const checked = parsed.data as NativeRuntimeAttestation;
  const errors: AgentProfileDiagnostic[] = [];
  if (checked.exhaustive !== true) {
    errors.push(diagnostic("profile/native-attestation", "runtime adapter", "native-input inspection must be exhaustive"));
  }
  if (checked.adapter !== runtime.adapter) {
    errors.push(diagnostic("profile/native-attestation", "runtime adapter", "native-input attestation is for a different adapter", "runtime.adapter"));
  }
  if (checked.authorityRevision !== authority.revision) {
    errors.push(diagnostic("profile/native-attestation", "runtime adapter", "native-input attestation is bound to another profile authority revision"));
  }
  if (checked.adapter !== authority.runtimeInspector.adapter
    || checked.inspector.id !== authority.runtimeInspector.id
    || checked.inspector.version !== authority.runtimeInspector.version
    || checked.inspector.sha256 !== authority.runtimeInspector.sha256) {
    errors.push(diagnostic("profile/native-attestation", "runtime adapter", "native-input attestation does not match the host-custodied inspector descriptor"));
  }
  if (checked.selectorsSha256 !== agentProfileRuntimeSelectorsSha256(runtime)) {
    errors.push(diagnostic("profile/native-attestation", "runtime adapter", "native-input attestation is not bound to the effective runtime selectors", "runtime"));
  }
  return [
    ...errors,
    ...checked.observations
    .filter((observation) => !observation.suppressed)
    .map((observation) => diagnostic(
      "profile/native-override",
      observation.source,
      `runtime-native input for ${observation.field} is not proven suppressed or isolated`,
      observation.field,
    )),
  ];
}

function normalizedAttestation(attestation: NativeRuntimeAttestation): NativeRuntimeAttestation {
  return {
    ...clone(attestation),
    observations: [...attestation.observations].sort((left, right) =>
      compareText(`${left.field}:${left.source}:${left.suppressed}`, `${right.field}:${right.source}:${right.suppressed}`)),
  };
}

function authorityErrors(
  authority: AgentProfileAuthoritySnapshot | undefined,
  canonical: CanonicalAgentProfileSource | undefined,
): AgentProfileDiagnostic[] {
  const parsed = authoritySnapshotSchema.safeParse(authority);
  if (!parsed.success) {
    return [diagnostic("profile/authority-boundary", "profile authority", "host-custodied profile revision is required")];
  }
  const checked = parsed.data as AgentProfileAuthoritySnapshot;
  if (canonical) {
    if (checked.canonical.state !== "present" || checked.canonical.sha256 !== canonical.sha256) {
      return [diagnostic("profile/authority-boundary", canonical.source, "canonical bytes do not match the host-custodied profile head")];
    }
  } else if (checked.canonical.state !== "absent") {
    return [diagnostic("profile/authority-boundary", "profile authority", "host profile head declares canonical bytes that are unavailable")];
  }
  return [];
}

function orderedDiagnostics(values: readonly AgentProfileDiagnostic[]): AgentProfileDiagnostic[] {
  return [...values].sort((left, right) =>
    compareText(`${left.code}:${left.field ?? ""}:${left.source}:${left.message}`, `${right.code}:${right.field ?? ""}:${right.source}:${right.message}`));
}

function failure(errors: readonly AgentProfileDiagnostic[], warnings: readonly AgentProfileDiagnostic[]): ResolveAgentProfileResult {
  return { ok: false, errors: orderedDiagnostics(errors), warnings: orderedDiagnostics(warnings) };
}

function finalize(
  mode: "canonical" | "legacy",
  input: ResolveAgentProfileInput,
  source: string,
  sourceDigest: string,
  definition: NormalizedAgentDefinition,
  provenance: AgentProfileFieldProvenance[],
  references: ResolvedProfileReference[],
  profile?: AgentProfileV1,
  capabilityProjection?: ResolvedAgentCapabilityProjection,
  withheldCapabilities?: readonly WithheldCapability[],
): ResolvedAgentProfile {
  const nativeRuntime = normalizedAttestation(input.nativeRuntime);
  const orderedProvenance = [...provenance].sort((left, right) => compareText(`${left.field}:${left.source}`, `${right.field}:${right.source}`));
  const digestInput = {
    schemaVersion: AGENT_PROFILE_SCHEMA_VERSION,
    mode,
    agentName: input.agentName,
    ...(profile ? { agentId: profile.agentId } : {}),
    authorityRevision: input.authority.revision,
    definition,
    references: references.map(({ capturedCapability: _capturedCapability, ...reference }) => reference),
    ...(capabilityProjection ? { capabilityProjectionSha256: capabilityProjection.sha256 } : {}),
    provenance: orderedProvenance,
    nativeRuntime,
  };
  return {
    schemaVersion: AGENT_PROFILE_SCHEMA_VERSION,
    mode,
    agentName: input.agentName,
    ...(profile ? { agentId: profile.agentId, ...(profile.displayName ? { displayName: profile.displayName } : {}) } : {}),
    source,
    sourceSha256: sourceDigest,
    authorityRevision: input.authority.revision,
    effectiveSha256: sha256(stableJson(digestInput)),
    definition,
    references,
    provenance: orderedProvenance,
    nativeRuntime,
    ...(capabilityProjection ? { capabilityProjection } : {}),
    ...(withheldCapabilities?.length ? { withheldCapabilities: [...withheldCapabilities] } : {}),
  };
}

export function resolveAgentProfile(input: ResolveAgentProfileInput): ResolveAgentProfileResult {
  const warnings: AgentProfileDiagnostic[] = [];
  let canonical: CanonicalAgentProfileSource | undefined;
  try {
    canonical = readCanonicalAgentProfile(input.workspaceRoot, input.agentName);
  } catch (error) {
    if (error instanceof AgentProfileReadError) {
      return failure([diagnostic(error.code, error.source, error.message)], warnings);
    }
    return failure([diagnostic("profile/io", "agent profile", "canonical profile could not be read")], warnings);
  }

  try {
    if (canonical && input.legacy) {
      return failure([diagnostic(
        "profile/double-authority",
        canonical.source,
        `canonical profile conflicts with legacy owner ${JSON.stringify(input.legacy.source ?? `tachyon.yml#agents.${input.agentName}`)}`,
      )], warnings);
    }

    const authority = authorityErrors(input.authority, canonical);
    if (authority.length > 0) return failure(authority, warnings);
    if (!canonical && !input.legacy) {
      return failure([diagnostic("profile/missing", `.tachyon/agents/${input.agentName}/agent.yml`, "neither canonical profile nor legacy compatibility definition exists")], warnings);
    }

    if (input.legacy) {
      const source = input.legacy.source ?? `tachyon.yml#agents.${input.agentName}`;
      if (!PUBLIC_ID_RE.test(input.legacy.runtime.adapterId) || !PUBLIC_ID_RE.test(input.legacy.runtime.executableId)) {
        return failure([diagnostic("profile/schema", source, "legacy runtime descriptor must contain public adapter/executable ids", "runtime")], warnings);
      }
      const definition = legacyDefinition(input.legacy.definition, input.legacy.runtime);
      const errors = nativeAttestationErrors(input.nativeRuntime, definition.runtime, input.authority);
      if (errors.length > 0) return failure(errors, warnings);
      const sourceDigest = sha256(stableJson(input.legacy.definition));
      const provenance = provenanceFor(definition, "legacy", source, sourceDigest);
      const coverage = provenanceCoverageErrors(definition, provenance);
      if (coverage.length > 0) return failure(coverage, warnings);
      return { ok: true, value: finalize("legacy", input, source, sourceDigest, definition, provenance, []), warnings };
    }

    const parsed = parseAgentProfile(canonical!);
    if (!parsed.profile) return failure(parsed.errors, warnings);
    // t-b0cfd4 / t-dfc4de — withholding is applied to the SELECTION, in three passes, before the
    // effective definition is sealed. (1) Owner withholdings (project-scoped bytes it could not
    // capture). (2) Profile-local capture failures discovered while resolving references. (3)
    // resolveCapabilities withholdings (invalid payload, missing grant, name collision). Everything
    // downstream — normalized definition, provenance, capability projection, effective digest — is
    // then computed from one profile that already reflects what the agent actually gets.
    const selected = withoutSelectedCapabilities(parsed.profile, input.withheldCapabilities ?? []);
    const referenceResult = resolveReferences(canonical!, selected, input.externalReferences);
    const afterCapture = withoutSelectedCapabilities(selected, referenceResult.withheld.map((entry) => entry.referenceId));
    const capabilityResult = resolveCapabilities(afterCapture, referenceResult.references, input.authority);
    const capabilityWithheldIds = new Set(capabilityResult.withheld.map((entry) => entry.referenceId));
    const profile = withoutSelectedCapabilities(afterCapture, [...capabilityWithheldIds]);
    // Captured-but-undeliverable refs leave the delivered set the same way uncaptured ones never
    // entered it: the agent does not carry sources it was not given.
    const deliveredReferences = referenceResult.references.filter((reference) => !capabilityWithheldIds.has(reference.id));
    const definition = canonicalDefinition(profile);
    const inheritance = applyInheritance(profile, definition, input, deliveredReferences);
    const errors = [
      ...referenceResult.errors,
      ...inheritance.errors,
      ...capabilityResult.errors,
      ...nativeAttestationErrors(input.nativeRuntime, definition.runtime, input.authority),
    ];
    if (errors.length > 0) return failure(errors, warnings);

    const provenance = [
      { field: "agentId", sourceKind: "profile" as const, source: canonical!.source, sha256: canonical!.sha256 },
      ...(profile.displayName ? [{ field: "displayName", sourceKind: "profile" as const, source: canonical!.source, sha256: canonical!.sha256 }] : []),
      ...provenanceFor(canonicalDefinition(profile), "profile", canonical!.source, canonical!.sha256),
      ...referenceResult.provenance.filter((entry) => !entry.referenceId || !capabilityWithheldIds.has(entry.referenceId)),
      ...inheritance.provenance,
    ];
    const coverage = provenanceCoverageErrors(definition, provenance);
    if (coverage.length > 0) return failure(coverage, warnings);
    const allWithheld = [...referenceResult.withheld, ...capabilityResult.withheld];
    return {
      ok: true,
      value: finalize(
        "canonical",
        input,
        canonical!.source,
        canonical!.sha256,
        definition,
        provenance,
        deliveredReferences,
        profile,
        capabilityResult.projection,
        allWithheld,
      ),
      warnings,
    };
  } finally {
    if (canonical) closeCanonicalAgentProfile(canonical);
  }
}
