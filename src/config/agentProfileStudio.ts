import { z } from "zod";
import type { AgentProfileLifecycleSnapshot } from "./agentProfileLifecycle.js";
import { agentNativeConfigSchemaV1 } from "./agentNativeConfigSchema.js";
import type { AgentProfileV1 } from "./agentProfileSchema.js";
import { AGENT_PROFILE_REFUSAL_CODE_RE, AgentProfileRefusal } from "./agentProfileRefusal.js";
import {
  previewAgentNativeConfigPolicy,
  resolveAgentNativeConfigSupport,
  validateAgentNativeConfigPolicy,
} from "./agentNativeConfigPolicy.js";
import { adapterForRuntime, forkable, runtimeOf } from "../resume/adapters.js";
import { runtimeProfile, type CanonicalRuntimeLimitation } from "../runtime/runtimeProfile.js";
import { ATTESTED_RUNTIMES, isAttestedRuntime } from "../runtime/attestedRuntimes.js";

const ID = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const REVISION = /^[a-f0-9]{64}$/;
const text = (max: number) => z.string().max(max);
const capabilityIdsSchema = z.object({
  skills: z.array(z.string().regex(ID)).max(128),
  mcp: z.array(z.string().regex(ID)).max(128),
  hooks: z.array(z.string().regex(ID)).max(128),
}).strict();

const canonicalRuntimeLimitationSchema = z.enum([
  "runtime-baseline-unverified",
  "fork-unavailable",
  "permission-policy-partial",
  "attention-composer-unverified",
  "stop-active-turn-unverified",
  "oauth-concurrency-single-live",
]);

const canonicalRuntimeReadinessSchema = z.object({
  state: z.enum(["ready", "limited"]),
  limitations: z.array(canonicalRuntimeLimitationSchema).max(8),
}).strict();

type CanonicalRuntimeReadinessLimitation = z.infer<typeof canonicalRuntimeLimitationSchema>;

function canonicalRuntimeReadiness(adapter: string) {
  const runtime = runtimeOf(adapter);
  const limitations: CanonicalRuntimeReadinessLimitation[] = [];
  if (!runtime) limitations.push("runtime-baseline-unverified");
  if (runtime && !forkable(adapterForRuntime(runtime))) limitations.push("fork-unavailable");
  for (const limitation of runtime ? runtimeProfile(runtime)?.canonicalLimitations ?? [] : []) {
    limitations.push(limitation satisfies CanonicalRuntimeLimitation);
  }
  return {
    state: limitations.length === 0 ? "ready" as const : "limited" as const,
    limitations,
  };
}

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
  /**
   * t-bd14d8 — no `watch` here, and the object is `.strict()`, so a mutation that carries one is
   * REFUSED rather than ignored. A watch restarts the process on a file change, and
   * `Workspace.rebuildWatches` runs that as `{ stop: "force", session: "new" }` — force-kill plus a
   * fresh session. That is what a dev server wants and the opposite of what an Agent can survive.
   *
   * `agentProfileSchemaV1.lifecycle` still ACCEPTS `watch` on read, deliberately: a profile already
   * on disk with one must keep loading. It is stripped with a warning at projection instead
   * (`projectCanonicalAgentProfile`), and the first edit-and-save through this door drops it from the
   * file — the same shape t-b54ead used for the terminal form's agent-only keys, in reverse.
   */
  lifecycle: z.object({
    autostart: z.boolean(),
    restart: z.enum(["never", "on-crash"]),
    attention: z.boolean(),
  }).strict(),
  worktree: z.object({
    enabled: z.boolean(),
    branch: text(1024),
  }).strict(),
  isolation: z.enum(["", "transcript"]),
  nativeConfig: agentNativeConfigSchemaV1.optional(),
  /** Existing, authority-bound capability references only; Studio cannot author a new reference. */
  capabilities: capabilityIdsSchema.optional(),
}).strict();

export const agentProfileStudioMutationSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("agent-instance"),
  agentName: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/),
  expectedRevision: z.string().regex(REVISION).optional(),
  editable: agentProfileStudioEditableSchemaV1,
}).strict();

