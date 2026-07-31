/**
 * t-5498a6 — the door that turns a workspace skill into a capability this agent is ALLOWED to select.
 *
 * ## Why this file has to exist
 *
 * The profile model already had three separate steps, and only two had doors:
 *
 *   1. AUTHORIZE — `authority.capabilityGrants` + `profile.references`. No door. Nobody could open it:
 *      the Studio refuses by design ("Studio cannot author a new reference"), and an agent has never
 *      been able to reach it.
 *   2. SELECT — `capabilities.skills`, which the Studio validates against what was authorized and
 *      rejects with "is not a host-authorized skill reference for this profile".
 *   3. DELIVER — materialization into the session.
 *
 * So every profile in this workspace grants zero skills, and that is not a choice anybody made — it is
 * the only reachable state. This module is step 1.
 *
 * ## What it deliberately does NOT do
 *
 * Authorizing is not selecting. This adds a capability to the set the profile MAY choose from; it never
 * writes `capabilities.skills`. Collapsing the two would mean a human who authorizes a skill silently
 * hands it to the agent, and the whole point of the split is that "may have" and "has" are different
 * facts, decided at different moments by the same person.
 *
 * ## Who may call it
 *
 * The host, on behalf of a human. An agent's `propose_saved_agent(skills: […])` records a REQUEST — it
 * surfaces as `requestedSkills` on the review screen and grants nothing. That asymmetry is the
 * governance model, and nothing here may be wired to an agent-reachable path.
 */

import path from "node:path";

/** The grant record's adapter enum — the runtimes that can hold a capability grant at all. */
export type SkillGrantAdapter = "claude" | "codex" | "pi";

const GRANT_ADAPTERS: readonly string[] = ["claude", "codex", "pi"];

/** Reference ids are stable, human-readable handles; same shape the profile schema enforces. */
const REFERENCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface WorkspaceSkillSource {
  /** Workspace-relative POSIX path of the skill DIRECTORY, e.g. `.claude/skills/visual-qa`. */
  path: string;
  /** Digest of the captured skill tree, computed by the caller that read it. */
  sha256: string;
  /**
   * Provenance, carried verbatim onto the reference. Stated by the caller rather than invented here:
   * a skill installed by a plugin and one written by hand have different owners, and guessing would
   * put a wrong provenance on a record whose whole job is to say where something came from.
   */
  owner: string;
}

export interface SkillAuthorizationRequest {
  adapter: string;
  skill: WorkspaceSkillSource;
  /** Defaults to the skill directory's own name. */
  referenceId?: string;
}

/** A pinned, project-scope reference — the shape `profile.references` stores. */
export interface AuthorizedSkillReference {
  id: string;
  kind: "skill";
  scope: "project";
  owner: string;
  path: string;
  mode: "pinned";
  sha256: string;
}

/** The matching row in `authority.capabilityGrants`. */
export interface AuthorizedSkillGrant {
  referenceId: string;
  sourceSha256: string;
  adapter: SkillGrantAdapter;
  kind: "skill";
}

export type SkillAuthorizationOutcome =
  /** Newly authorized: both records added. */
  | "authorized"
  /** Already authorized at this exact digest — nothing written. */
  | "unchanged"
  /** Already authorized at a DIFFERENT digest; the caller must decide (see `reauthorize`). */
  | "digest-changed"
  /** Re-pinned to the new digest because the caller explicitly accepted it. */
  | "reauthorized";

export interface SkillAuthorizationState {
  references: readonly AuthorizedSkillReference[];
  grants: readonly AuthorizedSkillGrant[];
}

export type SkillAuthorizationResult =
  | { ok: true; outcome: SkillAuthorizationOutcome; referenceId: string; state: SkillAuthorizationState }
  | { ok: false; error: string };

/**
 * A skill directory's name is the reference id. Derived rather than asked for, because two humans
 * authorizing the same skill must produce the SAME id — otherwise the same capability accumulates
 * duplicate grants under different handles and the "already authorized" check silently stops working.
 */
export function skillReferenceIdFor(skillPath: string): string {
  return path.posix.basename(skillPath.replace(/\/+$/, ""));
}

