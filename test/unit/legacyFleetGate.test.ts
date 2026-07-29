import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  POST_CUT_SESSION_ATTESTATION,
  describeLegacyFleetRefusal,
  inspectLegacyFleet,
  isOwnedAgentSession,
  type LegacyRosterEntry,
  type LegacySessionEntry,
} from "../../src/agents/legacyFleetGate.js";
import type { InstancePolicySource } from "../../src/agents/agentInstancePolicy.js";

/**
 * `t-fab832` step 1 — the activation gate, proven seed by seed.
 *
 * The task names three seeds and two negative controls, and they are tested as separate facts rather
 * than as one scenario, because they fail for different reasons and are cleared by different actions.
 * Each seed is asserted BOTH ways: present → refused, removed → admitted. A gate tested only in the
 * refusing direction would pass while refusing everything, which is the failure mode that would
 * actually reach an operator.
 */
const WS = "b349073a";

const MODERN: InstancePolicySource = {
  declared: true,
  instance: { identity: "saved", lifetime: "restartable" },
};
const PRE_CUT: InstancePolicySource = { declared: true }; // no instance policy: written before the cut

const POINTER: LegacyRosterEntry = { name: "reviewer", kind: "agent", hasProfilePointer: true };
const INLINE: LegacyRosterEntry = { name: "old-spike", kind: "agent", hasProfilePointer: false };

const inspect = (over: Partial<Parameters<typeof inspectLegacyFleet>[0]> = {}) =>
  inspectLegacyFleet({ wsHash: WS, ledger: [], rosterEntries: [], liveSessions: [], ...over });

describe("legacy fleet gate — seeds (t-fab832)", () => {
  it("admits a workspace with no legacy state at all", () => {
    const clean = inspect({
      ledger: [["reviewer", MODERN]],
      rosterEntries: [POINTER],
      liveSessions: [],
    });
    expect(clean).toEqual({ ok: true, offenders: [] });
  });

  /** SEED 1 — a ledger row written before the instance policy existed. */
  it("refuses on a pre-cut ledger row, and admits once it is gone", () => {
    const refused = inspect({ ledger: [["reviewer", MODERN], ["old-spike", PRE_CUT]] });
    expect(refused.ok).toBe(false);
    expect(refused.offenders).toEqual([{
      kind: "ledger-row",
      name: "old-spike",
      detail: "session ledger row carries no instance policy — it was written before the Agent Instance cut",
    }]);
    // The modern row beside it is NOT an offender: the gate is about the retired species, not about
    // having a ledger.
    expect(inspect({ ledger: [["reviewer", MODERN]] }).ok).toBe(true);
  });

  /** SEED 2 — an inline `agents:` definition instead of a canonical profile pointer. */
  it("refuses on an inline roster entry, and admits once it points at a profile", () => {
    const refused = inspect({ rosterEntries: [POINTER, INLINE] });
    expect(refused.ok).toBe(false);
    expect(refused.offenders.map((o) => [o.kind, o.name])).toEqual([["roster-entry", "old-spike"]]);
    expect(inspect({ rosterEntries: [POINTER, { ...INLINE, hasProfilePointer: true }] }).ok).toBe(true);
  });

  /**
   * SEED 3 — a LIVE tmux session without valid post-cut proof.
   *
   * The proof is carried by the SESSION, not the ledger. A ledger row is separate state that can be
   * compacted, rewritten or absent, so using it as proof lets a process with no record read as
   * "probably fine" — the direction a gate must never fail. The attestation is minted into the
   * session environment at creation, so only a build that had it can produce one.
   */
  it("refuses a live owned agent session carrying no attestation, and admits once it is stopped", () => {
    const live: LegacySessionEntry = { session: `tachyon-${WS}-reviewer`, name: "reviewer", kind: "agent" };
    const refused = inspect({ liveSessions: [live] });
    expect(refused.ok).toBe(false);
    expect(refused.offenders[0]).toMatchObject({ kind: "live-agent-session", name: "reviewer" });
    expect(refused.offenders[0]!.detail).toContain("was not created by this build");
    expect(inspect({ liveSessions: [] }).ok).toBe(true);
  });

  it("admits a live agent that carries the post-cut attestation", () => {
    const proven: LegacySessionEntry = {
      session: `tachyon-${WS}-reviewer`, name: "reviewer", kind: "agent",
      attestation: POST_CUT_SESSION_ATTESTATION,
    };
    expect(inspect({ liveSessions: [proven] })).toEqual({ ok: true, offenders: [] });
  });

  /**
   * NO LEDGER FALLBACK, and this is the correction that mattered. I twice tried to source this proof
   * from the ledger — first admitting anything with a post-cut row, then admitting anything with no
   * row at all. Both let a session in on the strength of state that is not the session. A modern
   * ledger row does NOT excuse a session that cannot attest for itself.
   */
  it("refuses an unattested session even when its ledger row is modern", () => {
    const live: LegacySessionEntry = { session: `tachyon-${WS}-reviewer`, name: "reviewer", kind: "agent" };
    const refused = inspect({ liveSessions: [live], ledger: [["reviewer", MODERN]] });
    expect(refused.ok).toBe(false);
    expect(refused.offenders.map((o) => o.kind)).toEqual(["live-agent-session"]);
  });

  it("refuses a session attesting some other version rather than trusting the shape", () => {
    const other: LegacySessionEntry = {
      session: `tachyon-${WS}-reviewer`, name: "reviewer", kind: "agent", attestation: "agent-instance-v9",
    };
    const refused = inspect({ liveSessions: [other] });
    expect(refused.ok).toBe(false);
    expect(refused.offenders[0]!.detail).toContain("attests 'agent-instance-v9'");
  });
});