export type AgentProfileStudioEditableV1 = z.infer<typeof agentProfileStudioEditableSchemaV1>;
export type AgentProfileStudioMutationV1 = z.infer<typeof agentProfileStudioMutationSchemaV1>;

const CLAUDE_STUDIO_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function assertStudioNativeConfig(editable: AgentProfileStudioEditableV1): void {
  const adapter = editable.runtime.adapter;
  if (adapter !== "claude") return;
  const errors = validateAgentNativeConfigPolicy(adapter, editable.nativeConfig);
  const hasSelectors = Boolean(
    editable.runtime.model
    || editable.runtime.provider
    || editable.runtime.reasoningEffort
    || editable.runtime.serviceTier,
  );
  const selectorPolicy = editable.nativeConfig?.selectors;
  if (
    hasSelectors
    && (!selectorPolicy
      || resolveAgentNativeConfigSupport(adapter, "selectors", selectorPolicy).support !== "supported")
  ) {
    errors.push(`profile/native-config-selector: runtime '${adapter}' requires its exact selector policy`);
  }
  if (editable.runtime.provider) {
    errors.push("profile/native-config-selector: Claude provider is not authorable");
  }
  if (editable.runtime.serviceTier) {
    errors.push("profile/native-config-selector: Claude service tier is not authorable");
  }
  if (
    editable.runtime.reasoningEffort
    && !CLAUDE_STUDIO_EFFORTS.has(editable.runtime.reasoningEffort)
  ) {
    errors.push("profile/native-config-selector: Claude effort must be low, medium, high, xhigh or max");
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

const studioAgentName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/);

/** Mirrors `agentProfileSchemaV1.ownership.subagents`; the roster is the same bound on both ends. */
/**
 * t-4071e4 — the isolation a NEWLY created agent gets when nothing has chosen for it.
 *
 * Isolated, because the only other default is "share the human's checkout", and an agent nobody has
 * configured yet is exactly the one that should not be editing the tree the human works in. Every
 * creation door reads this: Saved Agent Proposal approval, portable import/clone, and the Studio's
 * blank new-agent form — the bug this constant exists to prevent is those three disagreeing.
 *
 * This is a CREATION default, not a projection default. `projectAgentProfileStudioSnapshot` still
 * reports a missing `workspace.worktree` as OFF, because an existing profile without that key really
 * is running in the shared checkout, and reporting it as isolated would be a lie about live agents.
 */
export const DEFAULT_NEW_AGENT_WORKTREE_ENABLED = true;

export const AGENT_OWNERSHIP_MAX_SUBAGENTS = 128;

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
  /**
   * t-4c113c — declare (or clear) `ownership.subagents` on the OWNER's canonical profile.
   *
   * The full list is always sent, never a delta: the roster constraints spec 352 fails closed on
   * (single owner, one level, no cycle) are properties of the whole list, so a caller that could
   * add one name without restating the rest would be validating against a list nobody submitted.
   * An empty list is the removal, which is why this carries no separate "clear" operation.
   */
  z.object({
    schemaVersion: z.literal(1),
    operation: z.literal("set-subagents"),
    agentName: studioAgentName,
    expectedRevision: z.string().regex(REVISION),
    subagents: z.array(studioAgentName).max(AGENT_OWNERSHIP_MAX_SUBAGENTS),
  }).strict(),
  /**
   * t-3bde32 — grant or revoke `grants.proposeSavedAgent` on this agent's canonical profile.
   *
   * SDD 482 shipped the schema, the reader, the Bridge door and the commit gate for this grant, and
   * every one of them refuses when it is absent — but nothing could ever set it. Dogfood on 0.56.115
   * found the hole the only way it could be found: `codex-canonico` called `propose_saved_agent`, was
   * correctly refused `capability_absent`, and the sole remaining move was hand-editing
   * `.tachyon/agents/<agent>/agent.yml`, which is precisely the ungoverned door the whole feature
   * exists to close. A governed capability nobody can grant through the governed path is not governed;
   * it is unusable.
   *
   * Its own operation rather than a field on the Agent Form save: this is an authority decision, it
   * needs its own risk copy, and it must not be something a human changes by accident while editing a
   * model name. Same reasoning that gave `set-subagents` its own operation.
   */
  z.object({
    schemaVersion: z.literal(1),
    operation: z.literal("set-propose-saved-agent-grant"),
    agentName: studioAgentName,
    expectedRevision: z.string().regex(REVISION),
    granted: z.boolean(),
  }).strict(),
]);

