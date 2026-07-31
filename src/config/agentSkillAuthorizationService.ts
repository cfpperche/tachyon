/**
 * t-5498a6 — the ONE function that authorizes a skill, and the fs half of the door.
 *
 * `agentSkillAuthorization.ts` holds the rules and stays pure. This reads the tree, computes the
 * digest, and persists the reference and the grant in a single canonical transaction.
 *
 * ## Why one function with two callers
 *
 * A human authorizes a skill at two moments: approving a Saved Agent proposal, and editing an agent
 * that already exists. Those are two doors into the same decision, and t-b4a799 is the standing
 * lesson about what happens when behaviour is copied into each path instead of living where they
 * converge — the two drift, and the one that gets exercised less is the one that is wrong. So the
 * rules live here once and both callers pass through.
 *
 * The second caller is also the one that matters today: `claude`, `claude-validador` and `codex`
 * never went through a proposal, so nothing else would ever unblock them.
 *
 * ## Why reference and grant move together
 *
 * They are one fact — "this profile may select this exact content". Persisting them separately would
 * let a crash leave a grant pointing at no reference, or a reference the authority never blessed, and
 * `requireGrant` would then refuse at delivery with a diagnostic about a state nobody chose.
 */

import fs from "node:fs";
import path from "node:path";
import { AgentCapabilitySourceError, inspectCapabilitySourceAtRoot } from "./agentCapabilitySource.js";
import { listAuthorizableCapabilities, readPluginLock } from "./agentCapabilityCandidates.js";
import {
  authorizeWorkspaceSkill,
  revokeWorkspaceSkill,
  type SkillAuthorizationOutcome,
  type SkillAuthorizationState,
  type SkillOrigin,
} from "./agentSkillAuthorization.js";
import type { AgentProfileReferenceV1, AgentProfileV1 } from "./agentProfileSchema.js";
import type { AgentProfileAuthorityRecord } from "./agentProfileAuthority.js";

type PersistedGrant = NonNullable<AgentProfileAuthorityRecord["capabilityGrants"]>[number];

/** What the caller must provide to reach the canonical transaction, injected so this stays testable. */
export interface SkillAuthorizationPorts {
  /** The profile as it stands, plus the grants the authority currently holds. */
  read(agentName: string): Promise<{ profile: AgentProfileV1; grants: readonly PersistedGrant[] } | undefined>;
  /**
   * Commit the profile patch and the grant set in ONE transaction. A single port because it is a
   * single transaction: two would invite a caller to perform half of it.
   */
  commit(input: {
    agentName: string;
    references: readonly AgentProfileReferenceV1[];
    capabilityGrants: readonly PersistedGrant[];
    selectedSkills?: readonly string[];
  }): Promise<void>;
}

export interface AuthorizeAgentSkillInput {
  workspaceRoot: string;
  agentName: string;
  origin: SkillOrigin;
  ports: SkillAuthorizationPorts;
  /** Accept a content change on a skill that was already authorized. Never implied. */
  reauthorize?: boolean;
  /**
   * Select the skill in the same transaction. The proposal-approval caller passes true, because there
   * the human ticked a box that means "give this agent the skill"; the Studio caller leaves it false,
   * because there authorizing and selecting are two separate gestures on two separate controls.
   */
  select?: boolean;
}

export type AuthorizeAgentSkillResult =
  | { ok: true; outcome: SkillAuthorizationOutcome; referenceId: string; sha256: string; selected: boolean }
  | { ok: false; error: string };

/** Where an origin's tree physically lives, and under which custody root it is captured. */
function custodyOf(workspaceRoot: string, origin: SkillOrigin): { root: string; relative: string } | { error: string } {
  if (origin.kind === "plugin") {
    return { root: workspaceRoot, relative: `.tachyon/plugins/${origin.plugin}/skills/${origin.skill}` };
  }
  if (origin.kind === "workspace") {
    return { root: workspaceRoot, relative: origin.path };
  }
  // A skill in the user's runtime home is outside every root Tachyon custodies, so authorizing it
  // means COPYING the tree into the profile directory and pinning the copy. The canonical transaction
  // publishes bounded text artifacts, not trees, so there is nowhere to put it today. Refuse with the
  // missing mechanism named — accepting and pinning a path that will never hold content would produce
  // a grant that fails at delivery, far from the decision that caused it.
  return {
    error:
      `a skill from the ${origin.runtime} home ('${origin.name}') must be copied into the profile directory to be pinned, `
      + "and the canonical transaction can publish only bounded text artifacts — tree placement does not exist yet",
  };
}

/**
 * Authorize one skill for one agent. Idempotent: authorizing the same content twice is `unchanged`
 * and writes nothing.
 */
