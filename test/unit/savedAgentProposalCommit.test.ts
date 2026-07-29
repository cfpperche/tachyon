import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  approveSavedAgentProposal,
  denySavedAgentProposal,
  readSavedAgentProposalReceipt,
  type SavedAgentCommitPorts,
} from "../../src/agents/savedAgentProposalCommit.js";
import {
  listSavedAgentProposals,
  readSavedAgentProposalWitness,
  recordSavedAgentProposal,
  savedAgentProposalPath,
} from "../../src/agents/savedAgentProposalStore.js";
import { SAVED_AGENT_PROPOSAL_TTL_MS } from "../../src/agents/savedAgentProposal.js";

/**
 * SDD 482 phase 4 slice C (`t-5e1113`) — the commit path, which is the first thing in this whole
 * phase that CREATES something.
 *
 * Every assertion below is a refusal or a receipt, and that is the design: none of these failures can
 * be repaired afterwards, because a receipt does not un-create a privileged agent. So each control is
 * preventive and each is tested by making it fire, not by observing that it did not.
 */
const NOW = Date.parse("2026-07-29T00:00:00.000Z");
const CONFIG_SHA = "a".repeat(64);
const GRANTED = { grants: { proposeSavedAgent: true } } as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-proposal-commit-"));
  dirs.push(dir);
  return dir;
}

function ports(over: Partial<SavedAgentCommitPorts> = {}): SavedAgentCommitPorts & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    createSavedAgent: async (input) => {
      calls.push({ kind: "create", ...input } as unknown as Record<string, unknown>);
      return { revision: "rev-1" };
    },
    adoptSubagent: async (input) => {
      calls.push({ kind: "adopt", ...input } as unknown as Record<string, unknown>);
    },
    readProposerGrants: () => ({ proposeSavedAgent: true }),
    currentConfigSha256: () => CONFIG_SHA,
    ...over,
  };
}

/**
 * A roster in which `helper` is a free agent. Supplied because admission now validates requested
 * ownership against the spec 352 contract (SDD 482 phase 4C) — a fixture that asks for ownership with
 * no roster is REFUSED, which is the control working, not a test problem to route around.
 */
const ROSTER = [{ name: "helper", kind: "agent" as const, subagents: [] }];

function proposed(ws: string, specOver: Record<string, unknown> = {}) {
  const admitted = recordSavedAgentProposal({
    workspaceRoot: ws,
    proposer: "claude-runtime",
    proposerProfile: GRANTED,
    spec: { name: "importer", runtimeAdapter: "claude", rationale: "runs the nightly import", ...specOver } as never,
    base: { configSha256: CONFIG_SHA },
    nowMs: NOW,
    roster: ROSTER,
  });
  if (!admitted.ok) throw new Error(`fixture: ${admitted.reason}`);
  return admitted.proposal;
}