export type AgentProfileStudioLifecycleMutationV1 = z.infer<typeof agentProfileStudioLifecycleMutationSchemaV1>;

/**
 * t-05dff5 — `refused` is a third OUTCOME, not a failure mode.
 *
 * A governed precondition ("still owns a worktree; remove it explicitly before canonical forget") is
 * an answer the engine computed, so it travels as a value on the success channel, exactly as the
 * skill/plugin authorization doors already do. Reaching the shell as a thrown error would strand it:
 * the wire flattens an exception to `{ status: "error", code: "COMMAND_FAILED", message }` with the
 * class gone, and the cockpit would be back to guessing from prose which is the bug this replaces.
 *
 * `code` is validated by SHAPE rather than against the closed code list, so a shell one release
 * behind an engine renders a refusal it has never heard of instead of rejecting the payload as
 * malformed and falling back to "the profile lifecycle action could not be completed" — which is the
 * one sentence this whole change exists to stop showing. `message` is bounded to the same 1 000
 * characters the engine transport already bounds every message to.
 */
export const agentProfileStudioLifecycleResultSchemaV1 = z.union([
  z.object({ schemaVersion: z.literal(1), kind: z.literal("snapshot"), snapshot: z.lazy(() => agentProfileStudioSnapshotSchemaV1) }).strict(),
  z.object({ schemaVersion: z.literal(1), kind: z.literal("forgotten"), agentName: studioAgentName, agentId: z.string().uuid() }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    kind: z.literal("refused"),
    code: z.string().regex(AGENT_PROFILE_REFUSAL_CODE_RE),
    message: z.string().min(1).max(1_000),
  }).strict(),
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
  kind: z.literal("agent-instance"),
  agentName: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/),
  agentId: z.string().uuid(),
  revision: z.string().regex(REVISION),
  enabled: z.boolean(),
  readiness: canonicalRuntimeReadinessSchema,
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
    tooling: z.object({
      skills: z.array(z.object({ id: z.string().regex(ID), scope: z.enum(["profile", "project", "product"]) }).strict()).max(128),
      mcp: z.array(z.object({ id: z.string().regex(ID), scope: z.enum(["profile", "project", "product"]) }).strict()).max(128),
      hooks: z.array(z.object({ id: z.string().regex(ID), scope: z.enum(["profile", "project", "product"]) }).strict()).max(128),
    }).strict(),
    externalReferences: z.number().int().nonnegative().max(128),
    /**
     * t-3bde32 — the profile's own `grants`, surfaced so Studio can show and change them.
     *
     * NOT `provenance.authority.grants`, which is a COUNT of host-custodied capability grants for
     * skills/MCP/hooks. These are different things that a reader would otherwise conflate: one is how
     * many tool resources a host authorized, the other is whether a human gave this agent the
     * authority to ask for new agents. Absence is refusal, so the projection writes an explicit
     * `false` rather than omitting the field — a UI that renders "not set" and a UI that renders
     * "denied" should not be the same pixel.
     */
    grants: z.object({ proposeSavedAgent: z.boolean() }).strict(),
  }).strict(),
  provenance: z.object({
    canonical: z.object({ scope: z.literal("profile"), writable: z.literal(true), sha256: z.string().regex(REVISION) }).strict(),
    authority: z.object({ scope: z.literal("host"), writable: z.literal(false), revision: z.string().min(1).max(256), grants: z.number().int().nonnegative() }).strict(),
    learned: z.object({ scope: z.literal("profile"), writable: z.literal(false), present: z.boolean() }).strict(),
    projection: z.object({ scope: z.literal("runtime"), writable: z.literal(false), active: z.boolean() }).strict(),
    nativeConfig: z.array(z.object({
      family: z.enum(["selectors", "permissions", "interface", "tooling", "featureFlags", "authentication", "memory", "diagnostics"]),
      source: z.enum(["global", "workspace", "agent"]),
      treatment: z.enum(["exclude", "snapshot", "overlay", "external"]),
      refresh: z.enum(["create-once", "every-launch", "runtime-owned"]),
      lifecycle: z.array(z.enum(["fresh", "restart", "resume", "fork"])).min(1).max(4),
      support: z.enum(["supported", "unsupported"]),
      reason: z.string().min(1).max(512),
    }).strict()).max(8).optional(),
  }).strict(),
}).strict();

