/**
 * t-5498a6 — the door that turns a skill into a capability an agent is ALLOWED to select.
 *
 * ## Why this file has to exist
 *
 * The capability model already had three steps, and only one lacked a door:
 *
 *   1. AUTHORIZE — `authority.capabilityGrants` + `profile.references`. No door. Nobody could open it:
 *      the Studio refuses by design ("Studio cannot author a new reference"), and an agent has never
 *      been able to reach it.
 *   2. SELECT — `capabilities.skills`, validated by the Studio against what was authorized.
 *   3. DELIVER — already works. `agentProfileResolver` captures the payload at its pinned digest,
 *      `requireGrant` refuses anything without an exact host-custodied grant, and the harness writes
 *      the tree into the agent's PRIVATE runtime home (`<home>/skills`), not into the worktree.
 *
 * So every profile in this workspace grants zero skills, and that is not a choice anybody made — it is
 * the only reachable state. This module is step 1, and it is the last one missing.
 *
 * ## Three origins, because a workspace is not the only place a skill lives
 *
 * A skill reaches a workspace three ways, and they are NOT interchangeable — each carries a different
 * provenance and a different failure mode:
 *
 *   - `plugin` — installed by a Tachyon plugin. The plugin is the source of truth and the runtime
 *     directories (`.claude/skills/<x>`, `.agents/skills/<x>`) are byte-identical COPIES the installer
 *     wrote. Authorizing the copy would pin the digest of a derivative and describe a plugin upgrade as
 *     an unexplained content change, so the reference points at the plugin's own tree and carries its
 *     version.
 *   - `workspace` — written by hand in this repo. No version, no upstream; the content digest carries
 *     the whole provenance.
 *   - `runtime-home` — the user's global runtime directory (`~/.grok/skills/…`). It lives OUTSIDE any
 *     root Tachyon custodies, so it cannot be referenced in place: `scope: "project"` resolves against
 *     the workspace root and nothing resolves against a user home. It is authorized as `scope:
 *     "profile"`, which means the caller copies the tree into the agent's profile directory and this
 *     pins that copy. Freezing it is the point — a skill in your home can change without Tachyon ever
 *     seeing it, and the pin exists so an approved capability cannot become something else.
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
export type SkillGrantAdapter = "claude" | "codex" | "grok" | "pi";

const GRANT_ADAPTERS: readonly string[] = ["claude", "codex", "grok", "pi"];

/** Reference ids are stable, human-readable handles; same shape the profile schema enforces. */
const REFERENCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Where a skill comes from. The origin decides scope, path root and provenance — none are guessed. */
export type SkillOrigin =
  /** Installed by a Tachyon plugin; the plugin tree is the source, the runtime dirs are its copies. */
  | { kind: "plugin"; plugin: string; skill: string; version: string; runtimes: readonly string[] }
  /** Hand-written in this repo. Workspace-relative path to the skill DIRECTORY. */
  | { kind: "workspace"; path: string }
  /**
   * The user's global runtime directory. `profileRelativePath` is where the caller COPIED the tree
   * inside the agent's profile directory — this module pins that copy, never the user's home.
   */
  | { kind: "runtime-home"; runtime: string; name: string; profileRelativePath: string };

export interface SkillAuthorizationRequest {
  adapter: string;
  origin: SkillOrigin;
  /** Digest of the captured skill tree, computed by the caller that read it. */
  sha256: string;
  /**
   * The profile being authorized. Required for a `runtime-home` origin: the schema forces
   * `owner === agentId` on profile-scoped references, so a copied skill cannot claim any other owner.
   */
  agentId?: string;
  /** Defaults to the skill's own name. */
  referenceId?: string;
}

