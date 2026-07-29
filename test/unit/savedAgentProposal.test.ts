import { describe, expect, it } from "vitest";
import {
  SAVED_AGENT_PROPOSAL_PENDING_CEILING,
  SAVED_AGENT_PROPOSAL_TTL_MS,
  admitSavedAgentProposal,
  computeSavedAgentProposalDigest,
  mayProposeSavedAgent,
  savedAgentProposalIsExpired,
  type SavedAgentProposal,
  type SavedAgentProposalSpec,
} from "../../src/agents/savedAgentProposal.js";
import { AGENT_PROFILE_SCHEMA_VERSION, agentProfileSchemaV1 } from "../../src/config/agentProfileSchema.js";

/**
 * SDD 482 phase 4 slice A (`t-5e1113`) — the proposal is inert data, and every control is a REFUSAL.
 *
 * The threat model's own framing is what these tests follow: this phase moves the baseline from
 * "an agent cannot create a Saved Agent by any route" to "possible with a human approval bound to one
 * exact digest". A receipt cannot un-create a privileged agent, so each control has to be preventive,
 * and each one below has a known way of failing OPEN — which is why it is asserted rather than
 * commented.
 */
const NOW = Date.parse("2026-07-29T00:00:00.000Z");

const GRANTED = { grants: { proposeSavedAgent: true } } as const;
const NOT_GRANTED = { grants: {} } as const;

function spec(over: Partial<SavedAgentProposalSpec> = {}): SavedAgentProposalSpec {
  return { name: "helper", runtimeAdapter: "claude", rationale: "runs the nightly import", ...over };
}

const BASE = { configSha256: "a".repeat(64) };

function admit(over: Parameters<typeof admitSavedAgentProposal>[0] extends infer T ? Partial<T> : never = {}) {
  return admitSavedAgentProposal({
    proposer: "claude-runtime",
    proposerProfile: GRANTED,
    spec: spec(),
    base: BASE,
    pending: [],
    nowMs: NOW,
    id: "p-0001",
    // Every approval creates one ownership edge (proposer owns the new agent), so admission always
    // consults the roster. An empty roster is a real workspace state, not a stub.
    roster: [],
    ...over,
  });
}

function pending(over: Partial<SavedAgentProposal> = {}): SavedAgentProposal {
  const admitted = admit();
  if (!admitted.ok) throw new Error("fixture must admit");
  return { ...admitted.proposal, ...over };
}