export type AgentProfileStudioSnapshotV1 = z.infer<typeof agentProfileStudioSnapshotSchemaV1>;

export function projectAgentProfileStudioSnapshot(snapshot: AgentProfileLifecycleSnapshot): AgentProfileStudioSnapshotV1 {
  const profile = snapshot.profile;
  return agentProfileStudioSnapshotSchemaV1.parse({
    schemaVersion: 1,
    kind: "agent-instance",
    agentName: snapshot.agentName,
    agentId: snapshot.agentId,
    revision: snapshot.revision,
    enabled: profile.lifecycle?.enabled !== false,
    readiness: canonicalRuntimeReadiness(profile.runtime.adapter),
    editable: {
      displayName: profile.displayName ?? "",
      runtime: { ...profile.runtime },
      role: profile.prompt?.role ?? "",
      cwd: profile.workspace?.cwd ?? "",
      // t-bd14d8 — a stored `lifecycle.watch` is NOT projected into the editable view. The form has
      // no control for it, so surfacing it would offer a value with nowhere to render and no way to
      // clear. The human is told about it once per load by the projection warning, and the first save
      // through this door removes it from the file.
      lifecycle: {
        autostart: profile.lifecycle?.autostart ?? false,
        restart: profile.lifecycle?.restart ?? "never",
        attention: profile.lifecycle?.attention?.enabled ?? true,
      },
      worktree: {
        enabled: profile.workspace?.worktree?.enabled ?? false,
        branch: profile.workspace?.worktree?.branch ?? "",
      },
      isolation: profile.isolation ?? "",
      nativeConfig: structuredClone(profile.nativeConfig ?? {}),
      capabilities: {
        skills: [...(profile.capabilities?.skills ?? [])],
        mcp: [...(profile.capabilities?.mcp ?? [])],
        hooks: [...(profile.capabilities?.hooks ?? [])],
      },
    },
    bindings: {
      grants: { proposeSavedAgent: profile.grants?.proposeSavedAgent === true },
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
      tooling: Object.fromEntries(["skills", "mcp", "hooks"].map((family) => {
        const kind = family === "skills" ? "skill" : family === "mcp" ? "mcp" : "hook";
        const granted = new Set(snapshot.provenance.authority.capabilityReferenceIds ?? []);
        return [family, (profile.references ?? [])
          .filter((reference) => reference.kind === kind && granted.has(reference.id))
          .map((reference) => ({ id: reference.id, scope: reference.scope }))
          .sort((left, right) => left.id.localeCompare(right.id))];
      })),
      externalReferences: (profile.references ?? []).filter((reference) => reference.scope !== "profile").length,
    },
    provenance: {
      canonical: { ...snapshot.provenance.canonical },
      authority: {
        scope: "host",
        writable: false,
        revision: snapshot.provenance.authority.revision,
        grants: snapshot.provenance.authority.grants,
      },
      learned: { ...snapshot.provenance.learned },
      projection: { ...snapshot.provenance.projection },
      nativeConfig: previewAgentNativeConfigPolicy(profile.runtime.adapter, profile.nativeConfig).map((entry) => ({
        family: entry.family,
        source: entry.policy.source,
        treatment: entry.policy.treatment,
        refresh: entry.policy.refresh,
        lifecycle: entry.policy.lifecycle,
        support: entry.support,
        reason: entry.reason,
      })),
    },
  });
}

