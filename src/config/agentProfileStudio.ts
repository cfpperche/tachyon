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
  cwd: text(4096),
  lifecycle: z.object({
    autostart: z.boolean(),
    restart: z.enum(["never", "on-crash"]),
    attention: z.boolean(),
    watch: z.array(text(1024).min(1)).max(128),
  }).strict(),
  worktree: z.object({
    enabled: z.boolean(),
    branch: text(1024),
  }).strict(),
  isolation: z.enum(["", "transcript"]),
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

const studioAgentName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/);

export const agentProfileStudioLifecycleMutationSchemaV1 = z.discriminatedUnion("operation", [
  z.object({
    schemaVersion: z.literal(1),
    operation: z.literal("set-enabled"),
    agentName: studioAgentName,
    expectedRevision: z.string().regex(REVISION),
    enabled: z.boolean(),
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    operation: z.literal("rename"),
    agentName: studioAgentName,
    expectedRevision: z.string().regex(REVISION),
    newName: studioAgentName,
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    operation: z.literal("forget"),
    agentName: studioAgentName,
    expectedRevision: z.string().regex(REVISION),
    confirmation: studioAgentName,
  }).strict(),
]);

export type AgentProfileStudioLifecycleMutationV1 = z.infer<typeof agentProfileStudioLifecycleMutationSchemaV1>;

export const agentProfileStudioLifecycleResultSchemaV1 = z.union([
  z.object({ schemaVersion: z.literal(1), kind: z.literal("snapshot"), snapshot: z.lazy(() => agentProfileStudioSnapshotSchemaV1) }).strict(),
  z.object({ schemaVersion: z.literal(1), kind: z.literal("forgotten"), agentName: studioAgentName, agentId: z.string().uuid() }).strict(),
]);

export type AgentProfileStudioLifecycleResultV1 = z.infer<typeof agentProfileStudioLifecycleResultSchemaV1>;

export const agentProfileStudioBundleRequirementSchemaV1 = z.object({
  kind: z.enum(["secret", "environment", "reference", "workspace", "ownership", "lifecycle", "isolation"]),
  field: z.string().min(1).max(512),
  referenceId: z.string().regex(ID).optional(),
  referenceKind: z.string().regex(ID).optional(),
}).strict();

export const agentProfileStudioBundleExportResultSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  agentName: studioAgentName,
  revision: z.string().regex(REVISION),
  fileName: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}\.tachyon-agent-profile\.json$/),
  contentBase64: z.string().max(350_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  byteSize: z.number().int().positive().max(256 * 1024),
  sha256: z.string().regex(REVISION),
  requiresReauthorization: z.array(agentProfileStudioBundleRequirementSchemaV1).max(256),
}).strict();

export const agentProfileStudioBundleCreatedResultSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("created"),
  operation: z.enum(["clone", "import"]),
  snapshot: z.lazy(() => agentProfileStudioSnapshotSchemaV1),
  bundleSha256: z.string().regex(REVISION),
  requiresReauthorization: z.array(agentProfileStudioBundleRequirementSchemaV1).max(256),
}).strict();

export type AgentProfileStudioBundleRequirementV1 = z.infer<typeof agentProfileStudioBundleRequirementSchemaV1>;
export type AgentProfileStudioBundleExportResultV1 = z.infer<typeof agentProfileStudioBundleExportResultSchemaV1>;
export type AgentProfileStudioBundleCreatedResultV1 = z.infer<typeof agentProfileStudioBundleCreatedResultSchemaV1>;

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
      cwd: profile.workspace?.cwd ?? "",
      lifecycle: {
        autostart: profile.lifecycle?.autostart ?? false,
        restart: profile.lifecycle?.restart ?? "never",
        attention: profile.lifecycle?.attention?.enabled ?? true,
        watch: [...(profile.lifecycle?.watch ?? [])],
      },
      worktree: {
        enabled: profile.workspace?.worktree?.enabled ?? false,
        branch: profile.workspace?.worktree?.branch ?? "",
      },
      isolation: profile.isolation ?? "",
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
    lifecycle: {
      enabled: false,
      ...(parsed.editable.lifecycle.autostart ? { autostart: true } : {}),
      ...(parsed.editable.lifecycle.restart !== "never" ? { restart: parsed.editable.lifecycle.restart } : {}),
      ...(!parsed.editable.lifecycle.attention ? { attention: { enabled: false } } : {}),
      ...(parsed.editable.lifecycle.watch.length > 0 ? { watch: [...parsed.editable.lifecycle.watch] } : {}),
    },
    ...((parsed.editable.cwd || parsed.editable.worktree.enabled || parsed.editable.worktree.branch) ? {
      workspace: {
        ...(parsed.editable.cwd ? { cwd: parsed.editable.cwd } : {}),
        ...((parsed.editable.worktree.enabled || parsed.editable.worktree.branch) ? {
          worktree: {
            ...(parsed.editable.worktree.enabled ? { enabled: true } : {}),
            ...(parsed.editable.worktree.branch ? { branch: parsed.editable.worktree.branch } : {}),
          },
        } : {}),
      },
    } : {}),
    ...(parsed.editable.isolation ? { isolation: parsed.editable.isolation } : {}),
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
  const lifecycle = {
    ...(current.profile.lifecycle ?? {}),
    autostart: parsed.editable.lifecycle.autostart,
    restart: parsed.editable.lifecycle.restart,
    attention: {
      ...(current.profile.lifecycle?.attention ?? {}),
      enabled: parsed.editable.lifecycle.attention,
    },
    watch: [...parsed.editable.lifecycle.watch],
  };
  const worktree = {
    ...(current.profile.workspace?.worktree ?? {}),
    enabled: parsed.editable.worktree.enabled,
    branch: parsed.editable.worktree.branch || undefined,
  };
  const workspace = {
    ...(current.profile.workspace ?? {}),
    cwd: parsed.editable.cwd || undefined,
    worktree,
  };
  return {
    displayName: parsed.editable.displayName || undefined,
    runtime: { ...parsed.editable.runtime },
    prompt: Object.keys(prompt).length > 0 ? prompt : undefined,
    lifecycle,
    workspace,
    isolation: parsed.editable.isolation || undefined,
  };
}

export function isAgentProfileStudioSnapshotV1(value: unknown): value is AgentProfileStudioSnapshotV1 {
  return agentProfileStudioSnapshotSchemaV1.safeParse(value).success;
}