describe("approving a Saved Agent proposal (SDD 482 phase 4C)", () => {
  it("commits through the canonical transaction and writes a receipt naming both parties", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    const p = ports();
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human:cfpperche", nowMs: NOW, ports: p,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt).toMatchObject({
      outcome: "committed", operation: "create", proposer: "claude-runtime",
      approvedBy: "human:cfpperche", agentName: "importer", revision: "rev-1",
      digest: proposal.digest,
      // RATIFIED 2026-07-29: the proposer becomes the new agent's declared owner.
      owner: "claude-runtime", ownershipRecorded: true,
    });
    // Two canonical transactions, in order: create the agent, then record who owns it.
    expect(p.calls).toEqual([
      { kind: "create", agentName: "importer", spec: expect.objectContaining({ name: "importer" }) },
      { kind: "adopt", owner: "claude-runtime", child: "importer" },
    ]);
    // The proposal is consumed, and the witness records who approved it.
    expect(listSavedAgentProposals(ws)).toEqual([]);
    expect(readSavedAgentProposalWitness(ws).some((e) => e.kind === "committed")).toBe(true);
  });

  /**
   * SAVING DOES NOT START THE AGENT. Asserted structurally as well as behaviourally: there is no port
   * through which a launch could happen, so this cannot regress by someone adding a call — they would
   * have to add a dependency first, and that is a visible act.
   */
  it("refuses at admission to declare subagents — v1 has no reparenting", () => {
    const ws = workspace();
    expect(() => proposed(ws, { ownsSubagents: ["helper"] }))
      .toThrow(/proposer becomes the new agent's declared owner/);
  });

  it("never starts the agent it just saved", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    const p = ports();
    await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human", nowMs: NOW, ports: p,
    });
    expect(Object.keys(p).filter((k) => /spawn|start|launch|run/i.test(k))).toEqual([]);
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/agents/savedAgentProposalCommit.ts"), "utf8");
    expect(source).not.toMatch(/\bspawn\w*\(/);
  });

  /** An approval is bound to ONE proposal. A digest from elsewhere is not a weaker approval — it is none. */
  it("refuses an approval whose digest is not this proposal's", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    const p = ports();
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: "b".repeat(64),
      approvedBy: "human", nowMs: NOW, ports: p,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("digest_mismatch");
    expect(p.calls).toEqual([]);            // nothing was attempted
    expect(listSavedAgentProposals(ws)).toHaveLength(1); // and nothing was consumed
  });

  it("refuses an expired proposal even though a human just approved it", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    const p = ports();
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human", nowMs: NOW + SAVED_AGENT_PROPOSAL_TTL_MS, ports: p,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("expired");
    expect(p.calls).toEqual([]);
  });

  /**
   * CAS. The proposal describes a roster; if that roster moved, what the human reviewed is not what
   * would be committed. The answer is a fresh proposal, never a hopeful merge.
   */
  it("refuses when the config moved under the proposal", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    const p = ports({ currentConfigSha256: () => "c".repeat(64) });
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human", nowMs: NOW, ports: p,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("base_diverged");
      expect(result.reason).toContain("ask for a fresh proposal");
    }
    expect(p.calls).toEqual([]);
  });

  /**
   * REVOCATION. A human who removes the capability has decided this agent may not create agents; a
   * proposal queued before that decision is exactly where the old answer would otherwise survive.
   */
  it("refuses a proposal whose proposer lost the capability after proposing", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    const p = ports({ readProposerGrants: () => ({}) });
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human", nowMs: NOW, ports: p,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("proposer_grant_revoked");
    expect(p.calls).toEqual([]);
    // The proposal survives: a revoked grant is not a reason to destroy the record of what was asked.
    expect(listSavedAgentProposals(ws)).toHaveLength(1);
  });

  /**
   * Invariant 9's SECOND enforcement point. Admission refuses the request; this refuses to honour one
   * that reached the store by any other route — a file written directly, a future caller, a bug.
   */
  it("refuses at commit to create an agent that would itself be a creator", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    // Write the recursive grant straight into the stored file and re-seal it, simulating a path that
    // never went through admission.
    const file = savedAgentProposalPath(ws, proposal.id);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const spec = { ...(record.spec as Record<string, unknown>), grants: { proposeSavedAgent: true } };
    const { computeSavedAgentProposalDigest } = await import("../../src/agents/savedAgentProposal.js");
    const digest = computeSavedAgentProposalDigest({ proposer: record.proposer as string, spec: spec as never, base: record.base as never });
    fs.writeFileSync(file, JSON.stringify({ ...record, spec, digest }), "utf8");

    const p = ports();
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: digest,
      approvedBy: "human", nowMs: NOW, ports: p,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("capability_recursion");
    expect(p.calls).toEqual([]);
  });

  /**
   * The rule this slice discovered in the canonical path rather than invented: a NEW canonical profile
   * "cannot select capability references before host authorization" — `createProfileFromStudioMutation`
   * refuses them outright. A human using Agent Studio cannot grant skills/MCP/hooks at creation, so a
   * proposal must not either. Carrying them would make this a second write path with MORE authority
   * than the first, which is precisely what reusing the canonical transaction exists to prevent.
   */
  /**
   * The capability rule is no longer re-implemented here at all — the commit hands the spec to the
   * CANONICAL Studio create, which is the thing that refuses capability references. This test now
   * pins that inheritance rather than a local copy of the rule.
   */
  it("verifies the capability rule against the canonical helper, which now owns it", async () => {
    const { createProfileFromStudioMutation } = await import("../../src/config/agentProfileStudio.js");
    // The exact refusal this module defers to. If the canonical rule ever relaxes, this fails and the
    // drop above becomes a deliberate re-decision instead of stale caution.
    expect(() => createProfileFromStudioMutation({
      schemaVersion: 1,
      kind: "canonical",
      agentName: "importer",
      editable: {
        displayName: "",
        runtime: { adapter: "claude", executable: "claude" },
        role: "",
        cwd: "",
        lifecycle: { autostart: false, restart: "never", attention: true, watch: [] },
        worktree: { enabled: false, branch: "" },
        isolation: "",
        capabilities: { skills: ["review"], mcp: [], hooks: [] },
      },
    } as never)).toThrow(/cannot select capability references before host authorization/);
  });

  /** IDEMPOTENCY. A retry, a double-click or a re-delivered host event converges on one create. */
  it("converges on the existing receipt instead of committing twice", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    const p = ports();
    const args = {
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human", nowMs: NOW, ports: p,
    };
    const first = await approveSavedAgentProposal(args);
    const second = await approveSavedAgentProposal(args);
    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.alreadyCommitted).toBe(true);
    expect(second.receipt.revision).toBe("rev-1");
    expect(p.calls).toHaveLength(2); // create + adopt, each exactly once
  });

  /**
   * COMPENSATION at this layer. The canonical transaction compensates its own durable state; what
   * this must not do is leave a receipt claiming an in-flight commit that already ended.
   */
  it("records a failed commit instead of leaving the receipt saying 'committing'", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    const p = ports({ createSavedAgent: async () => { throw new Error("authority changed outside lifecycle transaction"); } });
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human", nowMs: NOW, ports: p,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("commit_failed");

    const receipt = readSavedAgentProposalReceipt(ws, proposal.digest);
    expect(receipt?.outcome).toBe("failed");
    expect(receipt?.reason).toContain("authority changed");
    // The proposal is still there, so the human can retry or deny with the record intact.
    expect(listSavedAgentProposals(ws)).toHaveLength(1);
  });

  it("writes the intent receipt BEFORE the transaction, so a crash is attributable", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    let seenDuringCommit: string | undefined;
    const p = ports({
      createSavedAgent: async () => {
        seenDuringCommit = readSavedAgentProposalReceipt(ws, proposal.digest)?.outcome;
        return { revision: "rev-1" };
      },
    });
    await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human", nowMs: NOW, ports: p,
    });
    // Had the process died inside the transaction, this is what recovery would find on disk.
    expect(seenDuringCommit).toBe("committing");
  });

  /**
   * The two-transaction window, which is the honest cost of the ratified model: the lifecycle
   * transaction is per-agent, so creating the agent and recording its owner cannot be one commit.
   * A crash between them must be RESUMABLE and must never read as success.
   */
  it("records the agent as created-but-unowned when ownership fails, instead of claiming success", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    const p = ports({ adoptSubagent: async () => { throw new Error("profile revision conflict"); } });
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human", nowMs: NOW, ports: p,
    });
    expect(result.ok).toBe(false);
    const receipt = readSavedAgentProposalReceipt(ws, proposal.digest);
    expect(receipt?.outcome).toBe("failed");
    expect(receipt?.ownershipRecorded).toBeUndefined();
    // The agent really does exist; the receipt says so rather than implying a rollback that did not
    // happen, and it says how to finish.
    expect(receipt?.revision).toBe("rev-1");
    expect(receipt?.reason).toContain("created but ownership was not recorded");
  });

  it("RESUMES a half-finished approval instead of re-creating the agent", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    const failing = ports({ adoptSubagent: async () => { throw new Error("transient"); } });
    await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human", nowMs: NOW, ports: failing,
    });

    // Second attempt, this time with a working ownership port. Re-creating would fail with "already
    // has canonical state" and strand a real agent behind a confusing error.
    const p = ports();
    const retry = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human", nowMs: NOW, ports: p,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.receipt.ownershipRecorded).toBe(true);
    expect(p.calls.map((c) => c.kind)).toEqual(["adopt"]); // no second create
  });

  it("refuses an unknown proposal without touching anything", async () => {
    const ws = workspace();
    const p = ports();
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: "sp-aaaaaa", approvedDigest: "d".repeat(64),
      approvedBy: "human", nowMs: NOW, ports: p,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_found");
    expect(p.calls).toEqual([]);
  });
});