export async function authorizeAgentSkill(input: AuthorizeAgentSkillInput): Promise<AuthorizeAgentSkillResult> {
  const current = await input.ports.read(input.agentName);
  if (!current) return { ok: false, error: `agent '${input.agentName}' has no canonical profile to authorize against` };

  const custody = custodyOf(input.workspaceRoot, input.origin);
  if ("error" in custody) return { ok: false, error: custody.error };

  let sha256: string;
  try {
    // Captured with the SAME reader the resolver uses at delivery. Digesting the tree any other way
    // would produce a grant that never matches, and the failure would surface as an unexplained
    // capability refusal rather than as a mistake here.
    sha256 = inspectCapabilitySourceAtRoot(custody.root, custody.relative).sha256;
  } catch (error) {
    if (error instanceof AgentCapabilitySourceError) return { ok: false, error: error.message };
    return { ok: false, error: `cannot read '${custody.relative}': ${error instanceof Error ? error.message : String(error)}` };
  }

  const state: SkillAuthorizationState = {
    references: (current.profile.references ?? []).filter(isAuthorizedSkillShape),
    grants: current.grants.filter((grant): grant is PersistedGrant & { kind: "skill" } => grant.kind === "skill")
      .map((grant) => ({ referenceId: grant.referenceId, sourceSha256: grant.sourceSha256, adapter: grant.adapter as "claude" | "codex" | "pi", kind: "skill" })),
  };

  const decided = authorizeWorkspaceSkill(
    state,
    {
      adapter: current.profile.runtime.adapter,
      origin: input.origin,
      sha256,
      agentId: current.profile.agentId,
    },
    { reauthorize: input.reauthorize },
  );
  if (!decided.ok) return { ok: false, error: decided.error };
  if (decided.outcome === "unchanged" && !input.select) {
    return { ok: true, outcome: "unchanged", referenceId: decided.referenceId, sha256, selected: false };
  }
  if (decided.outcome === "digest-changed") {
    return {
      ok: true,
      outcome: "digest-changed",
      referenceId: decided.referenceId,
      sha256,
      selected: (current.profile.capabilities?.skills ?? []).includes(decided.referenceId),
    };
  }

  const selectedSkills = input.select
    ? [...new Set([...(current.profile.capabilities?.skills ?? []), decided.referenceId])].sort()
    : undefined;

  await input.ports.commit({
    agentName: input.agentName,
    references: mergeReferences(current.profile.references ?? [], decided.state.references),
    capabilityGrants: mergeGrants(current.grants, decided.state.grants),
    ...(selectedSkills ? { selectedSkills } : {}),
  });

  return { ok: true, outcome: decided.outcome, referenceId: decided.referenceId, sha256, selected: input.select === true };
}

/**
 * Withdraw an authorization, taking the selection with it.
 *
 * Deselecting in the same transaction is not a convenience: a revoked grant while
 * `capabilities.skills` still names it produces a profile the Studio itself rejects, so leaving them
 * to separate writes would mean a crash between the two bricks the profile.
 */
export async function revokeAgentSkill(input: {
  agentName: string;
  referenceId: string;
  ports: SkillAuthorizationPorts;
}): Promise<{ ok: true; removed: boolean; deselected: boolean } | { ok: false; error: string }> {
  const current = await input.ports.read(input.agentName);
  if (!current) return { ok: false, error: `agent '${input.agentName}' has no canonical profile` };

  const selected = current.profile.capabilities?.skills ?? [];
  const state: SkillAuthorizationState = {
    references: (current.profile.references ?? []).filter(isAuthorizedSkillShape),
    grants: current.grants.filter((grant) => grant.kind === "skill")
      .map((grant) => ({ referenceId: grant.referenceId, sourceSha256: grant.sourceSha256, adapter: grant.adapter as "claude" | "codex" | "pi", kind: "skill" as const })),
  };
  const revoked = revokeWorkspaceSkill(state, input.referenceId, selected);
  if (!revoked.removed) return { ok: true, removed: false, deselected: false };

  await input.ports.commit({
    agentName: input.agentName,
    references: (current.profile.references ?? []).filter((reference) => reference.id !== input.referenceId),
    capabilityGrants: current.grants.filter((grant) => grant.referenceId !== input.referenceId),
    ...(revoked.alsoDeselect.length > 0 ? { selectedSkills: selected.filter((id) => id !== input.referenceId) } : {}),
  });

  return { ok: true, removed: true, deselected: revoked.alsoDeselect.length > 0 };
}

function isAuthorizedSkillShape(reference: AgentProfileReferenceV1): reference is AgentProfileReferenceV1 & {
  kind: "skill"; scope: "project" | "profile"; mode: "pinned"; sha256: string;
} {
  return reference.kind === "skill" && reference.mode === "pinned" && typeof reference.sha256 === "string"
    && (reference.scope === "project" || reference.scope === "profile");
}

