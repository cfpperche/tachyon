/**
 * SDD 494 Part 4 — the five disagreements between the owners of a Saved Agent's state, derived from
 * four presence facts and stored nowhere.
 *
 * `spec.md` names one owner per fact. This module answers the question that follows from that table:
 * when the owners disagree, WHICH disagreement is it, and which door removes the agent. Both answers
 * are computed from the facts on every read.
 *
 * Storing the state would be the defect the spec exists to remove. Three of the four facts live
 * outside Tachyon's own records — a directory on disk, a host secret, and a projection whose input is
 * `~/.claude/settings.json`, which any tool on the machine may rewrite. A stored verdict about them
 * ages the moment it is written, and the reader has no way to tell a fresh one from a stale one.
 *
 * The rule from `spec.md`, in one sentence: a fact that cannot be proven makes an agent UNRUNNABLE.
 * It never makes an agent NON-EXISTENT. Membership is therefore the roster row and nothing else, and
 * every state that keeps the roster row keeps a removal door.
 */

/**
 * The four presence facts, each read from the record that OWNS it.
 *
 * They are supplied together because the state is a statement about their disagreement; no single
 * fact carries it. A caller that can only measure three of them has not measured the state.
 */
export interface SavedAgentPresenceFacts {
  /** Membership. The roster row exists — today, a `tachyon.yml` pointer, read through `agentSources`. */
  rosterRow: boolean;
  /** Definition. `.tachyon/agents/<name>/agent.yml` is on disk. */
  profileOnDisk: boolean;
  /** Attestation. The host authority registry holds a record for this name. */
  authorityRecord: boolean;
  /** Runnability. The load projected this agent into a runnable definition. Derived, never stored. */
  projection: boolean;
}

/**
 * `consistent` and `absent` are not disagreements; they complete the function so every combination of
 * the four facts has one named answer rather than falling through a default arm.
 */
export type SavedAgentState =
  | "consistent"
  | "orphan-locator"
  | "unlisted-profile"
  | "unattested"
  | "unprojectable"
  | "stranded-authority"
  | "absent";

export interface SavedAgentRemovalDoor {
  /**
   * The door that would remove this agent, or `null` when the product owns no door for this state.
   *
   * `null` is an answer, not a gap. Two of the five states hold no roster row, so there is no member
   * to remove; deleting their residue automatically would turn a display disagreement into data loss.
   */
  door: string | null;
  /** Why that door removes it, or why no door does. */
  reason: string;
}

/**
 * The whole truth table, ordered so the PRESENCE facts decide before the projection does.
 *
 * That order is the safety property. `projection` is the one fact whose input Tachyon does not own,
 * so a projection that somehow succeeded while a presence fact was missing must not be allowed to
 * report the agent as consistent — the missing record still decides.
 */
export function deriveSavedAgentState(facts: SavedAgentPresenceFacts): SavedAgentState {
  const { rosterRow, profileOnDisk, authorityRecord, projection } = facts;
  if (!rosterRow && !profileOnDisk && !authorityRecord) return "absent";
  // A profile with no roster row is not a member, whatever the authority says. `unlisted-profile`
  // therefore wins over `stranded-authority`: the profile is the record that may hold a human's work.
  if (!rosterRow && profileOnDisk) return "unlisted-profile";
  if (!rosterRow) return "stranded-authority";
  if (!profileOnDisk) return "orphan-locator";
  if (!authorityRecord) return "unattested";
  return projection ? "consistent" : "unprojectable";
}

/** Membership, and only membership. Every disagreement below the roster row leaves it intact. */
export function isSavedAgentStateMember(facts: SavedAgentPresenceFacts): boolean {
  return facts.rosterRow;
}

/**
 * The line this whole part exists for: WHICH door removes this agent.
 *
 * Named for a human who opened a broken agent and does not know where to take it out. Knowing that
 * the records disagree helps nobody on its own — that was the measured cost of `claude23`, where the
 * answer took five sources and one of them was unreadable from outside the extension host.
 */
export function savedAgentRemovalDoor(state: SavedAgentState): SavedAgentRemovalDoor {
  switch (state) {
    case "consistent":
    case "orphan-locator":
    case "unattested":
    case "unprojectable":
      return {
        door: "Agent Studio -> Forget (Bridge: propose_saved_agent_removal)",
        reason:
          "the roster row exists, so the agent is a member and the governed forget transaction removes it; "
          + "removal reads membership and never runnability",
      };
    case "unlisted-profile":
      return {
        door: null,
        reason:
          "no roster row, so there is no member to remove; the profile directory is kept on purpose because "
          + "it may hold work a human wants, and Tachyon never deletes it automatically. Restore the roster row "
          + "to adopt the profile, or delete .tachyon/agents/<name>/ by hand",
      };
    case "stranded-authority":
      return {
        door: null,
        reason:
          "no roster row and no profile, so there is no member to remove; what is left is a host authority "
          + "record, and no product door retires an authority whose agent is already gone",
      };
    case "absent":
      return { door: null, reason: "no roster row, no profile and no authority; there is nothing to remove" };
  }
}