describe("denying a Saved Agent proposal (SDD 482 phase 4C)", () => {
  it("removes the proposal and records who decided", () => {
    const ws = workspace();
    const proposal = proposed(ws);
    expect(denySavedAgentProposal({ workspaceRoot: ws, proposalId: proposal.id, deniedBy: "human", reason: "wrong runtime", nowMs: NOW }))
      .toEqual({ denied: true });
    expect(listSavedAgentProposals(ws)).toEqual([]);
    const cancelled = readSavedAgentProposalWitness(ws).find((e) => e.kind === "cancelled") as { reason: string } | undefined;
    expect(cancelled?.reason).toContain("denied by human: wrong runtime");
  });

  it("converges when the proposal is already gone", () => {
    const ws = workspace();
    expect(denySavedAgentProposal({ workspaceRoot: ws, proposalId: "sp-aaaaaa", deniedBy: "human", reason: "n/a", nowMs: NOW }))
      .toEqual({ denied: false });
  });
});

/**
 * The approval is a HOST action. An agent that could reach it would make every control above
 * decorative, so this asserts the absence of the wiring rather than trusting that nobody adds it.
 */
describe("approval is unreachable from the Bridge (SDD 482 phase 4C)", () => {
  it("no Bridge tool references the commit path", () => {
    const tools = fs.readFileSync(path.resolve(__dirname, "../../src/bridge/tools.ts"), "utf8");
    expect(tools).not.toContain("approveSavedAgentProposal");
    expect(tools).not.toContain("savedAgentProposalCommit");
    expect(tools).not.toContain("denySavedAgentProposal");
  });
});