/**
 * t-d68b8b — creation is limited to a runtime Tachyon attests, refused HERE because this is the one
 * door both actors arrive through.
 *
 * The Interface reaches it by saving Agent Studio's New Agent form; an Agent reaches it through
 * `propose_saved_agent`, whose `runtime_adapter` is a free-form string that lands in
 * `savedAgentProposal.recordSavedAgentProposal` and is validated by calling this function. A guard
 * placed only in the form would leave the second door open — and it would open onto the same dead
 * end, since `agentProfileProjection` refuses to project a non-attested profile and the agent would
 * be created and then unusable.
 *
 * `patchProfileFromStudioMutation` deliberately does NOT call this. An existing profile that somehow
 * names a non-attested runtime is already written; refusing to edit it would trap it, and the
 * projection still declines to run it. Only minting a new one is blocked.
 *
 * Reversible by decision, not by accident: the owner narrowed the creation path on 2026-08-07 "for
 * now". Widening `ATTESTED_RUNTIMES` widens this with no edit here, which is the whole point of
 * reading the list rather than restating it.
 */
function assertAttestedCreationRuntime(adapter: string): void {
  if (isAttestedRuntime(adapter)) return;
  throw new Error(
    `runtime '${adapter}' cannot back a new canonical agent: creation covers only the runtimes Tachyon `
    + `attests (${ATTESTED_RUNTIMES.join(", ")}). This is a limit of the creation path, not a verdict on `
    + "the runtime — the block lifts as soon as the runtime is attested.",
  );
}