/**
 * Rewrite only the skill references, leaving every other reference exactly where it was. Replacing
 * the whole list with what the pure core returned would silently drop mcp, hook and prompt
 * references it never saw.
 */
function mergeReferences(
  existing: readonly AgentProfileReferenceV1[],
  skills: readonly { id: string; kind: "skill"; scope: "project" | "profile"; owner: string; path: string; mode: "pinned"; sha256: string; version?: string }[],
): AgentProfileReferenceV1[] {
  const byId = new Map(skills.map((skill) => [skill.id, skill as AgentProfileReferenceV1]));
  const kept = existing.filter((reference) => !(isAuthorizedSkillShape(reference) && byId.has(reference.id)));
  return [...kept, ...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Same rule for grants: a skill grant set must not disturb an mcp or hook grant it never inspected. */
function mergeGrants(
  existing: readonly PersistedGrant[],
  skills: readonly { referenceId: string; sourceSha256: string; adapter: string; kind: "skill" }[],
): PersistedGrant[] {
  const byId = new Map(skills.map((grant) => [grant.referenceId, grant as PersistedGrant]));
  const kept = existing.filter((grant) => !(grant.kind === "skill" && byId.has(grant.referenceId)));
  return [...kept, ...byId.values()].sort((left, right) => left.referenceId.localeCompare(right.referenceId));
}

/** Resolve a skill NAME to its origin by consulting the plugin lockfile, which is the only honest
 * discriminator: a plugin skill edited by hand diverges in content and is still the plugin's. */
export function skillOriginFor(workspaceRoot: string, skillName: string, adapter: string): SkillOrigin | undefined {
  const lock = readPluginLock(workspaceRoot);
  for (const plugin of lock) {
    const owns = plugin.targets.some((target) => target.kind === "skill-dir" && path.posix.basename(target.file) === skillName);
    if (!owns) continue;
    return { kind: "plugin", plugin: plugin.name, skill: skillName, version: plugin.version, runtimes: plugin.runtimes };
  }
  const rel = adapter === "codex" ? `.agents/skills/${skillName}` : `.claude/skills/${skillName}`;
  return fs.existsSync(path.join(workspaceRoot, rel)) ? { kind: "workspace", path: rel } : undefined;
}

/**
 * t-5498a6 — authorize a whole plugin: everything it exposes for this agent's runtime.
 *
 * Ratified with the user. The unit of choice for plugin-sourced capability is the PLUGIN, not one
 * skill inside it — "inject this plugin" is the gesture, and the grants underneath stay per skill
 * because that is what the schema carries. No new grant semantics, one decision.
 *
 * The consequence is the refusal. A plugin exposing something no capability grant can carry —
 * `settings-hook`, `view` — is refused WHOLE. Authorizing its skills and quietly dropping the rest
 * would report success while half the plugin never reached the agent, which is exactly the
 * expressible-for-some/inert-for-others failure this slice exists to end.
 *
 * All-or-nothing on write too: if the second skill of a plugin fails, the first is left authorized
 * and the caller is told which landed. Nothing here can roll back a committed transaction, so it
 * reports the truth instead of implying atomicity it does not have.
 */
export async function authorizeAgentPlugin(input: {
  workspaceRoot: string;
  agentName: string;
  pluginName: string;
  adapter: string;
  ports: SkillAuthorizationPorts;
  reauthorize?: boolean;
  select?: boolean;
}): Promise<{ ok: true; authorized: string[]; outcomes: SkillAuthorizationOutcome[] } | { ok: false; error: string; authorized?: string[] }> {
  const candidate = listAuthorizableCapabilities(input.workspaceRoot, input.adapter)
    .plugins.find((plugin) => plugin.name === input.pluginName);
  if (!candidate) return { ok: false, error: `no plugin named '${input.pluginName}' is installed in this workspace` };
  if (!candidate.authorizable) {
    return { ok: false, error: `plugin '${candidate.name}@${candidate.version}' cannot be authorized for ${input.adapter}: ${candidate.reason}` };
  }

  const authorized: string[] = [];
  const outcomes: SkillAuthorizationOutcome[] = [];
  for (const skill of candidate.skills) {
    const result = await authorizeAgentSkill({
      workspaceRoot: input.workspaceRoot,
      agentName: input.agentName,
      origin: { kind: "plugin", plugin: candidate.name, skill, version: candidate.version, runtimes: candidate.runtimes },
      ports: input.ports,
      ...(input.reauthorize ? { reauthorize: true } : {}),
      ...(input.select ? { select: true } : {}),
    });
    if (!result.ok) return { ok: false, error: `plugin '${candidate.name}': ${result.error}`, authorized };
    authorized.push(skill);
    outcomes.push(result.outcome);
  }
  return { ok: true, authorized, outcomes };
}