/** The shape `profile.references` stores. Always pinned — the schema requires it for `kind: "skill"`. */
export interface AuthorizedSkillReference {
  id: string;
  kind: "skill";
  /** `project` resolves against the workspace root; `profile` against the agent's profile directory. */
  scope: "project" | "profile";
  owner: string;
  path: string;
  mode: "pinned";
  sha256: string;
  /** Plugin origins only — the schema keeps it optional and `product` scope is the only one requiring it. */
  version?: string;
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

/** The skill's own name is its reference id, derived per origin. */
export function skillReferenceIdFor(origin: SkillOrigin): string {
  if (origin.kind === "plugin") return origin.skill;
  if (origin.kind === "runtime-home") return origin.name;
  return path.posix.basename(origin.path.replace(/\/+$/, ""));
}

function invalidPath(relative: string): string | undefined {
  if (!relative || relative.trim() !== relative) return "skill path must be a non-empty trimmed relative path";
  if (path.posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return "skill path must be relative to its custody root";
  if (relative.startsWith("~")) return "skill path must not start with '~'";
  if (relative.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
    return "skill path must not contain '.', '..' or empty segments";
  }
  return undefined;
}

/** Resolve an origin into the reference fields it determines. Provenance is derived, never asked for. */
function placeOrigin(
  origin: SkillOrigin,
  adapter: string,
  agentId: string | undefined,
): { scope: "project" | "profile"; owner: string; path: string; version?: string } | { error: string } {
  if (origin.kind === "plugin") {
    // The manifest states which runtimes the plugin installs for. Refusing here names the reason;
    // letting it through would authorize a capability the installer would never deliver for this agent.
    if (!origin.runtimes.includes(adapter)) {
      return { error: `plugin '${origin.plugin}@${origin.version}' does not declare runtime '${adapter}' — it installs for: ${origin.runtimes.join(", ") || "(none)"}` };
    }
    return {
      scope: "project",
      owner: `plugin:${origin.plugin}`,
      path: `.tachyon/plugins/${origin.plugin}/skills/${origin.skill}`,
      version: origin.version,
    };
  }
  if (origin.kind === "workspace") {
    return { scope: "project", owner: "workspace", path: origin.path };
  }
  // runtime-home: outside every custody root, so it is pinned as the copy the caller placed in the
  // profile directory. The schema forces owner === agentId there, which is why it is required.
  if (!agentId) {
    return { error: "a runtime-home skill is authorized as a profile-scoped copy, which requires the agentId that owns it" };
  }
  return { scope: "profile", owner: agentId, path: origin.profileRelativePath };
}

/**
 * Authorize one skill for one profile.
 *
 * Pure: the caller reads the tree, computes the digest, copies a runtime-home skill into the profile
 * directory, and persists the result. Keeping the fs out is what lets every rule below be tested
 * against a state literal instead of a temp directory.
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
  const { adapter, origin } = request;

  // Unsupported runtimes must refuse LOUDLY, never accept and deliver nothing.
  if (!GRANT_ADAPTERS.includes(adapter)) {
    return { ok: false, error: `runtime '${adapter}' cannot hold a skill grant yet — no capability grant record exists for it` };
  }
  if (!/^[a-f0-9]{64}$/.test(request.sha256)) {
    return { ok: false, error: "skill digest must be a lowercase SHA-256" };
  }

  const placed = placeOrigin(origin, adapter, request.agentId);
  if ("error" in placed) return { ok: false, error: placed.error };

  const pathError = invalidPath(placed.path);
  if (pathError) return { ok: false, error: pathError };

  const referenceId = request.referenceId ?? skillReferenceIdFor(origin);
  if (!REFERENCE_ID_RE.test(referenceId)) {
    return { ok: false, error: `'${referenceId}' is not a usable reference id` };
  }

  const existingReference = state.references.find((reference) => reference.id === referenceId);
  const existingGrant = state.grants.find((grant) => grant.referenceId === referenceId);

  if (existingReference && existingReference.path !== placed.path) {
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

  const alreadyPinnedHere = existingReference?.sha256 === request.sha256
    && existingGrant?.sourceSha256 === request.sha256
    && existingReference?.version === placed.version;
  if (existingReference && existingGrant && alreadyPinnedHere) {
    return { ok: true, outcome: "unchanged", referenceId, state };
  }
  if ((existingReference || existingGrant) && !options.reauthorize) {
    return { ok: true, outcome: "digest-changed", referenceId, state };
  }

  const reference: AuthorizedSkillReference = {
    id: referenceId,
    kind: "skill",
    scope: placed.scope,
    owner: placed.owner,
    path: placed.path,
    mode: "pinned",
    sha256: request.sha256,
    ...(placed.version ? { version: placed.version } : {}),
  };
  const grant: AuthorizedSkillGrant = {
    referenceId,
    sourceSha256: request.sha256,
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
 *
 * `removedCopy` tells the caller whether a profile-scoped tree it copied is now orphaned and must be
 * deleted with the record; nothing else would ever remove it.
 */
export function revokeWorkspaceSkill(
  state: SkillAuthorizationState,
  referenceId: string,
  selected: readonly string[] = [],
): { state: SkillAuthorizationState; removed: boolean; alsoDeselect: string[]; removedCopy?: string } {
  const reference = state.references.find((entry) => entry.id === referenceId);
  const removed = reference !== undefined || state.grants.some((grant) => grant.referenceId === referenceId);
  return {
    removed,
    state: {
      references: state.references.filter((entry) => entry.id !== referenceId),
      grants: state.grants.filter((grant) => grant.referenceId !== referenceId),
    },
    alsoDeselect: selected.includes(referenceId) ? [referenceId] : [],
    ...(reference?.scope === "profile" ? { removedCopy: reference.path } : {}),
  };
}
