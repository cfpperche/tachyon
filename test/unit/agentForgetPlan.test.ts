/**
 * t-e722ce — the plan says what the cascade will do, and says it in the cascade's own terms.
 *
 * These cases are pure: they feed `projectAgentForgetPlan` the facts a workspace can be in and read
 * back the sentence a human would see. What they defend is not the wording but the CLASSIFICATION —
 * "already satisfied" and "will run" being different things, a blocked step carrying the engine's
 * own refusal code and a gesture, and the plan following ONE source while reporting the others.
 *
 * The measured failure this replaces: on 0.56.142 the same conditions produced "The profile
 * lifecycle action could not be completed" and three rounds of guessing. Every assertion below is a
 * fact the product knew at the first click and did not say.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_FORGET_PLAN_RETAINED_BINDINGS,
  AGENT_PROFILE_FORGET_RETAINED_BINDINGS,
  projectAgentForgetPlan,
  type AgentForgetPlanFactsV1,
  type AgentForgetPlanStepId,
} from "../../src/config/agentForgetPlan.js";

const REVISION = "a".repeat(64);

/** A workspace where nothing blocks and nothing is owned: the plan's quiet baseline. */
function facts(patch: Partial<AgentForgetPlanFactsV1> = {}): AgentForgetPlanFactsV1 {
  return {
    agentName: "reviewer",
    revision: REVISION,
    occupancy: { state: "free" },
    liveDescendants: [],
    ledgerWorktree: null,
    checkoutPresent: null,
    registryWorktreeBranch: null,
    evolutionProfilePresent: false,
    evolutionProfileTreeEntryPresent: false,
    authorityPresent: true,
    locatorPresent: true,
    profileHomePresent: true,
    ...patch,
  };
}

const worktree = {
  branch: "tachyon/reviewer",
  path: "/cache/reviewer",
  tachyonCreatedBranch: true,
  status: { staged: 1, unstaged: 2, untracked: 0, conflicts: 0, aheadOfBase: 3, unpushed: 3 },
};

function step(f: AgentForgetPlanFactsV1, id: AgentForgetPlanStepId) {
  const found = projectAgentForgetPlan(f).steps.find((entry) => entry.id === id);
  if (!found) throw new Error(`plan has no step '${id}'`);
  return found;
}

