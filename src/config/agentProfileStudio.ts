import { z } from "zod";
import type { AgentProfileLifecycleSnapshot } from "./agentProfileLifecycle.js";
import type { AgentProfileV1 } from "./agentProfileSchema.js";

const ID = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const REVISION = /^[a-f0-9]{64}$/;
const text = (max: number) => z.string().max(max);

export const agentProfileStudioEditableSchemaV1 = z.object({
  displayName: text(256),
  runtime: z.object({
    adapter: z.string().regex(ID),
    executable: z.string().min(1).max(4096),
    model: text(512).optional(),
    provider: text(512).optional(),
    reasoningEffort: text(128).optional(),
    serviceTier: text(128).optional(),
  }).strict(),
  role: z.enum(["", "coder", "reviewer", "tester", "orchestrator", "custom"]),
}).strict();

export const agentProfileStudioMutationSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("canonical"),
  agentName: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/),
  expectedRevision: z.string().regex(REVISION).optional(),
  editable: agentProfileStudioEditableSchemaV1,
}).strict();

export type AgentProfileStudioEditableV1 = z.infer<typeof agentProfileStudioEditableSchemaV1>;
export type AgentProfileStudioMutationV1 = z.infer<typeof agentProfileStudioMutationSchemaV1>;

export const agentProfileStudioSnapshotSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("canonical"),
  agentName: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/),
  agentId: z.string().uuid(),
  revision: z.string().regex(REVISION),
  enabled: z.boolean(),
  editable: agentProfileStudioEditableSchemaV1,
  bindings: z.object({
    environmentValueNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(128),
    secretNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(128),
    prompt: z.object({
      soul: z.boolean(),
      instructions: z.boolean(),
      evolution: z.boolean(),
      memoryPolicy: z.enum(["disabled", "runtime-managed", "human-approved"]).optional(),
    }).strict(),
    capabilities: z.object({
      skills: z.number().int().nonnegative().max(128),
      mcp: z.number().int().nonnegative().max(128),
      hooks: z.number().int().nonnegative().max(128),
      pi: z.number().int().nonnegative().max(512),
    }).strict(),
    externalReferences: z.number().int().nonnegative().max(128),
  }).strict(),
  provenance: z.object({
    canonical: z.object({ scope: z.literal("profile"), writable: z.literal(true), sha256: z.string().regex(REVISION) }).strict(),
    authority: z.object({ scope: z.literal("host"), writable: z.literal(false), revision: z.string().min(1).max(256), grants: z.number().int().nonnegative() }).strict(),
    learned: z.object({ scope: z.literal("profile"), writable: z.literal(false), present: z.boolean() }).strict(),
    projection: z.object({ scope: z.literal("runtime"), writable: z.literal(false), active: z.boolean() }).strict(),
  }).strict(),
}).strict();

export type AgentProfileStudioSnapshotV1 = z.infer<typeof agentProfileStudioSnapshotSchemaV1>;

export function projectAgentProfileStudioSnapshot(snapshot: AgentProfileLifecycleSnapshot): AgentProfileStudioSnapshotV1 {
  const profile = snapshot.profile;
  return agentProfileStudioSnapshotSchemaV1.parse({
    schemaVersion: 1,
    kind: "canonical",
    agentName: snapshot.agentName,
    agentId: snapshot.agentId,
    revision: snapshot.revision,
    enabled: profile.lifecycle?.enabled !== false,
    editable: {
      displayName: profile.displayName ?? "",
      runtime: { ...profile.runtime },
      role: profile.prompt?.role ?? "",
    },
    bindings: {
      environmentValueNames: Object.keys(profile.environment?.values ?? {}).sort(),
      secretNames: Object.keys(profile.environment?.secrets ?? {}).sort(),
      prompt: {
        soul: profile.prompt?.soul !== undefined,
        instructions: profile.prompt?.instructions !== undefined,
        evolution: profile.prompt?.evolution !== undefined,
        ...(profile.prompt?.memory ? { memoryPolicy: profile.prompt.memory.policy } : {}),
      },
      capabilities: {
        skills: profile.capabilities?.skills?.length ?? 0,
        mcp: profile.capabilities?.mcp?.length ?? 0,
        hooks: profile.capabilities?.hooks?.length ?? 0,
        pi: (profile.capabilities?.pi?.extensions?.length ?? 0)
          + (profile.capabilities?.pi?.prompts?.length ?? 0)
          + (profile.capabilities?.pi?.themes?.length ?? 0)
          + (profile.capabilities?.pi?.packages?.length ?? 0),
      },
      externalReferences: (profile.references ?? []).filter((reference) => reference.scope !== "profile").length,
    },
    provenance: structuredClone(snapshot.provenance),
  });
}

export function createProfileFromStudioMutation(
  mutation: AgentProfileStudioMutationV1,
): Omit<AgentProfileV1, "schemaVersion" | "agentId"> {
  const parsed = agentProfileStudioMutationSchemaV1.parse(mutation);
  if (parsed.expectedRevision !== undefined) throw new Error("new canonical profile must not carry an expected revision");
  return {
    ...(parsed.editable.displayName ? { displayName: parsed.editable.displayName } : {}),
    runtime: { ...parsed.editable.runtime },
    ...(parsed.editable.role ? { prompt: { role: parsed.editable.role } } : {}),
    lifecycle: { enabled: false },
  };
}

export function patchProfileFromStudioMutation(
  mutation: AgentProfileStudioMutationV1,
  current: AgentProfileLifecycleSnapshot,
): Partial<Omit<AgentProfileV1, "schemaVersion" | "agentId">> {
  const parsed = agentProfileStudioMutationSchemaV1.parse(mutation);
  if (!parsed.expectedRevision) throw new Error("canonical profile edit requires expectedRevision");
  if (parsed.agentName !== current.agentName || parsed.expectedRevision !== current.revision) {
    throw new Error(`agent '${parsed.agentName}' profile revision conflict`);
  }
  const prompt = { ...(current.profile.prompt ?? {}) };
  if (parsed.editable.role) prompt.role = parsed.editable.role;
  else delete prompt.role;
  return {
    displayName: parsed.editable.displayName || undefined,
    runtime: { ...parsed.editable.runtime },
    prompt: Object.keys(prompt).length > 0 ? prompt : undefined,
  };
}

export function isAgentProfileStudioSnapshotV1(value: unknown): value is AgentProfileStudioSnapshotV1 {
  return agentProfileStudioSnapshotSchemaV1.safeParse(value).success;
}
