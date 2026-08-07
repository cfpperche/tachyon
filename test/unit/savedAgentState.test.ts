import { describe, expect, it } from "vitest";
import {
  deriveSavedAgentState,
  isSavedAgentStateMember,
  savedAgentRemovalDoor,
  type SavedAgentPresenceFacts,
  type SavedAgentState,
} from "../../src/config/savedAgentState.js";

/**
 * SDD 494 Part 4 — the derivation is a total function over five booleans, so the test is the whole
 * truth table rather than the six rows the spec names.
 *
 * Thirty-two rows, written out. A table generated from the implementation would agree with any
 * implementation, including a wrong one; these expectations come from `spec.md`'s resolution table
 * and from the two ordering rules: a presence fact decides before the projection does, and below the
 * roster row the record that may hold bytes decides before the one that cannot.
 *
 * `profileHomeOnDisk` is t-8b58b3's fact. Eight of these rows are unreachable on a real filesystem —
 * an `agent.yml` cannot exist without its parent directory — and they are written anyway, with a
 * case below asserting that the impossible half never changes an answer.
 */
const TABLE: Array<{ facts: SavedAgentPresenceFacts; state: SavedAgentState; member: boolean }> = [
  // No roster row, no profile, no authority, no home — not a subject at all.
  { facts: { rosterRow: false, profileOnDisk: false, authorityRecord: false, projection: false, profileHomeOnDisk: false }, state: "absent", member: false },
  { facts: { rosterRow: false, profileOnDisk: false, authorityRecord: false, projection: true, profileHomeOnDisk: false }, state: "absent", member: false },
  // t-8b58b3 — the same three records missing, and a directory still on disk. This is the residue an
  // interrupted create or a `forgetAgent` leaves, and it used to answer "there is nothing to remove".
  { facts: { rosterRow: false, profileOnDisk: false, authorityRecord: false, projection: false, profileHomeOnDisk: true }, state: "orphan-home", member: false },
  { facts: { rosterRow: false, profileOnDisk: false, authorityRecord: false, projection: true, profileHomeOnDisk: true }, state: "orphan-home", member: false },
  // Authority only.
  { facts: { rosterRow: false, profileOnDisk: false, authorityRecord: true, projection: false, profileHomeOnDisk: false }, state: "stranded-authority", member: false },
  { facts: { rosterRow: false, profileOnDisk: false, authorityRecord: true, projection: true, profileHomeOnDisk: false }, state: "stranded-authority", member: false },
  // An authority AND a home. The home wins: it may hold bytes, the authority record cannot.
  { facts: { rosterRow: false, profileOnDisk: false, authorityRecord: true, projection: false, profileHomeOnDisk: true }, state: "orphan-home", member: false },
  { facts: { rosterRow: false, profileOnDisk: false, authorityRecord: true, projection: true, profileHomeOnDisk: true }, state: "orphan-home", member: false },
  // A profile with no roster row, attested or not. The definition outranks both records below it.
  { facts: { rosterRow: false, profileOnDisk: true, authorityRecord: false, projection: false, profileHomeOnDisk: true }, state: "unlisted-profile", member: false },
  { facts: { rosterRow: false, profileOnDisk: true, authorityRecord: false, projection: true, profileHomeOnDisk: true }, state: "unlisted-profile", member: false },
  { facts: { rosterRow: false, profileOnDisk: true, authorityRecord: true, projection: false, profileHomeOnDisk: true }, state: "unlisted-profile", member: false },
  { facts: { rosterRow: false, profileOnDisk: true, authorityRecord: true, projection: true, profileHomeOnDisk: true }, state: "unlisted-profile", member: false },
  { facts: { rosterRow: false, profileOnDisk: true, authorityRecord: false, projection: false, profileHomeOnDisk: false }, state: "unlisted-profile", member: false },
  { facts: { rosterRow: false, profileOnDisk: true, authorityRecord: false, projection: true, profileHomeOnDisk: false }, state: "unlisted-profile", member: false },
  { facts: { rosterRow: false, profileOnDisk: true, authorityRecord: true, projection: false, profileHomeOnDisk: false }, state: "unlisted-profile", member: false },
  { facts: { rosterRow: false, profileOnDisk: true, authorityRecord: true, projection: true, profileHomeOnDisk: false }, state: "unlisted-profile", member: false },
  // A roster row whose profile is gone. Neither the authority nor a leftover home changes the answer:
  // the row makes it a member, and a member always has a door.
  { facts: { rosterRow: true, profileOnDisk: false, authorityRecord: false, projection: false, profileHomeOnDisk: false }, state: "orphan-locator", member: true },
  { facts: { rosterRow: true, profileOnDisk: false, authorityRecord: false, projection: true, profileHomeOnDisk: false }, state: "orphan-locator", member: true },
  { facts: { rosterRow: true, profileOnDisk: false, authorityRecord: true, projection: false, profileHomeOnDisk: false }, state: "orphan-locator", member: true },
  { facts: { rosterRow: true, profileOnDisk: false, authorityRecord: true, projection: true, profileHomeOnDisk: false }, state: "orphan-locator", member: true },
  { facts: { rosterRow: true, profileOnDisk: false, authorityRecord: false, projection: false, profileHomeOnDisk: true }, state: "orphan-locator", member: true },
  { facts: { rosterRow: true, profileOnDisk: false, authorityRecord: false, projection: true, profileHomeOnDisk: true }, state: "orphan-locator", member: true },
  { facts: { rosterRow: true, profileOnDisk: false, authorityRecord: true, projection: false, profileHomeOnDisk: true }, state: "orphan-locator", member: true },
  { facts: { rosterRow: true, profileOnDisk: false, authorityRecord: true, projection: true, profileHomeOnDisk: true }, state: "orphan-locator", member: true },
  // Roster row and profile agree, no human approved these bytes.
  { facts: { rosterRow: true, profileOnDisk: true, authorityRecord: false, projection: false, profileHomeOnDisk: true }, state: "unattested", member: true },
  { facts: { rosterRow: true, profileOnDisk: true, authorityRecord: false, projection: true, profileHomeOnDisk: true }, state: "unattested", member: true },
  { facts: { rosterRow: true, profileOnDisk: true, authorityRecord: false, projection: false, profileHomeOnDisk: false }, state: "unattested", member: true },
  { facts: { rosterRow: true, profileOnDisk: true, authorityRecord: false, projection: true, profileHomeOnDisk: false }, state: "unattested", member: true },
  // All three records agree; only the projection separates the last two states.
  { facts: { rosterRow: true, profileOnDisk: true, authorityRecord: true, projection: false, profileHomeOnDisk: true }, state: "unprojectable", member: true },
  { facts: { rosterRow: true, profileOnDisk: true, authorityRecord: true, projection: true, profileHomeOnDisk: true }, state: "consistent", member: true },
  { facts: { rosterRow: true, profileOnDisk: true, authorityRecord: true, projection: false, profileHomeOnDisk: false }, state: "unprojectable", member: true },
  { facts: { rosterRow: true, profileOnDisk: true, authorityRecord: true, projection: true, profileHomeOnDisk: false }, state: "consistent", member: true },
];