/**
 * SDD 482 phase 4C — the shipped deployment is REVIEW-ONLY, and that is a declared product state
 * rather than an unfinished edge.
 *
 * `claude-reviewer` named the failure mode this guards: an optional dependency nobody declares is a
 * silent gap, not staging. So the absence is asserted, with the reason attached — if someone supplies
 * the port, this test fails and they must update the spec's deployment table in the same change
 * instead of quietly opening the door.
 */
/**
 * SDD 482 phase 4C — the door is wired, and wired onto seams that already exist.
 *
 * The earlier delivery left the port unsupplied because `WorkspaceShellHandle` exposes no `create`.
 * That reading was incomplete: `commitAgentProfileStudio` with no `expectedRevision` IS the canonical
 * create and already crosses the engine/shell seam, and `set-subagents` crosses it too. So the door
 * opens on paths a human already uses — no new operation, no protocol bump.
 */
describe("the commit port is wired on existing seams (SDD 482 phase 4C)", () => {
  const extension = fs.readFileSync(path.resolve(__dirname, "../../src/extension.ts"), "utf8");

  it("supplies the port from the extension host, and nowhere else", () => {
    expect(extension).toMatch(/approveSavedAgentProposal:\s*async/);
  });

  it("creates through the canonical Studio commit rather than a new operation", () => {
    expect(extension).toContain("ws.commitAgentProfileStudio(");
    expect(extension).toContain("operation: \"set-subagents\"");
    // No engine protocol surface was added to open this door.
    expect(extension).not.toContain("savedAgentProposal.approve");
  });

  it("asks for no capability references, leaving that refusal to the canonical validator", () => {
    expect(extension).toMatch(/capabilities: \{ skills: \[\], mcp: \[\], hooks: \[\] \}/);
  });

  it("adds to the owner's existing subagents instead of replacing them", () => {
    // `set-subagents` is a whole-list write, so reading first is what keeps it from being a reset.
    expect(extension).toContain("ws.agentOwnershipView(owner)");
    expect(extension).toMatch(/new Set\(\[\.\.\.view\.subagents, child\]\)/);
  });

  it("keeps the spec's deployment table honest about the change", () => {
    const spec = fs.readFileSync(
      path.resolve(__dirname, "../../docs/specs/482-unified-agent-instance/spec.md"),
      "utf8",
    );
    expect(spec).toContain("Where the creation door is open today");
    expect(spec).toMatch(/VS Code extension as shipped.*yes/);
  });
});
