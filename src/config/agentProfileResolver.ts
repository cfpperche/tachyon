import crypto from "node:crypto";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { AgentDef } from "./loadConfig.js";
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

export type AgentProfileDiagnosticCode =
  | "profile/missing"
  | "profile/double-authority"
  | "profile/invalid-yaml"
  | "profile/unsupported-version"
  | "profile/schema"
  | "profile/missing-inheritance"
  | "profile/reference-unavailable"
  | "profile/reference-conflict"
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
}

export interface ResolvedProfileReference extends AgentProfileReferenceV1 {
  resolvedSha256: string;
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
};

export interface ResolveAgentProfileInput {
  workspaceRoot: string;
  agentName: string;
  legacy?: {
    source?: string;
    definition: AgentDef;
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
}).strict();
const nativeObservationSchema = z.object({
  field: z.string().refine((field) =>
    ["runtime.model", "runtime.provider", "runtime.reasoningEffort", "runtime.serviceTier"].includes(field)
      || /^environment\.[A-Za-z_][A-Za-z0-9_]*$/.test(field)
      || /^capabilities\.(?:skills|mcp|hooks)(?:\..+)?$/.test(field), "unknown runtime-native field"),
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

function parseCanonicalProfile(source: CanonicalAgentProfileSource): { profile?: AgentProfileV1; errors: AgentProfileDiagnostic[] } {
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

function resolveReferences(
  source: CanonicalAgentProfileSource,
  profile: AgentProfileV1,
  externalValues: readonly ExternalProfileReference[] | undefined,
): { references: ResolvedProfileReference[]; errors: AgentProfileDiagnostic[]; provenance: AgentProfileFieldProvenance[] } {
  const external = externalReferenceIndex(externalValues);
  const references: ResolvedProfileReference[] = [];
  const errors: AgentProfileDiagnostic[] = [];
  const provenance: AgentProfileFieldProvenance[] = [];
  for (const reference of [...(profile.references ?? [])].sort((left, right) => compareText(left.id, right.id))) {
    if (reference.scope === "profile") {
      try {
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
        if (error instanceof AgentProfileReadError) {
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
      || (reference.sha256 !== undefined && resolved.sha256 !== reference.sha256)) {
      errors.push(diagnostic("profile/reference-conflict", reference.path, `external reference ${JSON.stringify(reference.id)} does not match its declared owner, identity, version or digest`, `references.${reference.id}`));
      continue;
    }
    references.push({ ...reference, resolvedSha256: resolved.sha256 });
    provenance.push({
      field: `references.${reference.id}`,
      sourceKind: reference.scope,
      source: reference.path,
      sha256: resolved.sha256,
      referenceId: reference.id,
      referenceMode: reference.mode,
    });
  }
  return { references, errors, provenance };
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
    ...(profile.guidance ? { guidance: clone(profile.guidance) } : {}),
  };
}

function legacyDefinition(definition: AgentDef, runtime: { adapterId: string; executableId: string }): NormalizedAgentDefinition {
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
    references,
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

    const parsed = parseCanonicalProfile(canonical!);
    if (!parsed.profile) return failure(parsed.errors, warnings);
    const profile = parsed.profile;
    const definition = canonicalDefinition(profile);
    const referenceResult = resolveReferences(canonical!, profile, input.externalReferences);
    const inheritance = applyInheritance(profile, definition, input, referenceResult.references);
    const errors = [
      ...referenceResult.errors,
      ...inheritance.errors,
      ...nativeAttestationErrors(input.nativeRuntime, definition.runtime, input.authority),
    ];
    if (errors.length > 0) return failure(errors, warnings);

    const provenance = [
      { field: "agentId", sourceKind: "profile" as const, source: canonical!.source, sha256: canonical!.sha256 },
      ...(profile.displayName ? [{ field: "displayName", sourceKind: "profile" as const, source: canonical!.source, sha256: canonical!.sha256 }] : []),
      ...provenanceFor(canonicalDefinition(profile), "profile", canonical!.source, canonical!.sha256),
      ...referenceResult.provenance,
      ...inheritance.provenance,
    ];
    const coverage = provenanceCoverageErrors(definition, provenance);
    if (coverage.length > 0) return failure(coverage, warnings);
    return {
      ok: true,
      value: finalize("canonical", input, canonical!.source, canonical!.sha256, definition, provenance, referenceResult.references, profile),
      warnings,
    };
  } finally {
    if (canonical) closeCanonicalAgentProfile(canonical);
  }
}
