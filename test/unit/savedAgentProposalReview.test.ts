import { describe, expect, it } from "vitest";
import { buildSavedAgentProposalReview } from "../../src/agents/savedAgentProposalReview.js";
import { buildHumanInbox, humanInboxCounts } from "../../src/humanInbox/model.js";
import { admitSavedAgentProposal, type SavedAgentProposal } from "../../src/agents/savedAgentProposal.js";
import { assertOwnershipTargets, type AgentOwnershipRosterV1 } from "../../src/config/agentProfileStudio.js";

/**
 * SDD 482 phase 4 slice C (`t-5e1113`) — what the human sees, and what they must never see.
 *
 * The approval is the only thing between a proposal and durable authority, so this surface has two
 * jobs that pull in opposite directions: show enough that a reviewer understands the consequence, and
 * echo nothing that would turn the review pane into a place credentials get screenshotted.
 */
const NOW = Date.parse("2026-07-29T06:00:00.000Z");
const CONFIG_SHA = "a".repeat(64);

function proposal(over: Partial<SavedAgentProposal["spec"]> = {}, top: Partial<SavedAgentProposal> = {}): SavedAgentProposal {
  return {
    id: "sp-000001",
    proposer: "claude-runtime",
    proposerKind: "agent",
    createdAt: "2026-07-29T00:00:00.000Z",
    expiresAt: "2026-07-30T00:00:00.000Z",
    digest: "d".repeat(64),
    base: { configSha256: CONFIG_SHA },
    spec: { name: "importer", runtimeAdapter: "claude", rationale: "runs the nightly import", ...over },
    ...top,
  };
}

const review = (p = proposal(), currentConfigSha256 = CONFIG_SHA, nowMs = NOW) =>
  buildSavedAgentProposalReview({ proposal: p, currentConfigSha256, nowMs });

describe("Saved Agent proposal review (SDD 482 phase 4C)", () => {
  /**
   * The rule that matters most. A proposal cannot reference a secret PROVIDER by type, but nothing
   * stops a proposer pasting a token into an ordinary environment value — and a pane that echoes it
   * puts the credential into a screenshot, a log and a support thread at once.
   */
  it("shows environment NAMES and never their values", () => {
    const vm = review(proposal({ environment: { ANTHROPIC_API_KEY: "sk-ant-secret-value", REGION: "eu" } }));
    expect(vm.environmentNames).toEqual(["ANTHROPIC_API_KEY", "REGION"]);
    expect(JSON.stringify(vm)).not.toContain("sk-ant-secret-value");
    // The reviewer is still told the variables exist and where to look if they need the values.
    expect(vm.dangerous.find((d) => d.label === "environment")?.detail).toContain("ANTHROPIC_API_KEY");
    expect(vm.dangerous.find((d) => d.label === "environment")?.detail).toContain("Values are not");
  });

  it("names every grant of authority in the dangerous list, so reading only that list is still complete", () => {
    const vm = review(proposal({
      ownsSubagents: ["helper"],
      executable: "claude",
      capabilities: { mcp: ["fetch"], hooks: ["preflight"], skills: ["review"] },
      environment: { TOKEN: "x" },
    }));
    expect(vm.dangerous.map((d) => d.label).sort())
      .toEqual(["capabilities requested (NOT granted by this approval)", "environment", "executable", "roster ownership"]);
    // Ownership is described honestly: durable, but not operational authority by itself.
    expect(vm.dangerous.find((d) => d.label === "roster ownership")?.detail)
      .toContain("confers no operational authority");
    // The capability request is shown as EXPLICITLY not granted, which is the canonical rule for a
    // create: a reviewer must not believe they just handed over MCP access.
    expect(vm.hasUngrantedCapabilityRequests).toBe(true);
    expect(vm.dangerous.find((d) => d.label.startsWith("capabilities"))?.detail)
      .toContain("Approving does NOT grant these");
    expect(vm.requestedSkills).toEqual(["review"]);
    expect(vm.requestedHooks).toEqual(["preflight"]);
  });

  it("lists nothing dangerous for a plain proposal, rather than inventing reassurance", () => {
    expect(review().dangerous).toEqual([]);
  });

  it("names the durable artifacts the approval would create", () => {
    const vm = review();
    expect(vm.affected).toEqual([
      ".tachyon/agents/importer/agent.yml (new canonical profile, lifecycle.enabled=true)",
      ".tachyon/agents/importer/authority.json (new authority record)",
      "tachyon.yml → agents.importer (new roster pointer)",
      "created enabled; not started (no session, no running worktree, no task assignment)",
    ]);
  });

  it("shows a diverged base BEFORE the human decides, not after the commit refuses", () => {
    expect(review().baseDiverged).toBe(false);
    expect(review(proposal(), "b".repeat(64)).baseDiverged).toBe(true);
  });

  it("marks the proposer as Bridge-resolved, because it is", () => {
    expect(review().proposerTrust).toBe("bridge-resolved");
  });

  it("marks expiry from the same predicate the commit path uses", () => {
    expect(review().expired).toBe(false);
    expect(review(proposal(), CONFIG_SHA, Date.parse("2026-07-31T00:00:00.000Z")).expired).toBe(true);
  });
});