describe("legacy fleet gate — negative controls (t-fab832)", () => {
  /**
   * CONTROL 1 — the product's own terminals. `terminals:` is an explicit surface that never carried
   * the agent species, so blocking on one would be the gate reaching outside what it gates.
   */
  it("never blocks on a product terminal, in the roster or running", () => {
    const terminalEntry: LegacyRosterEntry = { name: "devserver", kind: "terminal", hasProfilePointer: false };
    // No attestation on purpose: a terminal is not an agent and must not need one.
    const terminalSession: LegacySessionEntry = { session: `tachyon-${WS}-devserver`, name: "devserver", kind: "terminal" };
    // An inline-shaped terminal is still not an offender — `hasProfilePointer: false` is normal here.
    expect(inspect({ rosterEntries: [terminalEntry], liveSessions: [terminalSession] }))
      .toEqual({ ok: true, offenders: [] });
  });

  /**
   * CONTROL 2 — tmux sessions that are not ours. A developer's own session, or another workspace's
   * Tachyon fleet, must never block activation here.
   */
  it("never blocks on an external tmux session, or on another workspace's Tachyon fleet", () => {
    const mine: LegacySessionEntry = { session: "notes", name: "notes", kind: "agent" };
    const neighbour: LegacySessionEntry = { session: "tachyon-ffffffff-reviewer", name: "reviewer", kind: "agent" };
    expect(inspect({ liveSessions: [mine, neighbour] })).toEqual({ ok: true, offenders: [] });

    expect(isOwnedAgentSession(`tachyon-${WS}-reviewer`, WS)).toBe(true);
    expect(isOwnedAgentSession("tachyon-ffffffff-reviewer", WS)).toBe(false);
    expect(isOwnedAgentSession("notes", WS)).toBe(false);
    // A workspace hash that merely PREFIXES ours is a different workspace, not ours.
    expect(isOwnedAgentSession(`tachyon-${WS}extra-reviewer`, WS)).toBe(false);
  });
});

describe("legacy fleet gate — what the operator is told (t-fab832)", () => {
  it("names every offender class present, and only those", () => {
    const result = inspect({
      // `old-spike` is a pre-cut ROW; `reviewer` is an unattested live SESSION. Both classes present.
      ledger: [["old-spike", PRE_CUT]],
      liveSessions: [{ session: `tachyon-${WS}-reviewer`, name: "reviewer", kind: "agent" }],
    });
    expect(result.remedy).toContain("stop those agents");
    expect(result.remedy).toContain("dismiss");
    // No roster offender here, so the config remedy must not appear — a catalogue of everything that
    // could be wrong tells an operator nothing about what IS wrong.
    expect(result.remedy).not.toContain("tachyon.yml");
  });

  it("says plainly that nothing was touched, because that is the promise", () => {
    const message = describeLegacyFleetRefusal(inspect({ ledger: [["old-spike", PRE_CUT]] }));
    expect(message).toContain("Nothing was changed or stopped");
    expect(message).toContain("will not reinterpret it");
    expect(message).toContain("ledger-row: old-spike");
    expect(message).toContain("To proceed,");
  });

  it("returns no message at all when the gate admits", () => {
    expect(describeLegacyFleetRefusal({ ok: true, offenders: [] })).toBe("");
  });

  /**
   * The gate REPORTS. It has no port through which it could stop or delete anything, and that is
   * asserted structurally: a gate that cleaned up after itself would be making the decision it exists
   * to escalate, and "activation killed my running fleet" is worse than any refusal.
   */
  it("has no way to kill anything — asserted on the source, not assumed", () => {
    const text = fs.readFileSync(path.resolve(__dirname, "../../src/agents/legacyFleetGate.ts"), "utf8");
    expect(text).not.toMatch(/\bkill\w*\(/);
    expect(text).not.toMatch(/\brm\w*\(|unlink|writeFile|execFile|spawn\(/);
  });
});