const key = (facts: SavedAgentPresenceFacts) =>
  `${+facts.rosterRow}${+facts.profileOnDisk}${+facts.authorityRecord}${+facts.projection}${+facts.profileHomeOnDisk}`;

describe("SDD 494 Part 4 — the six states derived from five presence facts", () => {
  it("covers every combination of the five facts exactly once", () => {
    expect(new Set(TABLE.map(({ facts }) => key(facts))).size).toBe(32);
  });

  for (const { facts, state, member } of TABLE) {
    const label = `roster=${+facts.rosterRow} profile=${+facts.profileOnDisk} authority=${+facts.authorityRecord}`
      + ` projection=${+facts.projection} home=${+facts.profileHomeOnDisk}`;
    it(`derives ${state} for ${label}`, () => {
      expect(deriveSavedAgentState(facts)).toBe(state);
      expect(isSavedAgentStateMember(facts)).toBe(member);
    });
  }

  it("names all six disagreements of spec.md and nothing else", () => {
    const derived = new Set(TABLE.map(({ facts }) => deriveSavedAgentState(facts)));
    expect([...derived].sort()).toEqual([
      "absent",
      "consistent",
      "orphan-home",
      "orphan-locator",
      "stranded-authority",
      "unattested",
      "unlisted-profile",
      "unprojectable",
    ]);
  });

  /**
   * `profileOnDisk` implies `profileHomeOnDisk` on any filesystem, so eight rows of the table cannot
   * be measured. The function stays total over them, and this is the property that says so: an
   * impossible fact combination never buys a different answer than its possible twin. A caller that
   * somehow reports one has a broken measurement, not a new state.
   */
  it("never lets the impossible profile-without-a-home rows change the answer", () => {
    const byKey = new Map(TABLE.map(({ facts, state }) => [key(facts), state]));
    const impossible = TABLE.filter(({ facts }) => facts.profileOnDisk && !facts.profileHomeOnDisk);
    expect(impossible).toHaveLength(8);
    for (const { facts, state } of impossible) {
      expect(byKey.get(key({ ...facts, profileHomeOnDisk: true }))).toBe(state);
    }
  });

  /**
   * The rule from `spec.md`: a fact that cannot be proven makes an agent unrunnable, never
   * non-existent. Membership is the roster row, so a projection that fails must never withdraw it.
   */
  it("keeps membership on every state that holds a roster row", () => {
    for (const { facts, member } of TABLE) expect(member).toBe(facts.rosterRow);
  });

  /**
   * The line the whole part exists for. A member always has a door, whatever the disagreement is;
   * a non-member never has one, because there is no member to remove.
   */
  it("gives every member a removal door and every non-member a stated reason for having none", () => {
    for (const { state, member } of TABLE) {
      const removal = savedAgentRemovalDoor(state);
      expect(removal.reason.length).toBeGreaterThan(0);
      if (member) {
        expect(removal.door).toBe("Agent Studio -> Forget (Bridge: propose_saved_agent_removal)");
      } else {
        expect(removal.door).toBeNull();
      }
    }
  });

  /**
   * `unlisted-profile` and `stranded-authority` do not auto-delete, and the reason is stated where a
   * reader lands: an automatic delete on a disagreement turns a display bug into data loss.
   */
  it("says the profile of an unlisted-profile is kept on purpose", () => {
    expect(savedAgentRemovalDoor("unlisted-profile").reason).toContain("never deletes it automatically");
  });

  /**
   * t-8b58b3 — `orphan-home` has no door, so its REASON is the whole product answer and has to be
   * usable on its own. It names the directory, refuses to delete it for the human, and hands over
   * the one command whose refusal separates residue from a human's work — the same `rmdir` policy
   * `removeEmptyAgentProfileHome` applies on the write side.
   */
  it("tells a human with an orphan-home what is there and how to tell residue from work", () => {
    const removal = savedAgentRemovalDoor("orphan-home");
    expect(removal.door).toBeNull();
    expect(removal.reason).toContain(".tachyon/agents/<name>/");
    expect(removal.reason).toContain("never deletes a profile directory automatically");
    expect(removal.reason).toContain("rmdir");
    expect(removal.reason).toContain("refuses when it still holds Soul, Evolution or memory bytes");
    // It must not read as "nothing is there", which is the sentence this state exists to replace.
    expect(removal.reason).not.toContain("there is nothing to remove");
  });
});