export function createProfileFromStudioMutation(
  mutation: AgentProfileStudioMutationV1,
): Omit<AgentProfileV1, "schemaVersion" | "agentId"> {
  const parsed = agentProfileStudioMutationSchemaV1.parse(mutation);
  assertStudioNativeConfig(parsed.editable);
  assertAttestedCreationRuntime(parsed.editable.runtime.adapter);
  if (parsed.expectedRevision !== undefined) throw new Error("new canonical profile must not carry an expected revision");
  if (Object.values(parsed.editable.capabilities ?? {}).some((entries) => entries.length > 0)) {
    throw new Error("new canonical profile cannot select capability references before host authorization");
  }
  return {
    ...(parsed.editable.displayName ? { displayName: parsed.editable.displayName } : {}),
    runtime: { ...parsed.editable.runtime },
    ...(parsed.editable.role ? { prompt: { role: parsed.editable.role } } : {}),
    lifecycle: {
      // t-ca9086 / SDD 482 decision 9 (revised 2026-07-29): human-authorized create writes ENABLED.
      // "Saving is not starting" is enforced by absence of spawn/autostart — not by disabling the
      // profile. Approve-and-create and Agent Studio save both land here; import/clone stay disabled
      // on their own path (reauthorization).
      enabled: true,
      ...(parsed.editable.lifecycle.autostart ? { autostart: true } : {}),
      ...(parsed.editable.lifecycle.restart !== "never" ? { restart: parsed.editable.lifecycle.restart } : {}),
      ...(!parsed.editable.lifecycle.attention ? { attention: { enabled: false } } : {}),
      // t-bd14d8 — a newly created Agent never gets a `watch`; there is no editable field to read.
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
    ...(Object.keys(parsed.editable.nativeConfig ?? {}).length > 0 ? { nativeConfig: structuredClone(parsed.editable.nativeConfig) } : {}),
  };
}

export function patchProfileFromStudioMutation(
  mutation: AgentProfileStudioMutationV1,
  current: AgentProfileLifecycleSnapshot,
): Partial<Omit<AgentProfileV1, "schemaVersion" | "agentId">> {
  const parsed = agentProfileStudioMutationSchemaV1.parse(mutation);
  assertStudioNativeConfig(parsed.editable);
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
  };
  // t-bd14d8 — the spread above carries the STORED lifecycle forward, so a legacy `watch` would
  // survive every edit untouched and keep force-restarting the agent. Deleting it here is what makes
  // the strip land on disk: the first save through Agent Studio is the repair, exactly as the first
  // Terminal Studio save cleaned the four agent-only keys in t-b54ead.
  delete (lifecycle as { watch?: unknown }).watch;
  const worktree = {
    ...(current.profile.workspace?.worktree ?? {}),
    enabled: parsed.editable.worktree.enabled,
    branch: parsed.editable.worktree.branch || undefined,
  };
  // t-da80ed — an isolated agent's working directory IS its worktree. `AgentManager` already
  // overwrites the resolved cwd with the worktree path unconditionally, so accepting both here would
  // persist a field the runtime discards: the human types a path, saves without error, and nothing
  // happens. Refuse at WRITE only. The read path keeps tolerating the pair (worktree wins, as it
  // always has) because a refusal there would turn an existing profile that carries both into one
  // that cannot load, breaking the agent this is meant to protect.
  if (parsed.editable.cwd && parsed.editable.worktree.enabled) {
    throw new Error(
      "a working directory cannot be set for an agent that runs in its own git worktree — the worktree IS its working directory; clear one of the two",
    );
  }
  const workspace = {
    ...(current.profile.workspace ?? {}),
    cwd: parsed.editable.cwd || undefined,
    worktree,
  };
  const selected = parsed.editable.capabilities;
  if (selected === undefined) return {
    displayName: parsed.editable.displayName || undefined,
    runtime: { ...parsed.editable.runtime },
    prompt: Object.keys(prompt).length > 0 ? prompt : undefined,
    lifecycle, workspace, isolation: parsed.editable.isolation || undefined,
    nativeConfig: Object.keys(parsed.editable.nativeConfig ?? {}).length > 0 ? structuredClone(parsed.editable.nativeConfig) : undefined,
  };
  const references = new Map((current.profile.references ?? []).map((reference) => [reference.id, reference]));
  const granted = new Set(current.provenance.authority.capabilityReferenceIds ?? []);
  const families = [
    ["skills", selected.skills, "skill"],
    ["mcp", selected.mcp, "mcp"],
    ["hooks", selected.hooks, "hook"],
  ] as const;
  for (const [family, ids, expectedKind] of families) {
    if (new Set(ids).size !== ids.length) {
      throw new Error(`capability selection for '${family}' contains duplicate references`);
    }
    for (const id of ids) {
      if (references.get(id)?.kind !== expectedKind || !granted.has(id)) {
        throw new Error(`capability '${id}' is not a host-authorized ${expectedKind} reference for this profile`);
      }
    }
  }
  return {
    displayName: parsed.editable.displayName || undefined,
    runtime: { ...parsed.editable.runtime },
    prompt: Object.keys(prompt).length > 0 ? prompt : undefined,
    lifecycle,
    workspace,
    isolation: parsed.editable.isolation || undefined,
    nativeConfig: Object.keys(parsed.editable.nativeConfig ?? {}).length > 0
      ? structuredClone(parsed.editable.nativeConfig)
      : undefined,
    capabilities: {
      skills: [...selected.skills],
      mcp: [...selected.mcp],
      hooks: [...selected.hooks],
      ...(current.profile.capabilities?.pi ? { pi: structuredClone(current.profile.capabilities.pi) } : {}),
    },
  };
}

/**
 * t-4c113c — the roster facts a declared-ownership edit is validated against.
 *
 * Deliberately a plain, node-free projection of the loaded roster rather than the roster itself:
 * the validation below is shared by the browser bundle (to grey out impossible targets) and by the
 * host (where it is the authority), and only the host can touch `loadConfig`. Terminals are present
 * WITH `kind: "terminal"` instead of being filtered out, because "that name is a terminal" and "that
 * name does not exist" are different refusals and spec 352 requires both.
 */
export interface AgentOwnershipRosterEntryV1 {
  name: string;
  kind: "agent" | "terminal";
  /** The entry's own declared subagents, as the roster currently reports them. */
  subagents: readonly string[];
}

