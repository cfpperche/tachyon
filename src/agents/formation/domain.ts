import crypto from "node:crypto";
import { z } from "zod";
import type { AgentProfileAuthorityRecord } from "../../config/agentProfileAuthority.js";
import { AGENT_NAME_PATTERN } from "../../config/nameValidation.js";

export const PROFILE_ACTIVATION_HEAD_SCHEMA_VERSION = 2 as const;
export const FORMATION_GENERATION_SCHEMA_VERSION = 1 as const;
export const FORMATION_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const FORMATION_SELECTOR_SCHEMA_VERSION = 1 as const;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const publicId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/);
const revision = z.number().int().min(1);

export function formationDigest(value: unknown): string {
  const stable = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(stable);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, stable(child)]));
    }
    return entry;
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

const disabledLaneSchema = z.object({ mode: z.literal("disabled") }).strict();
const legacyLaneSchema = z.object({ mode: z.literal("legacy") }).strict();
const profileLaneSchema = z.object({
  mode: z.literal("profile"),
  required: z.literal(true),
  selectorId: publicId,
  subjectId: publicId,
  path: z.string().min(1).max(512),
  sourceSha256: digest,
  rendererContract: publicId,
  rendererSha256: digest,
}).strict();

export const formationLaneSchema = z.discriminatedUnion("mode", [legacyLaneSchema, disabledLaneSchema, profileLaneSchema]);
export type FormationLane = z.infer<typeof formationLaneSchema>;
export type FormationLaneName = "soul" | "instructions" | "evolution" | "memory";

export const profileActivationHeadV2Schema = z.object({
  schemaVersion: z.literal(PROFILE_ACTIVATION_HEAD_SCHEMA_VERSION),
  workspaceId: publicId,
  agentId: z.string().uuid(),
  agentName: z.string().regex(AGENT_NAME_PATTERN),
  revision,
  priorRevision: z.number().int().min(0),
  canonicalSha256: digest,
  effectiveSha256: digest,
  runtimeInspector: z.object({
    adapter: publicId,
    id: publicId,
    version: publicId,
    sha256: digest,
  }).strict(),
  lanes: z.object({
    soul: formationLaneSchema,
    instructions: formationLaneSchema,
    evolution: formationLaneSchema,
    memory: formationLaneSchema,
  }).strict(),
}).strict().superRefine((head, ctx) => {
  if (head.revision !== head.priorRevision + 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["revision"], message: "must advance priorRevision by exactly one" });
  }
  const modes = Object.values(head.lanes).map((lane) => lane.mode);
  if (modes.includes("legacy") && modes.some((mode) => mode !== "legacy")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lanes"], message: "legacy authority cannot mix with canonical lane modes" });
  }
});
export type ProfileActivationHeadV2 = z.infer<typeof profileActivationHeadV2Schema>;

const authorityRefSchema = z.object({ revision, digest }).strict();

export const evolutionActivationHeadV2Schema = z.object({
  schemaVersion: z.literal(2),
  workspaceId: publicId,
  agentId: z.string().uuid(),
  profileId: publicId,
  revision,
  priorRevision: z.number().int().min(0),
  activeVersion: z.number().int().min(0),
  profileManifestSha256: digest,
  learningsSha256: digest,
  skillsInventorySha256: digest,
  skillInventory: z.array(z.object({
    path: z.string(),
    sha256: digest,
    bytes: z.number().int().min(0).max(16 * 1024 * 1024),
    executable: z.boolean(),
  }).strict()).max(1024),
}).strict().superRefine((head, ctx) => {
  if (head.revision !== head.priorRevision + 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["revision"], message: "must advance priorRevision by exactly one" });
  }
  const paths = new Set<string>();
  for (const [index, entry] of head.skillInventory.entries()) {
    if (formationSkillRelativePathError(entry.path) || !entry.path.startsWith("evolution/")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["skillInventory", index, "path"], message: "must be a safe Evolution snapshot path" });
    }
    const canonicalPath = entry.path.toLowerCase();
    if (canonicalPath === "evolution/learnings.md") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["skillInventory", index, "path"], message: "is reserved for active Evolution learnings" });
    }
    if (paths.has(canonicalPath) || (index > 0 && head.skillInventory[index - 1]!.path >= entry.path)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["skillInventory", index, "path"], message: "must be unique and strictly sorted" });
    }
    paths.add(canonicalPath);
  }
  const objects: FormationObject[] = head.skillInventory.map((entry) => ({ kind: "evolution-skill", ...entry }));
  if (formationSkillInventoryDigest(objects) !== head.skillsInventorySha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["skillsInventorySha256"], message: "must bind the complete skill inventory" });
  }
});
export type EvolutionActivationHeadV2 = z.infer<typeof evolutionActivationHeadV2Schema>;

export const memoryActivationHeadV1Schema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: publicId,
  agentId: z.string().uuid(),
  activationId: publicId,
  profileRevision: revision,
  revision,
  priorRevision: z.number().int().min(0),
  manifestSha256: digest,
  contentInventorySha256: digest,
  rendererContract: publicId,
  rendererSha256: digest,
}).strict().superRefine((head, ctx) => {
  if (head.revision !== head.priorRevision + 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["revision"], message: "must advance priorRevision by exactly one" });
  }
});
export type MemoryActivationHeadV1 = z.infer<typeof memoryActivationHeadV1Schema>;