describe("t-e722ce: the forget plan", () => {
  it("lists the cascade's steps in the cascade's order, never a prettier one", () => {
    // The order is load-bearing: a human reads the FIRST blocked step as the thing to go fix, so a
    // list sorted for readability would send them at a gate that is not the one holding them up.
    expect(projectAgentForgetPlan(facts()).steps.map((entry) => entry.id)).toEqual([
      "stop-session",
      "remove-worktree",
      "retire-evolution",
      "retire-authority",
      "remove-locator",
      "quarantine-profile",
      "converge-runtime",
    ]);
  });

  it("distinguishes a precondition already met from one the cascade will perform", () => {
    // This distinction IS the feature. The old flow could only say "could not be completed", so a
    // human who had already stopped the agent went and stopped it again, then went looking for a
    // worktree the ledger did not claim. Both facts were computable at the first click.
    expect(step(facts(), "stop-session").state).toBe("satisfied");
    expect(step(facts({ occupancy: { state: "occupied", detail: "pane alive" } }), "stop-session"))
      .toMatchObject({ state: "will-run" });
    expect(step(facts(), "remove-worktree")).toMatchObject({ state: "satisfied" });
    expect(step(facts({ ledgerWorktree: worktree, checkoutPresent: true }), "remove-worktree"))
      .toMatchObject({ state: "will-run" });
    expect(step(facts({ profileHomePresent: false }), "quarantine-profile").state).toBe("satisfied");
    expect(step(facts({ locatorPresent: false }), "remove-locator").state).toBe("satisfied");
  });

  it("blocks with the engine's own refusal code and a gesture, never a bare failure", () => {
    const unverifiable = facts({ occupancy: { state: "unknown", detail: "tmux did not answer" } });
    expect(step(unverifiable, "stop-session")).toMatchObject({
      state: "blocked",
      refusalCode: "agent-profile/occupancy-unverifiable",
    });
    expect(step(unverifiable, "stop-session").resolution).toBeTruthy();
    expect(projectAgentForgetPlan(unverifiable).executable).toBe(false);

    const descendants = facts({ ledgerWorktree: worktree, checkoutPresent: true, liveDescendants: ["scout", "tester"] });
    expect(step(descendants, "remove-worktree")).toMatchObject({
      state: "blocked",
      refusalCode: "agent-profile/worktree-release-agent-running",
    });
    expect(step(descendants, "remove-worktree").resolution).toContain("scout, tester");

    expect(step(facts({ authorityPresent: false }), "retire-authority")).toMatchObject({
      state: "blocked",
      refusalCode: "agent-profile/forget-authority-stale",
    });
    expect(step(facts({ evolutionProfilePresent: true }), "retire-evolution")).toMatchObject({
      state: "blocked",
      refusalCode: "agent-profile/forget-evolution-incomplete",
    });
  });

  it("follows the session ledger and REPORTS the sources that disagree with it", () => {
    // The measurement that closes the argument: three sources answered "does this agent own a
    // worktree" differently, and each surface had picked one. A plan that picked the registry could
    // say "no checkout" while the forget refuses `forget-worktree-owned` — the same dead end, one
    // layer up. So the ledger decides, and the disagreement is shown rather than resolved silently.
    const registryOnly = projectAgentForgetPlan(facts({ registryWorktreeBranch: "tachyon/reviewer" }));
    expect(step(facts({ registryWorktreeBranch: "tachyon/reviewer" }), "remove-worktree").state).toBe("satisfied");
    expect(registryOnly.dissent).toHaveLength(1);
    expect(registryOnly.dissent[0]).toMatchObject({ source: "managed-worktree-registry" });

    const ledgerOnly = projectAgentForgetPlan(facts({ ledgerWorktree: worktree, checkoutPresent: true }));
    expect(step(facts({ ledgerWorktree: worktree, checkoutPresent: true }), "remove-worktree").state).toBe("will-run");
    expect(ledgerOnly.dissent[0]?.claim).toContain("the ledger owns tachyon/reviewer");

    // 078ab8e3's `checkoutAlreadyAbsent`, projected: the step still RUNS (ownership must be
    // released) but it deletes nothing, and saying so is the difference between a human trusting
    // the receipt and a human going to look for a directory that is not there.
    const gone = projectAgentForgetPlan(facts({
      ledgerWorktree: worktree,
      checkoutPresent: false,
      registryWorktreeBranch: "tachyon/reviewer",
    }));
    const removeStep = gone.steps.find((entry) => entry.id === "remove-worktree");
    expect(removeStep).toMatchObject({ state: "will-run" });
    expect(removeStep?.detail).toContain("already gone");
    expect(gone.dissent.some((entry) => entry.source === "checkout")).toBe(true);
    expect(gone.risk.branchDeletionPlanned).toBe(false);
  });

  it("measures work at risk before the approval, and admits what it could not measure", () => {
    const risky = projectAgentForgetPlan(facts({ ledgerWorktree: worktree, checkoutPresent: true }));
    expect(risky.risk).toMatchObject({
      branch: "tachyon/reviewer",
      uncommittedChanges: 3,
      commitsAheadOfBase: 3,
      unpushedCommits: 3,
      aheadProbeFailed: false,
      branchDeletionPlanned: true,
    });
    // spec 444 — a failed `baseRef..HEAD` probe means UNKNOWN, and a confident zero here is the one
    // number that could talk somebody into deleting unmerged work.
    const unmeasured = projectAgentForgetPlan(facts({
      ledgerWorktree: { ...worktree, status: { ...worktree.status, aheadOfBase: 0, aheadProbeFailed: true } },
      checkoutPresent: true,
    }));
    expect(unmeasured.risk.aheadProbeFailed).toBe(true);
  });

  it("declares retention as the CASCADE's, derived from the transaction's one list", () => {
    // t-33ae3f keeps a single exhaustive list on the transaction. That list describes the bare
    // forget, which never removes a worktree — it refuses when one is owned. The cascade DOES remove
    // it, so repeating the list verbatim would tell a human their checkout survives on the same
    // screen that says step 2 deletes it. Derived, so neither side can drift alone.
    expect(AGENT_PROFILE_FORGET_RETAINED_BINDINGS).toContain("worktrees");
    expect(AGENT_FORGET_PLAN_RETAINED_BINDINGS).not.toContain("worktrees");
    for (const binding of AGENT_FORGET_PLAN_RETAINED_BINDINGS) {
      expect(AGENT_PROFILE_FORGET_RETAINED_BINDINGS as readonly string[]).toContain(binding);
    }
    const plan = projectAgentForgetPlan(facts());
    expect(plan.retained).toEqual([...AGENT_FORGET_PLAN_RETAINED_BINDINGS]);
    // Neither deleted nor left in place — recoverable under the retirement receipt. A human deciding
    // whether to press the button needs that before pressing it, not in the postmortem.
    expect(plan.retiredToReceipt).toContain("canonical profile tree");
    expect(plan.retiredToReceipt).toContain("activity projections");
  });
});