export type AgentOwnershipRosterV1 = readonly AgentOwnershipRosterEntryV1[];

export const agentOwnershipViewSchemaV1 = z.object({
  /** What this agent declares today. */
  subagents: z.array(z.string().regex(ID)).max(AGENT_OWNERSHIP_MAX_SUBAGENTS),
  /** Names it could additionally declare without violating the spec 352 contract. */
  candidates: z.array(z.string().regex(ID)).max(1024),
  /** Set when this agent is itself someone's declared subagent — it may then own nothing. */
  ownedBy: z.string().regex(ID).optional(),
}).strict();

export type AgentOwnershipViewV1 = z.infer<typeof agentOwnershipViewSchemaV1>;

function ownerOf(child: string, roster: AgentOwnershipRosterV1, exclude?: string): string | undefined {
  return roster.find((entry) =>
    entry.kind === "agent" && entry.name !== exclude && entry.subagents.includes(child))?.name;
}

/**
 * Read-side projection for the Agent Form. Candidacy answers exactly the questions
 * `ownershipPatchFromStudioMutation` refuses on, so the UI cannot offer a target the transaction
 * would then reject.
 */
export function agentOwnershipView(owner: string, roster: AgentOwnershipRosterV1): AgentOwnershipViewV1 {
  const self = roster.find((entry) => entry.name === owner);
  const subagents = [...(self?.kind === "agent" ? self.subagents : [])].sort();
  const ownedBy = ownerOf(owner, roster, owner);
  if (ownedBy !== undefined || self?.kind !== "agent") return { subagents, candidates: [], ...(ownedBy !== undefined ? { ownedBy } : {}) };
  const candidates = roster
    .filter((entry) => entry.kind === "agent"
      && entry.name !== owner
      && entry.subagents.length === 0
      && ownerOf(entry.name, roster, owner) === undefined)
    .map((entry) => entry.name)
    .sort()
    // Bounded to the wire schema's cap so an implausibly large roster degrades to a shorter picker
    // rather than to a snapshot the editor side refuses to decode.
    .slice(0, 1024);
  return { subagents, candidates };
}

/**
 * The CHILD-side half of the spec 352 ownership contract, shared by every path that may declare
 * subagents.
 *
 * Extracted for SDD 482 phase 4C (`t-5e1113`): a Saved Agent PROPOSAL can request ownership, and it
 * has to be refused by the same rules for the same reasons — with the same wording, so a proposer and
 * a Studio user learn the identical fact. Re-implementing these checks beside the original is exactly
 * the drift this project keeps paying for; there is one rule and two callers.
 *
 * The OWNER-side checks (revision conflict, owner already owned, direct cycle) stay in
 * `ownershipPatchFromStudioMutation`: they ask about an agent that already exists, which a proposal's
 * subject does not.
 */
export function assertOwnershipTargets(
  owner: string,
  subagents: readonly string[],
  roster: AgentOwnershipRosterV1,
): void {
  const byName = new Map(roster.map((entry) => [entry.name, entry]));
  for (const child of subagents) {
    if (child === owner) throw new Error(`ownership target '${child}' cannot reference itself`);
    const entry = byName.get(child);
    if (!entry) throw new Error(`ownership target '${child}' is not declared in agents/terminals`);
    if (entry.kind !== "agent") {
      throw new Error(`ownership target '${child}' resolves to a terminal; subagents must reference agents`);
    }
    const otherOwner = ownerOf(child, roster, owner);
    if (otherOwner !== undefined) {
      throw new Error(`ownership target '${child}' is already declared as a subagent of '${otherOwner}'`);
    }
    if (entry.subagents.length > 0) {
      throw new Error(`ownership target '${child}' declares its own subagents; nested subagent trees are not supported`);
    }
  }
}