export const formationGenerationHeadV1Schema = z.object({
  schemaVersion: z.literal(FORMATION_GENERATION_SCHEMA_VERSION),
  workspaceId: publicId,
  agentId: z.string().uuid(),
  generation: revision,
  priorGeneration: z.number().int().min(0),
  retired: z.boolean(),
  profile: authorityRefSchema,
  evolution: authorityRefSchema.optional(),
  memory: authorityRefSchema.optional(),
  rendererContractsSha256: digest,
}).strict().superRefine((head, ctx) => {
  if (head.generation !== head.priorGeneration + 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["generation"], message: "must advance priorGeneration by exactly one" });
  }
});
export type FormationGenerationHeadV1 = z.infer<typeof formationGenerationHeadV1Schema>;

export interface FormationAuthorityVector {
  profile: ProfileActivationHeadV2;
  generation: FormationGenerationHeadV1;
  evolution?: EvolutionActivationHeadV2;
  memory?: MemoryActivationHeadV1;
}

export function validateFormationAuthorityVector(vector: FormationAuthorityVector): string[] {
  const errors: string[] = [];
  const parsedProfile = profileActivationHeadV2Schema.safeParse(vector.profile);
  const parsedGeneration = formationGenerationHeadV1Schema.safeParse(vector.generation);
  const parsedEvolution = vector.evolution ? evolutionActivationHeadV2Schema.safeParse(vector.evolution) : undefined;
  const parsedMemory = vector.memory ? memoryActivationHeadV1Schema.safeParse(vector.memory) : undefined;
  if (!parsedProfile.success) errors.push("profile activation head is invalid");
  if (!parsedGeneration.success) errors.push("formation generation head is invalid");
  if (parsedEvolution && !parsedEvolution.success) errors.push("Evolution activation head is invalid");
  if (parsedMemory && !parsedMemory.success) errors.push("memory activation head is invalid");
  if (errors.length > 0) return errors;

  const { profile, generation, evolution, memory } = vector;
  for (const [label, value] of [["profile", profile], ["generation", generation], ["Evolution", evolution], ["memory", memory]] as const) {
    if (!value) continue;
    if (value.workspaceId !== profile.workspaceId) errors.push(`${label} authority belongs to another workspace`);
    if (value.agentId !== profile.agentId) errors.push(`${label} authority belongs to another agentId`);
  }
  const profileDigest = formationDigest(profile);
  if (generation.profile.revision !== profile.revision || generation.profile.digest !== profileDigest) {
    errors.push("formation generation does not bind the exact profile activation head");
  }

  const evolutionLane = profile.lanes.evolution;
  if (evolutionLane.mode === "profile") {
    if (!evolution) errors.push("enabled Evolution lane has no activation head");
    else {
      if (evolutionLane.subjectId !== evolution.profileId) errors.push("Evolution selector subject does not match activation profileId");
      if (!generation.evolution || generation.evolution.revision !== evolution.revision
        || generation.evolution.digest !== formationDigest(evolution)) errors.push("formation generation does not bind the exact Evolution head");
    }
  } else {
    if (evolution) errors.push("disabled/legacy Evolution lane must not have an activation head");
    if (generation.evolution) errors.push("disabled/legacy Evolution lane must not have an active generation reference");
  }

  const memoryLane = profile.lanes.memory;
  if (memoryLane.mode === "profile") {
    if (!memory) errors.push("enabled memory lane has no activation head");
    else {
      if (memory.profileRevision !== profile.revision) errors.push("memory activation is bound to another profile revision");
      if (memoryLane.subjectId !== memory.activationId) errors.push("memory selector subject does not match activation id");
      if (memoryLane.sourceSha256 !== memory.manifestSha256) errors.push("memory selector does not match active manifest");
      if (memoryLane.rendererContract !== memory.rendererContract || memoryLane.rendererSha256 !== memory.rendererSha256) {
        errors.push("memory renderer does not match profile selection");
      }
      if (!generation.memory || generation.memory.revision !== memory.revision
        || generation.memory.digest !== formationDigest(memory)) errors.push("formation generation does not bind the exact memory head");
    }
  } else {
    if (memory) errors.push("disabled/legacy memory lane must not have an activation head");
    if (generation.memory) errors.push("disabled/legacy memory lane must not have an active generation reference");
  }
  return errors;
}

export function formationSkillRelativePathError(value: string): string | undefined {
  if (value !== value.normalize("NFC")) return "must use NFC Unicode normalization";
  if (value.length === 0 || value.length > 1024) return "must be between 1 and 1024 characters";
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return "must be a portable relative path";
  const segments = value.split("/");
  if (segments.length < 2 || segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment)
    || segment === "." || segment === "..")) return "must contain canonical non-dot path segments";
  if (["plugin", "plugins", ".tachyon", "config", "hooks", "mcp"].includes(segments[0]!.toLowerCase())) {
    return "must stay inside the Evolution skill namespace";
  }
  return undefined;
}