describe("Saved Agent proposals in the Human Inbox (SDD 482 phase 4C)", () => {
  const base = { wsHash: "ws-1", folder: "Project", approvals: [], validations: [] };

  it("adds a row that names the agent and the runtime, ranked below a blocking approval", () => {
    const items = buildHumanInbox({ ...base, savedAgentProposals: [review()] }, { now: "2026-07-29T06:00:00.000Z" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "saved-agent-proposal",
      title: "create Saved Agent 'importer' (claude)",
      requester: "claude-runtime",
      requesterTrust: "bridge-resolved",
    });
    expect(humanInboxCounts(items).savedAgentProposals).toBe(1);
  });

  /**
   * An expired proposal is not a decision any more. Showing it would invite an approval that the
   * commit path then refuses — which is precisely how a human learns that approving does nothing.
   */
  it("drops an expired proposal from the inbox rather than offering an approval that would be refused", () => {
    const expired = review(proposal(), CONFIG_SHA, Date.parse("2026-07-31T00:00:00.000Z"));
    expect(buildHumanInbox({ ...base, savedAgentProposals: [expired] })).toEqual([]);
  });

  it("warns on a diverged base instead of hiding the row", () => {
    const items = buildHumanInbox({ ...base, savedAgentProposals: [review(proposal(), "b".repeat(64))] });
    expect(items[0]?.warning).toContain("no longer be committed as reviewed");
  });

  /**
   * A corrupt proposal file is a thing the human must SEE. The row is the only place where "someone
   * edited this" is distinguishable from "it was withdrawn".
   */
  it("surfaces an unreadable proposal as a warned row that cannot be mistaken for a real one", () => {
    const items = buildHumanInbox({
      ...base,
      untrustedSavedAgentProposals: [{ id: "sp-bad001", reason: "does not match its digest" }],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.warning).toContain("does not match its digest");
    expect(items[0]?.title).toContain("unreadable");
    // Its proposer cannot be trusted, so the row must not claim Bridge-resolved provenance.
    expect(items[0]?.requesterTrust).toBe("self-declared");
    expect(items[0]?.requester).toBe("unknown");
  });

  it("ranks a blocking approval above a proposal, and a proposal above a validation", () => {
    const items = buildHumanInbox({
      wsHash: "ws-1",
      folder: "Project",
      approvals: [{
        id: "a-000001", requester: "codex", requesterKind: "agent", session: "s", createdAt: "2026-07-29T05:00:00.000Z",
        status: "pending", payload: { reason: "needs a decision", proposedAction: "x", risk: "y", exactPrompt: "z" },
      } as never],
      validations: [{
        id: "v-000001", title: "check the render", status: "open", executor: "human",
        createdAt: "2026-07-29T04:00:00.000Z", sourceRefs: [], rounds: [],
      } as never],
      savedAgentProposals: [review()],
    }, { now: "2026-07-29T06:00:00.000Z" });
    expect(items.map((i) => i.kind)).toEqual(["approval", "saved-agent-proposal", "validation"]);
  });
});

/**
 * SDD 482 phase 4C — requested ownership is refused at ADMISSION, by the spec 352 rules a Studio edit
 * obeys, with the same wording.
 *
 * `claude-reviewer` found the gap and named the cost precisely: the config loader is fail-closed, so a
 * conflicting `ownsSubagents` WOULD have been caught — but only after a human approved, as an opaque
 * config error during the transaction's reload, with the commit rolling back. Fail-closed is not the
 * same as well-behaved: the human would have consented to something that then quietly undid itself.
 */
describe("requested ownership is validated where the proposer can still learn why", () => {
  const GRANTED = { grants: { proposeSavedAgent: true } } as const;
  const BASE = { configSha256: "a".repeat(64) };
  const NOW_MS = Date.parse("2026-07-29T00:00:00.000Z");

  const admit = (ownsSubagents: string[], roster?: AgentOwnershipRosterV1) =>
    admitSavedAgentProposal({
      proposer: "claude-runtime",
      proposerProfile: GRANTED,
      spec: { name: "importer", runtimeAdapter: "claude", rationale: "why", ownsSubagents },
      base: BASE,
      pending: [],
      nowMs: NOW_MS,
      id: "sp-000001",
      ...(roster ? { roster } : {}),
    });

  const ROSTER: AgentOwnershipRosterV1 = [
    { name: "boss", kind: "agent", subagents: ["owned"] },
    { name: "owned", kind: "agent", subagents: [] },
    { name: "free", kind: "agent", subagents: [] },
    { name: "parent-of-one", kind: "agent", subagents: ["free2"] },
    { name: "free2", kind: "agent", subagents: [] },
    { name: "devserver", kind: "terminal", subagents: [] },
  ];

  it("refuses ANY declared subagents in v1 — the proposer owns the new agent, nothing else moves", () => {
    const refused = admit(["free"], ROSTER);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("ownership_conflict");
    expect(refused.reason).toContain("reparenting an existing agent is a separate roster edit");
  });

  /**
   * The roster is required for EVERY proposal now, because every approval creates one ownership edge:
   * the proposer owns the new agent. "I could not check" and "it is fine" remain different answers.
   */
  it("refuses when the roster is unavailable, even with no ownership requested", () => {
    const refused = admitSavedAgentProposal({
      proposer: "claude-runtime",
      proposerProfile: GRANTED,
      spec: { name: "importer", runtimeAdapter: "claude", rationale: "why" },
      base: BASE,
      pending: [],
      nowMs: NOW_MS,
      id: "sp-000001",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("ownership_conflict");
  });

  it("admits with an empty roster — a workspace with no agents is a real state", () => {
    expect(admitSavedAgentProposal({
      proposer: "claude-runtime",
      proposerProfile: GRANTED,
      spec: { name: "importer", runtimeAdapter: "claude", rationale: "why" },
      base: BASE,
      pending: [],
      nowMs: NOW_MS,
      id: "sp-000001",
      roster: [],
    }).ok).toBe(true);
  });

  /**
   * The rule lives in ONE place. If these two ever answer differently, the proposer and the Studio
   * user are being told different things about the same roster — which is the drift the extraction
   * exists to prevent.
   */
  /**
   * The name collision the synthetic roster entry must NOT hide: proposing an agent whose name is
   * already taken by an OWNED agent has to be refused with the Studio's own wording. Appending the
   * stand-in entry unconditionally would shadow the real one (a later key wins in the Map) and turn
   * this into a silent pass.
   */
  it("refuses a name already taken by an owned agent, in the Studio's words", () => {
    const refused = admitSavedAgentProposal({
      proposer: "claude-runtime",
      proposerProfile: GRANTED,
      spec: { name: "owned", runtimeAdapter: "claude", rationale: "why" },
      base: BASE,
      pending: [],
      nowMs: NOW_MS,
      id: "sp-000001",
      roster: ROSTER,
    });
    let viaStudio = "";
    try {
      assertOwnershipTargets("claude-runtime", ["owned"], ROSTER);
    } catch (error) {
      viaStudio = error instanceof Error ? error.message : String(error);
    }
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe(viaStudio);
  });
});
