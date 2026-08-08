/**
 * SDD 494 Part 4 — the six disagreements between the owners of a Saved Agent's state, derived from
 * five presence facts and stored nowhere.
 *
 * `spec.md` names one owner per fact. This module answers the question that follows from that table:
 * when the owners disagree, WHICH disagreement is it, and which door removes the agent. Both answers
 * are computed from the facts on every read.
 *
 * Storing the state would be the defect the spec exists to remove. Four of the five facts live
 * outside Tachyon's own records — two paths on disk, a host secret, and a projection whose input is
 * `~/.claude/settings.json`, which any tool on the machine may rewrite. A stored verdict about them
 * ages the moment it is written, and the reader has no way to tell a fresh one from a stale one.
 *
 * The rule from `spec.md`, in one sentence: a fact that cannot be proven makes an agent UNRUNNABLE.
 * It never makes an agent NON-EXISTENT. Membership is therefore the roster row and nothing else, and
 * every state that keeps the roster row keeps a removal door.
 */

/**
 * The five presence facts, each read from the record that OWNS it.
 *
 * They are supplied together because the state is a statement about their disagreement; no single
 * fact carries it. A caller that can only measure four of them has not measured the state — which is
 * exactly how t-8b58b3 happened, one fact short and confident about it.
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
  /**
   * Residence. The directory `.tachyon/agents/<name>/` exists — whatever is or is not inside it.
   *
   * t-8b58b3 added this fact, and adding it is the whole fix. The sweep that feeds this table
   * ENUMERATES that directory to find its subjects and then measured only the FILE inside it, so a
   * name it had just listed came back with four false facts and derived to `absent` — "there is
   * nothing to remove", said about a directory the same function had just read. A vocabulary with no
   * word for "the home exists" cannot report a home that exists; that is upstream of any arm of the
   * derivation below, which was right about the facts it was given.
   *
   * `profileOnDisk` implies this fact — an `agent.yml` cannot exist without its parent. The reverse
   * does not hold, and the gap is exactly the residue: an interrupted create, a `forgetAgent` that
   * took `evolution/`, or a Soul import that wrote `SOUL.md` under a name with no roster row.
   */
  profileHomeOnDisk: boolean;
}

/**
 * `consistent` and `absent` are not disagreements; they complete the function so every combination of
 * the five facts has one named answer rather than falling through a default arm.
 */
export type SavedAgentState =
  | "consistent"
  | "orphan-locator"
  | "unlisted-profile"
  | "unattested"
  | "unprojectable"
  | "stranded-authority"
  | "orphan-home"
  | "absent";

export interface SavedAgentRemovalDoor {
  /**
   * The door that would remove this agent, or `null` when the product owns no door for this state.
   *
   * `null` is an answer, not a gap. Three of the six states hold no roster row, so there is no member
   * to remove; deleting their residue automatically would turn a display disagreement into data loss.
   * A `null` door therefore owes the reader more than the states that have one: its reason is the
   * whole answer, and it has to say what is there and how to deal with it by hand.
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
 *
 * Below the roster row the order is the DISK first, and that is the same safety property read from
 * the other end: among the states that hold no member, the one that names bytes on disk must win
 * over the one that names a record with no bytes. `unlisted-profile` already beat
 * `stranded-authority` for that reason, and `orphan-home` joins it on the same ground — a directory
 * may hold a human's Soul, an authority record holds nothing anyone can lose. The caller reads every
 * fact alongside the state, so nothing is hidden by the state that wins.
 */
/**
 * t-ae221c — what moving the roster into `.tachyon/agents/` did to the arms below.
 *
 * Membership is now "a readable `agent.yml` under `.tachyon/agents/<name>/`", which is the same
 * thing `profileOnDisk` measures. So `orphan-locator` — a roster row with no profile — has no
 * producer left in the product. Its arm stays because this function is TOTAL over five booleans and
 * a missing arm is a silent default, not because anything still reaches it.
 *
 * `unlisted-profile` survives through a narrower door: an `agent.yml` that is on disk and cannot be
 * READ is not a member, and its bytes are exactly what that state exists to protect.
 */
export function deriveSavedAgentState(facts: SavedAgentPresenceFacts): SavedAgentState {
  const { rosterRow, profileOnDisk, authorityRecord, projection, profileHomeOnDisk } = facts;
  if (!rosterRow) {
    // A profile with no roster row is not a member, whatever the authority says: the profile is the
    // record that may hold a human's work.
    if (profileOnDisk) return "unlisted-profile";
    // t-8b58b3 — a home with no definition in it. Was `absent` when the authority was missing too,
    // which reported "there is nothing to remove" about a directory the sweep had just enumerated.
    if (profileHomeOnDisk) return "orphan-home";
    return authorityRecord ? "stranded-authority" : "absent";
  }
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
          "no roster row, no profile and nothing left on disk, so there is no member to remove; what is left "
          + "is a host authority record, and no product door retires an authority whose agent is already gone",
      };
    /**
     * t-8b58b3 — the residue an interrupted create or an ungoverned delete leaves behind.
     *
     * No door, and for the same reason `unlisted-profile` has none: there is no member, and the
     * directory may hold bytes. The reason has to carry the human the rest of the way, so it names
     * the one command that tells the two cases apart by refusing — `rmdir` succeeds on residue and
     * fails on anything worth keeping, which is the same policy the removal helpers now use.
     */
    case "orphan-home":
      return {
        door: null,
        reason:
          "no roster row, no agent.yml and no authority, but .tachyon/agents/<name>/ is still on disk. There "
          + "is no member to remove, and Tachyon never deletes a profile directory automatically. Run "
          + "`rmdir .tachyon/agents/<name>/`: it succeeds when the directory is empty residue from an "
          + "interrupted create or forget, and refuses when it still holds Soul, Evolution or memory bytes — "
          + "read those before deleting them, or restore the roster row to adopt what is there",
      };
    case "absent":
      return { door: null, reason: "no roster row, no profile and no authority; there is nothing to remove" };
  }
}