describe("Saved Agent proposal admission (SDD 482 phase 4A)", () => {
  it("refuses BY NAME when the proposer's profile carries no capability", () => {
    const refused = admit({ proposerProfile: NOT_GRANTED });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("capability_absent");
    // Naming the missing capability and the remedy is the control: a silent no reads as a bug and
    // gets retried forever.
    expect(refused.reason).toContain("grants.proposeSavedAgent");
    expect(refused.reason).toContain("Agent Studio");
  });

  it("fails closed on every shape that is not an explicit true", () => {
    expect(mayProposeSavedAgent(undefined)).toBe(false);
    expect(mayProposeSavedAgent({})).toBe(false);
    expect(mayProposeSavedAgent({ grants: {} })).toBe(false);
    expect(mayProposeSavedAgent({ grants: { proposeSavedAgent: false } })).toBe(false);
    expect(mayProposeSavedAgent(GRANTED)).toBe(true);
  });

  /**
   * Invariant 9. If an approved proposal could carry the proposing capability, ONE human approval
   * becomes a tree of creators and the control changes from per-creation to per-principal — the
   * alternative this SDD discards by name. The proposal must FAIL, not arrive silently pruned: a
   * proposer that asked for this has to learn it was refused.
   */
  it("refuses a proposal that would make the new agent a creator too, instead of pruning it", () => {
    const refused = admit({ spec: spec({ grants: { proposeSavedAgent: true } }) });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("capability_recursion");
    expect(refused.reason).toContain("tree");
  });

  it("allows a proposal that explicitly asks for the capability to be absent", () => {
    const admitted = admit({ spec: spec({ grants: { proposeSavedAgent: false } }) });
    expect(admitted.ok).toBe(true);
  });

  /**
   * The digest is what an approval binds to, and it covers the PROPOSER. Two agents asking for an
   * identical Saved Agent are two decisions — otherwise approving one silently authorizes the other.
   */
  it("binds the digest to proposer, spec and base state, not to the spec alone", () => {
    const mine = computeSavedAgentProposalDigest({ proposer: "a", spec: spec(), base: BASE });
    expect(computeSavedAgentProposalDigest({ proposer: "b", spec: spec(), base: BASE })).not.toBe(mine);
    expect(computeSavedAgentProposalDigest({ proposer: "a", spec: spec({ name: "other" }), base: BASE }))
      .not.toBe(mine);
    expect(computeSavedAgentProposalDigest({ proposer: "a", spec: spec(), base: { configSha256: "b".repeat(64) } }))
      .not.toBe(mine);
  });

  it("digests by value, not by the order a caller happened to build the object in", () => {
    const one = computeSavedAgentProposalDigest({
      proposer: "a",
      spec: { name: "helper", runtimeAdapter: "claude", rationale: "r", environment: { B: "2", A: "1" } },
      base: BASE,
    });
    const two = computeSavedAgentProposalDigest({
      proposer: "a",
      spec: { rationale: "r", environment: { A: "1", B: "2" }, runtimeAdapter: "claude", name: "helper" },
      base: BASE,
    });
    expect(two).toBe(one);
  });

  /**
   * Collapse before the ceiling, and this ORDER is the control. Count first and a retrying agent
   * consumes its own slots and is refused for flooding while asking for one thing.
   */
  it("collapses an identical re-proposal onto the live one instead of queueing it", () => {
    const live = pending();
    const again = admit({ pending: [live], id: "p-0002" });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.collapsedOnto).toBe(live.id);
    expect(again.proposal.id).toBe(live.id); // the human still has exactly one thing to decide
  });

  it("holds a per-proposer ceiling once the pending proposals are genuinely different", () => {
    const live = Array.from({ length: SAVED_AGENT_PROPOSAL_PENDING_CEILING }, (_, index) =>
      pending({ id: `p-live-${index}`, digest: `${index}`.repeat(64) }));
    const refused = admit({ pending: live, spec: spec({ name: "yet-another" }) });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("pending_ceiling");
  });

  it("counts only the ceiling of THIS proposer — a neighbour's queue never refuses mine", () => {
    const theirs = Array.from({ length: SAVED_AGENT_PROPOSAL_PENDING_CEILING + 2 }, (_, index) =>
      pending({ id: `p-theirs-${index}`, proposer: "codex-canonico", digest: `${index}`.repeat(64) }));
    expect(admit({ pending: theirs }).ok).toBe(true);
  });

  it("does not let expired proposals hold a slot", () => {
    const stale = Array.from({ length: SAVED_AGENT_PROPOSAL_PENDING_CEILING }, (_, index) =>
      pending({ id: `p-stale-${index}`, digest: `${index}`.repeat(64), expiresAt: new Date(NOW - 1).toISOString() }));
    expect(admit({ pending: stale, spec: spec({ name: "fresh" }) }).ok).toBe(true);
  });

  it("expires at 24h and treats an unreadable expiry as expired", () => {
    const live = pending();
    expect(Date.parse(live.expiresAt) - Date.parse(live.createdAt)).toBe(SAVED_AGENT_PROPOSAL_TTL_MS);
    expect(savedAgentProposalIsExpired(live, NOW + SAVED_AGENT_PROPOSAL_TTL_MS - 1)).toBe(false);
    expect(savedAgentProposalIsExpired(live, NOW + SAVED_AGENT_PROPOSAL_TTL_MS)).toBe(true);
    // A tampered or unparseable expiry must not read as "never expires".
    expect(savedAgentProposalIsExpired({ ...live, expiresAt: "not-a-date" }, NOW)).toBe(true);
  });

  it("requires a rationale and a base digest — the two things the human decision rests on", () => {
    const noReason = admit({ spec: spec({ rationale: "   " }) });
    expect(noReason.ok).toBe(false);
    const noBase = admit({ base: { configSha256: "" } });
    expect(noBase.ok).toBe(false);
    if (noBase.ok) return;
    expect(noBase.code).toBe("invalid_spec");
  });

  it("refuses an invalid roster name before it can reach any writer", () => {
    for (const name of ["../escape", "9lives", "has space", ""]) {
      expect(admit({ spec: spec({ name }) }).ok, name).toBe(false);
    }
  });
});

describe("the grants field is authority, kept apart from capabilities (SDD 482 phase 4A)", () => {
  const profile = {
    schemaVersion: AGENT_PROFILE_SCHEMA_VERSION,
    agentId: "00000000-0000-4000-8000-000000000000",
    runtime: { adapter: "claude", executable: "claude" },
  };

  it("parses grants as its own field and rejects an unknown grant", () => {
    expect(agentProfileSchemaV1.safeParse({ ...profile, grants: { proposeSavedAgent: true } }).success).toBe(true);
    expect(agentProfileSchemaV1.safeParse({ ...profile, grants: {} }).success).toBe(true);
    expect(agentProfileSchemaV1.safeParse({ ...profile, grants: { becomeRoot: true } }).success).toBe(false);
  });

  /**
   * `capabilities` lists RESOURCES the agent is given; `grants` is AUTHORITY over the roster. Putting
   * the second inside the first would mean a reader cannot tell "has the fetch MCP server" from "may
   * create agents" — the same one-word-two-jobs conflation this SDD exists to undo.
   */
  it("does not accept the authority as a capability", () => {
    const asCapability = agentProfileSchemaV1.safeParse({
      ...profile,
      capabilities: { proposeSavedAgent: true },
    });
    expect(asCapability.success).toBe(false);
  });
});
