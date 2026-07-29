import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
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
   * SEED 3 — a LIVE tmux session this build cannot account for.
   *
   * "Legacy" is doing real work in this rule. A live agent session is the NORMAL state of a running
   * fleet, so refusing on every one would mean the product refuses to activate after any restart with
   * agents up. What makes one legacy is that it survived a build from before the cut, and the
   * evidence is its ledger row: a session this build spawned has a row carrying an instance policy.
   */
  it("refuses on a live owned agent still running under a pre-cut ledger row, and admits once stopped", () => {
    const live: LegacySessionEntry = { session: `tachyon-${WS}-reviewer`, name: "reviewer", kind: "agent" };
    const refused = inspect({ liveSessions: [live], ledger: [["reviewer", PRE_CUT]] });
    expect(refused.ok).toBe(false);
    expect(refused.offenders.some((o) => o.kind === "live-agent-session" && o.name === "reviewer")).toBe(true);
    expect(refused.offenders.find((o) => o.kind === "live-agent-session")!.detail).toContain(`tachyon-${WS}-reviewer`);
    // Stopping it clears the session offender; the pre-cut ROW is still its own, separate offender.
    const stopped = inspect({ liveSessions: [], ledger: [["reviewer", PRE_CUT]] });
    expect(stopped.offenders.map((o) => o.kind)).toEqual(["ledger-row"]);
  });

  /**
   * The other half of seed 3, and the one that keeps the product usable: a live agent THIS build
   * spawned is accounted for by its ledger row and must NOT block activation. Without this, the gate
   * would refuse every ordinary restart that happened to have a fleet running — which is not a
   * legacy check, it is an outage.
   */
  it("admits a live agent that this build can account for", () => {
    const live: LegacySessionEntry = { session: `tachyon-${WS}-reviewer`, name: "reviewer", kind: "agent" };
    expect(inspect({ liveSessions: [live], ledger: [["reviewer", MODERN]] })).toEqual({ ok: true, offenders: [] });
    // A pre-cut row for the same live agent is refused by BOTH rules, independently.
    const stillLegacy = inspect({ liveSessions: [live], ledger: [["reviewer", PRE_CUT]] });
    expect(stillLegacy.offenders.map((o) => o.kind).sort()).toEqual(["ledger-row", "live-agent-session"]);
  });

  /**
   * The NARROWING, tested so it is a decision rather than an oversight: a live agent with NO ledger
   * row does not block. A compacted row is a state the product already tolerates and says nothing
   * about which build spawned the process — absence of evidence is not evidence of the old species.
   * The cost is real and named in the module: a pre-cut survivor whose row was also compacted slips
   * past THIS check.
   */
  it("does not block a live agent whose ledger row is simply absent", () => {
    const live: LegacySessionEntry = { session: `tachyon-${WS}-live-only`, name: "live-only", kind: "agent" };
    expect(inspect({ liveSessions: [live], ledger: [] })).toEqual({ ok: true, offenders: [] });
  });
});

describe("legacy fleet gate — negative controls (t-fab832)", () => {
  /**
   * CONTROL 1 — the product's own terminals. `terminals:` is an explicit surface that never carried
   * the agent species, so blocking on one would be the gate reaching outside what it gates.
   */
  it("never blocks on a product terminal, in the roster or running", () => {
    const terminalEntry: LegacyRosterEntry = { name: "devserver", kind: "terminal", hasProfilePointer: false };
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
      // `reviewer` is live AND pre-cut, so both the session and the row classes are present.
      ledger: [["old-spike", PRE_CUT], ["reviewer", PRE_CUT]],
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