export const formationObjectSchema = z.object({
  kind: z.enum(["startup-prompt", "reanchor-reminder", "evolution-learnings", "evolution-skill"]),
  path: z.string().superRefine((value, ctx) => {
    const error = formationSkillRelativePathError(value);
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
  }).optional(),
  sha256: digest,
  bytes: z.number().int().min(0).max(16 * 1024 * 1024),
  executable: z.boolean().optional(),
}).strict();
export type FormationObject = z.infer<typeof formationObjectSchema>;

export const formationSnapshotManifestV1Schema = z.object({
  schemaVersion: z.literal(FORMATION_SNAPSHOT_SCHEMA_VERSION),
  snapshotId: z.string().uuid(),
  workspaceId: publicId,
  agentId: z.string().uuid(),
  agentName: z.string().regex(AGENT_NAME_PATTERN),
  runtimeTrustClass: publicId,
  formationGeneration: revision,
  formationGenerationSha256: digest,
  objects: z.array(formationObjectSchema).min(2).max(1024),
  createdAt: z.string().datetime(),
}).strict().superRefine((manifest, ctx) => {
  if (manifest.objects.filter((object) => object.kind === "startup-prompt").length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["objects"], message: "must contain exactly one startup prompt" });
  }
  if (manifest.objects.filter((object) => object.kind === "reanchor-reminder").length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["objects"], message: "must contain exactly one re-anchor reminder" });
  }
  const keys = new Set<string>();
  const paths = new Set<string>();
  for (const [index, object] of manifest.objects.entries()) {
    const key = `${object.kind}\0${(object.path ?? "").toLowerCase()}`;
    if (keys.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["objects", index], message: "duplicates another object role/path" });
    keys.add(key);
    if (object.path) {
      const normalizedPath = object.path.toLowerCase();
      if (paths.has(normalizedPath)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["objects", index, "path"], message: "collides with another immutable object path" });
      paths.add(normalizedPath);
      if (object.kind === "evolution-skill" && normalizedPath === "evolution/learnings.md") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["objects", index, "path"], message: "is reserved for active Evolution learnings" });
      }
    }
    if ((object.kind === "evolution-skill" || object.kind === "evolution-learnings") && !object.path) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["objects", index, "path"], message: "is required for Evolution objects" });
    }
    if ((object.kind === "startup-prompt" || object.kind === "reanchor-reminder") && (object.path !== undefined || object.executable !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["objects", index], message: "prompt objects cannot declare path or executable" });
    }
    if (object.kind === "evolution-learnings" && (object.path !== "evolution/LEARNINGS.md" || object.executable !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["objects", index], message: "Evolution learnings must use the canonical non-executable path" });
    }
  }
});
export type FormationSnapshotManifestV1 = z.infer<typeof formationSnapshotManifestV1Schema>;

export function formationSkillInventoryDigest(objects: readonly FormationObject[]): string {
  return formationDigest(objects
    .filter((object) => object.kind === "evolution-skill")
    .map((object) => ({ path: object.path, sha256: object.sha256, bytes: object.bytes, executable: object.executable === true }))
    .sort((left, right) => left.path! < right.path! ? -1 : left.path! > right.path! ? 1 : 0));
}

export const formationSessionSelectorV1Schema = z.object({
  schemaVersion: z.literal(FORMATION_SELECTOR_SCHEMA_VERSION),
  sessionId: z.string().uuid(),
  workspaceId: publicId,
  agentId: z.string().uuid(),
  agentName: z.string().regex(AGENT_NAME_PATTERN),
  ownerPrincipal: publicId,
  ownerKind: z.enum(["human", "system", "agent"]),
  runtimeTrustClass: publicId,
  snapshotId: z.string().uuid(),
  snapshotSha256: digest,
  formationGeneration: revision,
  formationGenerationSha256: digest,
  rootSessionId: z.string().uuid(),
  parentSessionId: z.string().uuid().optional(),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().optional(),
}).strict();
export type FormationSessionSelectorV1 = z.infer<typeof formationSessionSelectorV1Schema>;

/** Existing v1 profile authority can only upgrade to canonical lanes disabled. */
export function profileActivationHeadV2FromV1(input: {
  workspaceId: string;
  legacy: AgentProfileAuthorityRecord;
  effectiveSha256: string;
}): ProfileActivationHeadV2 {
  return profileActivationHeadV2Schema.parse({
    schemaVersion: PROFILE_ACTIVATION_HEAD_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    agentId: input.legacy.agentId,
    agentName: input.legacy.agentName,
    revision: 1,
    priorRevision: 0,
    canonicalSha256: input.legacy.canonicalSha256,
    effectiveSha256: input.effectiveSha256,
    runtimeInspector: input.legacy.runtimeInspector,
    lanes: {
      soul: { mode: "disabled" },
      instructions: { mode: "disabled" },
      evolution: { mode: "disabled" },
      memory: { mode: "disabled" },
    },
  });
}
