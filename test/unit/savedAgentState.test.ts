import { describe, expect, it } from "vitest";
import {
  deriveSavedAgentState,
  isSavedAgentStateMember,
  savedAgentRemovalDoor,
  type SavedAgentPresenceFacts,
  type SavedAgentState,
} from "../../src/config/savedAgentState.js";

/**
 * SDD 494 Part 4 — the derivation is a total function over four booleans, so the test is the whole
 * truth table rather than the five rows the spec names.
 *
 * Sixteen rows, written out. A table generated from the implementation would agree with any
 * implementation, including a wrong one; these expectations come from `spec.md`'s resolution table
 * and from the rule that a presence fact decides before the projection does.
 */
const TABLE: Array<{ facts: SavedAgentPresenceFacts; state: SavedAgentState; member: boolean }> = [
  // No roster row, no profile, no authority — not a subject at all.
  { facts: { rosterRow: false, profileOnDisk: false, authorityRecord: false, projection: false }, state: "absent", member: false },
  { facts: { rosterRow: false, profileOnDisk: false, authorityRecord: false, projection: true }, state: "absent", member: false },
  // Authority only.
  { facts: { rosterRow: false, profileOnDisk: false, authorityRecord: true, projection: false }, state: "stranded-authority", member: false },
  { facts: { rosterRow: false, profileOnDisk: false, authorityRecord: true, projection: true }, state: "stranded-authority", member: false },
  // A profile with no roster row, attested or not.
  { facts: { rosterRow: false, profileOnDisk: true, authorityRecord: false, projection: false }, state: "unlisted-profile", member: false },
  { facts: { rosterRow: false, profileOnDisk: true, authorityRecord: false, projection: true }, state: "unlisted-profile", member: false },
  { facts: { rosterRow: false, profileOnDisk: true, authorityRecord: true, projection: false }, state: "unlisted-profile", member: false },
  { facts: { rosterRow: false, profileOnDisk: true, authorityRecord: true, projection: true }, state: "unlisted-profile", member: false },
  // A roster row whose profile is gone. The authority does not change the answer.
  { facts: { rosterRow: true, profileOnDisk: false, authorityRecord: false, projection: false }, state: "orphan-locator", member: true },
  { facts: { rosterRow: true, profileOnDisk: false, authorityRecord: false, projection: true }, state: "orphan-locator", member: true },
  { facts: { rosterRow: true, profileOnDisk: false, authorityRecord: true, projection: false }, state: "orphan-locator", member: true },
  { facts: { rosterRow: true, profileOnDisk: false, authorityRecord: true, projection: true }, state: "orphan-locator", member: true },
  // Roster row and profile agree, no human approved these bytes.
  { facts: { rosterRow: true, profileOnDisk: true, authorityRecord: false, projection: false }, state: "unattested", member: true },
  { facts: { rosterRow: true, profileOnDisk: true, authorityRecord: false, projection: true }, state: "unattested", member: true },
  // All three records agree; only the projection separates the last two rows.
  { facts: { rosterRow: true, profileOnDisk: true, authorityRecord: true, projection: false }, state: "unprojectable", member: true },
  { facts: { rosterRow: true, profileOnDisk: true, authorityRecord: true, projection: true }, state: "consistent", member: true },
];

describe("SDD 494 Part 4 — the five states derived from four presence facts", () => {
  it("covers every combination of the four facts exactly once", () => {
    const keys = TABLE.map(({ facts }) => `${+facts.rosterRow}${+facts.profileOnDisk}${+facts.authorityRecord}${+facts.projection}`);
    expect(new Set(keys).size).toBe(16);
  });

  for (const { facts, state, member } of TABLE) {
    const label = `roster=${+facts.rosterRow} profile=${+facts.profileOnDisk} authority=${+facts.authorityRecord} projection=${+facts.projection}`;
    it(`derives ${state} for ${label}`, () => {
      expect(deriveSavedAgentState(facts)).toBe(state);
      expect(isSavedAgentStateMember(facts)).toBe(member);
    });
  }

  it("names all five disagreements of spec.md and nothing else", () => {
    const derived = new Set(TABLE.map(({ facts }) => deriveSavedAgentState(facts)));
    expect([...derived].sort()).toEqual([
      "absent",
      "consistent",
      "orphan-locator",
      "stranded-authority",
      "unattested",
      "unlisted-profile",
      "unprojectable",
    ]);
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
});