function invalidPath(relative: string): string | undefined {
  if (!relative || relative.trim() !== relative) return "skill path must be a non-empty trimmed relative path";
  if (path.posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return "skill path must be workspace-relative";
  if (relative.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
    return "skill path must not contain '.', '..' or empty segments";
  }
  if (relative.startsWith("~")) return "skill path must not start with '~'";
  return undefined;
}

/**
 * Authorize one workspace skill for one profile.
 *
 * Pure: the caller reads the tree, computes the digest and persists the result. Keeping the fs out is
 * what lets every rule below be tested against a state literal instead of a temp directory.
 *
 * `reauthorize` is the switch for the case that must never be silent. A skill whose content changed is
 * not the skill that was approved — the pin exists precisely so that "visual-qa" cannot quietly become
 * something else between the approval and the run. So a digest change reports `digest-changed` and
 * writes nothing until a human says yes again.
 */
export function authorizeWorkspaceSkill(
  state: SkillAuthorizationState,
  request: SkillAuthorizationRequest,
  options: { reauthorize?: boolean } = {},
): SkillAuthorizationResult {
  const { adapter, skill } = request;

  // Grok is absent from the grant enum, so it cannot hold a capability grant at all. Say that in the
  // operator's terms instead of letting a schema rejection surface later as an opaque validation error
  // — an unsupported runtime must refuse LOUDLY, never accept and deliver nothing.
  if (!GRANT_ADAPTERS.includes(adapter)) {
    return { ok: false, error: `runtime '${adapter}' cannot hold a skill grant yet — no capability grant record exists for it` };
  }

  const pathError = invalidPath(skill.path);
  if (pathError) return { ok: false, error: pathError };
  if (!/^[a-f0-9]{64}$/.test(skill.sha256)) {
    return { ok: false, error: "skill digest must be a lowercase SHA-256" };
  }
  if (!skill.owner.trim() || skill.owner.length > 256) {
    return { ok: false, error: "skill owner must be non-empty and at most 256 characters" };
  }

  const referenceId = request.referenceId ?? skillReferenceIdFor(skill.path);
  if (!REFERENCE_ID_RE.test(referenceId)) {
    return { ok: false, error: `'${referenceId}' is not a usable reference id` };
  }

  const existingReference = state.references.find((reference) => reference.id === referenceId);
  const existingGrant = state.grants.find((grant) => grant.referenceId === referenceId);

  if (existingReference && existingReference.path !== skill.path) {
    // Same handle, different source. Overwriting would move a grant the human already approved onto
    // content they never saw, which is the one thing a pinned reference exists to prevent.
    return {
      ok: false,
      error: `reference '${referenceId}' already points at '${existingReference.path}' — authorize the new source under a different id`,
    };
  }
  if (existingGrant && existingGrant.adapter !== adapter) {
    return {
      ok: false,
      error: `reference '${referenceId}' is already granted for '${existingGrant.adapter}', not '${adapter}'`,
    };
  }

  const alreadyAtThisDigest = existingReference?.sha256 === skill.sha256 && existingGrant?.sourceSha256 === skill.sha256;
  if (existingReference && existingGrant && alreadyAtThisDigest) {
    return { ok: true, outcome: "unchanged", referenceId, state };
  }
  if ((existingReference || existingGrant) && !options.reauthorize) {
    return { ok: true, outcome: "digest-changed", referenceId, state };
  }

  const reference: AuthorizedSkillReference = {
    id: referenceId,
    kind: "skill",
    scope: "project",
    owner: skill.owner,
    path: skill.path,
    mode: "pinned",
    sha256: skill.sha256,
  };
  const grant: AuthorizedSkillGrant = {
    referenceId,
    sourceSha256: skill.sha256,
    adapter: adapter as SkillGrantAdapter,
    kind: "skill",
  };

  return {
    ok: true,
    outcome: existingReference || existingGrant ? "reauthorized" : "authorized",
    referenceId,
    state: {
      references: [...state.references.filter((entry) => entry.id !== referenceId), reference]
        .sort((a, b) => a.id.localeCompare(b.id)),
      grants: [...state.grants.filter((entry) => entry.referenceId !== referenceId), grant]
        .sort((a, b) => a.referenceId.localeCompare(b.referenceId)),
    },
  };
}

/**
 * Withdraw an authorization.
 *
 * Returns the ids the caller must ALSO drop from `capabilities.skills`, rather than dropping them
 * here. Revoking a grant while the profile still selects it would leave the profile in a state the
 * Studio itself rejects ("not a host-authorized skill reference"), so the selection has to move in the
 * same transaction — and naming that here beats a caller discovering it from a validation failure.
 */
export function revokeWorkspaceSkill(
  state: SkillAuthorizationState,
  referenceId: string,
  selected: readonly string[] = [],
): { state: SkillAuthorizationState; removed: boolean; alsoDeselect: string[] } {
  const removed = state.references.some((reference) => reference.id === referenceId)
    || state.grants.some((grant) => grant.referenceId === referenceId);
  return {
    removed,
    state: {
      references: state.references.filter((reference) => reference.id !== referenceId),
      grants: state.grants.filter((grant) => grant.referenceId !== referenceId),
    },
    alsoDeselect: selected.includes(referenceId) ? [referenceId] : [],
  };
}