/**
 * t-3bde32 — turn a `set-propose-saved-agent-grant` mutation into the canonical patch, or refuse.
 *
 * REVOKING WRITES `grants: {}`, not `proposeSavedAgent: false`. The whole feature reads absence as
 * refusal (`readAgentProfileGrants` returns `{}` and every door tests `=== true`), so removing the key
 * leaves the profile in the same shape it had before anyone granted anything. Writing an explicit
 * `false` would work identically today and would quietly become a second way to say "no" — one that a
 * future reader has to check for alongside absence. One representation of refusal, not two.
 *
 * The patch replaces `grants` wholesale because the lifecycle's edit merge is shallow; that is safe
 * while `proposeSavedAgent` is the only member, and the moment a second grant exists this function is
 * where it must be merged rather than clobbered. Stated here because the bug would be silent.
 */
export function proposeSavedAgentGrantPatchFromStudioMutation(
  mutation: Extract<AgentProfileStudioLifecycleMutationV1, { operation: "set-propose-saved-agent-grant" }>,
  current: AgentProfileLifecycleSnapshot,
): { grants: AgentProfileV1["grants"] } {
  if (mutation.agentName !== current.agentName || mutation.expectedRevision !== current.revision) {
    throw new AgentProfileRefusal("agent-profile/revision-conflict", `agent '${mutation.agentName}' profile revision conflict`);
  }
  const others = { ...(current.profile.grants ?? {}) };
  delete others.proposeSavedAgent;
  return { grants: mutation.granted ? { ...others, proposeSavedAgent: true } : others };
}

/**
 * t-4c113c — turn a `set-subagents` mutation into the canonical patch, or refuse.
 *
 * Every refusal here mirrors a loadConfig rule (`buildDeclaredOwner`), and that is the point: the
 * config loader is fail-closed, so a declaration that violates the contract would either be dropped
 * or would fail the reload that the lifecycle transaction activates — rolling the edit back with an
 * opaque message. Refusing up front turns the same rule into an actionable one. loadConfig remains
 * the authority; this is the earlier, better-worded gate in front of it.
 */
export function ownershipPatchFromStudioMutation(
  mutation: Extract<AgentProfileStudioLifecycleMutationV1, { operation: "set-subagents" }>,
  current: AgentProfileLifecycleSnapshot,
  roster: AgentOwnershipRosterV1,
): { ownership: AgentProfileV1["ownership"] } {
  const owner = mutation.agentName;
  if (owner !== current.agentName || mutation.expectedRevision !== current.revision) {
    throw new AgentProfileRefusal("agent-profile/revision-conflict", `agent '${owner}' profile revision conflict`);
  }
  const byName = new Map(roster.map((entry) => [entry.name, entry]));
  if (byName.get(owner)?.kind !== "agent") {
    throw new Error(`agent '${owner}' is not a declared agent; ownership can only be declared by agents`);
  }
  const seen = new Set<string>();
  for (const child of mutation.subagents) {
    if (seen.has(child)) throw new Error(`ownership target '${child}' is listed twice`);
    seen.add(child);
  }
  if (mutation.subagents.length > 0) {
    const ownedBy = ownerOf(owner, roster, owner);
    // A direct cycle IS this condition seen from the other end: if a requested target already lists
    // the owner, that target is the owner's owner. Naming it here rather than in the per-target loop
    // keeps one refusal per fact instead of two branches racing for the same state.
    if (ownedBy !== undefined && mutation.subagents.includes(ownedBy)) {
      throw new Error(`ownership target '${ownedBy}' creates a direct ownership cycle with '${owner}'`);
    }
    if (ownedBy !== undefined) {
      throw new Error(`agent '${owner}' is already declared as a subagent of '${ownedBy}'; nested subagent trees are not supported`);
    }
  }
  assertOwnershipTargets(owner, mutation.subagents, roster);
  // The key is always present so the spread in `targetProfile` CLEARS ownership on an empty list;
  // an absent key would silently preserve the previous declaration instead of removing it.
  return { ownership: mutation.subagents.length > 0 ? { subagents: [...mutation.subagents] } : undefined };
}

export function isAgentProfileStudioSnapshotV1(value: unknown): value is AgentProfileStudioSnapshotV1 {
  return agentProfileStudioSnapshotSchemaV1.safeParse(value).success;
}
