import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  admitSavedAgentRemovalProposal,
  computeSavedAgentRemovalProposalDigest,
} from "@tachyon/engine/agents/savedAgentRemovalProposal.js";
import {
  cancelSavedAgentRemovalProposal,
  listLiveSavedAgentRemovalProposals,
  readSavedAgentRemovalProposal,
  recordSavedAgentRemovalProposal,
  readSavedAgentRemovalProposalWitness,
} from "@tachyon/engine/agents/savedAgentRemovalProposalStore.js";
import {
  approveSavedAgentRemovalProposal,
  denySavedAgentRemovalProposal,
  readSavedAgentRemovalProposalReceipt,
} from "../../apps/vscode-extension/src/agents/savedAgentRemovalProposalCommit.js";
import { buildSavedAgentRemovalProposalReview } from "../../apps/vscode-extension/src/agents/savedAgentRemovalProposalReview";
import { registerTools, type BridgeDeps } from "@tachyon/bridge/tools.js";
import { readAgentProfileGrants, workspaceConfigSha256 } from "@tachyon/engine/config/agentProfileGrants.js";
import { buildHumanInbox, humanInboxCounts } from "@tachyon/webview-ui/humanInbox/model";

/**
 * t-afe120 — governed Saved Agent removal proposals.
 *
 * Fail-before cases (grant absent, self-removal, missing target, temporary target, digest mismatch,
 * cascade refusal leaves durable state untouched) are the load-bearing guards. Happy-path commit is
 * proven through injected ports so this suite cannot invent a second write path.
 */

type ToolHandler = (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-removal-proposal-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "tachyon.yml"), "agents:\n  boss:\n    cmd: claude\n  target:\n    cmd: grok\n", "utf8");
  return dir;
}

function profile(root: string, agent: string, grants?: Record<string, unknown>): void {
  const dir = path.join(root, ".tachyon", "agents", agent);
  fs.mkdirSync(dir, { recursive: true });
  const doc = [
    "schemaVersion: 1",
    "agentId: 11111111-1111-4111-8111-111111111111",
    "runtime:",
    "  adapter: claude",
    "  executable: claude",
    ...(grants ? ["grants:", ...Object.entries(grants).map(([k, v]) => `  ${k}: ${String(v)}`)] : []),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "agent.yml"), doc, "utf8");
}

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const REVISION = "a".repeat(64);

function base(root: string) {
  return { configSha256: workspaceConfigSha256(root) };
}

function targetFacts(ok = true) {
  return ok ? { profile: { agentId: AGENT_ID, revision: REVISION } } : {};
}

describe("admitSavedAgentRemovalProposal — fail-before", () => {
  it("refuses when grants.proposeSavedAgent is absent", () => {
    const admission = admitSavedAgentRemovalProposal({
      proposer: "boss",
      proposerProfile: { grants: {} },
      spec: { name: "target", rationale: "done" },
      base: { configSha256: "abc" },
      target: targetFacts(),
      pending: [],
      nowMs: 1_000,
      id: "sr-aaaaaa",
    });
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.code).toBe("capability_absent");
  });

  it("refuses self-removal", () => {
    const admission = admitSavedAgentRemovalProposal({
      proposer: "boss",
      proposerProfile: { grants: { proposeSavedAgent: true } },
      spec: { name: "boss", rationale: "retire me" },
      base: { configSha256: "abc" },
      target: targetFacts(),
      pending: [],
      nowMs: 1_000,
      id: "sr-bbbbbb",
    });
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.code).toBe("self_removal");
  });

  it("refuses a Temporary target by name", () => {
    const admission = admitSavedAgentRemovalProposal({
      proposer: "boss",
      proposerProfile: { grants: { proposeSavedAgent: true } },
      spec: { name: "temp-child", rationale: "cleanup" },
      base: { configSha256: "abc" },
      target: { temporary: true },
      pending: [],
      nowMs: 1_000,
      id: "sr-cccccc",
    });
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.code).toBe("target_not_saved");
    expect(admission.reason).toContain("dismiss_agent");
  });

  it("refuses a missing Saved Agent", () => {
    const admission = admitSavedAgentRemovalProposal({
      proposer: "boss",
      proposerProfile: { grants: { proposeSavedAgent: true } },
      spec: { name: "ghost", rationale: "cleanup" },
      base: { configSha256: "abc" },
      target: {},
      pending: [],
      nowMs: 1_000,
      id: "sr-dddddd",
    });
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.code).toBe("target_missing");
  });

  it("admits a grant-holding proposer against a live profile target", () => {
    const admission = admitSavedAgentRemovalProposal({
      proposer: "boss",
      proposerProfile: { grants: { proposeSavedAgent: true } },
      spec: { name: "target", rationale: "no longer needed" },
      base: { configSha256: "abc" },
      target: targetFacts(),
      pending: [],
      nowMs: 1_000,
      id: "sr-eeeeee",
    });
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;
    expect(admission.proposal.base.agentId).toBe(AGENT_ID);
    expect(admission.proposal.base.profileRevision).toBe(REVISION);
    expect(admission.proposal.digest).toBe(
      computeSavedAgentRemovalProposalDigest({
        proposer: "boss",
        spec: admission.proposal.spec,
        base: admission.proposal.base,
      }),
    );
  });
});

describe("store + commit — digest bind and fail-closed cascade", () => {
  it("records, collapses identical re-proposals, and cancels by proposer only", () => {
    const root = workspace();
    profile(root, "boss", { proposeSavedAgent: true });
    const first = recordSavedAgentRemovalProposal({
      workspaceRoot: root,
      proposer: "boss",
      proposerProfile: { grants: readAgentProfileGrants(root, "boss") },
      spec: { name: "target", rationale: "retire" },
      base: base(root),
      target: targetFacts(),
      nowMs: 10_000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = recordSavedAgentRemovalProposal({
      workspaceRoot: root,
      proposer: "boss",
      proposerProfile: { grants: { proposeSavedAgent: true } },
      spec: { name: "target", rationale: "retire" },
      base: base(root),
      target: targetFacts(),
      nowMs: 11_000,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.collapsedOnto).toBe(first.proposal.id);
    expect(listLiveSavedAgentRemovalProposals(root, 12_000)).toHaveLength(1);

    expect(() =>
      cancelSavedAgentRemovalProposal({
        workspaceRoot: root,
        id: first.proposal.id,
        by: "other",
        reason: "nope",
        nowMs: 13_000,
      }),
    ).toThrow(/cannot cancel/);

    const cancelled = cancelSavedAgentRemovalProposal({
      workspaceRoot: root,
      id: first.proposal.id,
      by: "boss",
      reason: "changed mind",
      nowMs: 14_000,
    });
    expect(cancelled.cancelled).toBe(true);
    expect(listLiveSavedAgentRemovalProposals(root, 15_000)).toHaveLength(0);
  });

  it("approves through the cascade port and leaves a committed receipt", async () => {
    const root = workspace();
    profile(root, "boss", { proposeSavedAgent: true });
    const recorded = recordSavedAgentRemovalProposal({
      workspaceRoot: root,
      proposer: "boss",
      proposerProfile: { grants: { proposeSavedAgent: true } },
      spec: { name: "target", rationale: "retire" },
      base: base(root),
      target: targetFacts(),
      nowMs: 20_000,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    let forgot: { agentName: string; expectedRevision: string } | undefined;
    const result = await approveSavedAgentRemovalProposal({
      workspaceRoot: root,
      proposalId: recorded.proposal.id,
      approvedDigest: recorded.proposal.digest,
      approvedBy: "human",
      nowMs: 21_000,
      ports: {
        forgetSavedAgent: async (input) => {
          forgot = input;
          return { txid: "tx-1", revision: input.expectedRevision };
        },
        readTargetIdentity: async () => ({ agentId: AGENT_ID, revision: REVISION }),
        readProposerGrants: () => ({ proposeSavedAgent: true }),
        currentConfigSha256: () => workspaceConfigSha256(root),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(forgot).toEqual({ agentName: "target", expectedRevision: REVISION });
    expect(result.receipt.outcome).toBe("committed");
    expect(result.receipt.operation).toBe("remove");
    expect(result.receipt.removed).toContain("session stopped");
    expect(readSavedAgentRemovalProposalReceipt(root, recorded.proposal.digest)?.outcome).toBe("committed");
    expect(listLiveSavedAgentRemovalProposals(root, 22_000)).toHaveLength(0);
    expect(readSavedAgentRemovalProposalWitness(root).some((e) => e.kind === "committed")).toBe(true);
  });

  it("FAIL-CLOSED: cascade refusal leaves proposal, profile facts, and no committed receipt", async () => {
    const root = workspace();
    profile(root, "boss", { proposeSavedAgent: true });
    profile(root, "target");
    // Durable marker the cascade must not touch on refusal.
    const marker = path.join(root, ".tachyon", "agents", "target", "agent.yml");
    const before = fs.readFileSync(marker, "utf8");
    const ymlBefore = fs.readFileSync(path.join(root, "tachyon.yml"), "utf8");

    const recorded = recordSavedAgentRemovalProposal({
      workspaceRoot: root,
      proposer: "boss",
      proposerProfile: { grants: { proposeSavedAgent: true } },
      spec: { name: "target", rationale: "retire" },
      base: base(root),
      target: targetFacts(),
      nowMs: 30_000,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const result = await approveSavedAgentRemovalProposal({
      workspaceRoot: root,
      proposalId: recorded.proposal.id,
      approvedDigest: recorded.proposal.digest,
      approvedBy: "human",
      nowMs: 31_000,
      ports: {
        forgetSavedAgent: async () => {
          throw new Error("agent-profile/forget-worktree-owned: still owns a worktree");
        },
        readTargetIdentity: async () => ({ agentId: AGENT_ID, revision: REVISION }),
        readProposerGrants: () => ({ proposeSavedAgent: true }),
        currentConfigSha256: () => workspaceConfigSha256(root),
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("commit_failed");
    // Proposal still pending for retry/deny.
    expect(readSavedAgentRemovalProposal(root, recorded.proposal.id).id).toBe(recorded.proposal.id);
    // Nothing durable moved.
    expect(fs.readFileSync(marker, "utf8")).toBe(before);
    expect(fs.readFileSync(path.join(root, "tachyon.yml"), "utf8")).toBe(ymlBefore);
    expect(readSavedAgentRemovalProposalReceipt(root, recorded.proposal.digest)?.outcome).toBe("failed");
  });

  it("refuses digest mismatch and identity divergence without calling the cascade", async () => {
    const root = workspace();
    profile(root, "boss", { proposeSavedAgent: true });
    const recorded = recordSavedAgentRemovalProposal({
      workspaceRoot: root,
      proposer: "boss",
      proposerProfile: { grants: { proposeSavedAgent: true } },
      spec: { name: "target", rationale: "retire" },
      base: base(root),
      target: targetFacts(),
      nowMs: 40_000,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    let called = 0;
    const ports = {
      forgetSavedAgent: async () => {
        called += 1;
        return { txid: "x", revision: REVISION };
      },
      readTargetIdentity: async () => ({ agentId: AGENT_ID, revision: REVISION }),
      readProposerGrants: () => ({ proposeSavedAgent: true as const }),
      currentConfigSha256: () => workspaceConfigSha256(root),
    };

    const badDigest = await approveSavedAgentRemovalProposal({
      workspaceRoot: root,
      proposalId: recorded.proposal.id,
      approvedDigest: "0".repeat(64),
      approvedBy: "human",
      nowMs: 41_000,
      ports,
    });
    expect(badDigest.ok).toBe(false);
    if (!badDigest.ok) expect(badDigest.code).toBe("digest_mismatch");
    expect(called).toBe(0);

    const identity = await approveSavedAgentRemovalProposal({
      workspaceRoot: root,
      proposalId: recorded.proposal.id,
      approvedDigest: recorded.proposal.digest,
      approvedBy: "human",
      nowMs: 42_000,
      ports: {
        ...ports,
        readTargetIdentity: async () => ({ agentId: "22222222-2222-4222-8222-222222222222", revision: REVISION }),
      },
    });
    expect(identity.ok).toBe(false);
    if (!identity.ok) expect(identity.code).toBe("identity_diverged");
    expect(called).toBe(0);
  });

  it("deny withdraws without cascading", async () => {
    const root = workspace();
    profile(root, "boss", { proposeSavedAgent: true });
    const recorded = recordSavedAgentRemovalProposal({
      workspaceRoot: root,
      proposer: "boss",
      proposerProfile: { grants: { proposeSavedAgent: true } },
      spec: { name: "target", rationale: "retire" },
      base: base(root),
      target: targetFacts(),
      nowMs: 50_000,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const denied = await denySavedAgentRemovalProposal({
      workspaceRoot: root,
      proposalId: recorded.proposal.id,
      deniedBy: "human",
      reason: "keep it",
      nowMs: 51_000,
    });
    expect(denied.denied).toBe(true);
    expect(listLiveSavedAgentRemovalProposals(root, 52_000)).toHaveLength(0);
  });

  it("t-ea8f78 — approve delivers a notice that names the outcome", async () => {
    const root = workspace();
    profile(root, "boss", { proposeSavedAgent: true });
    const recorded = recordSavedAgentRemovalProposal({
      workspaceRoot: root,
      proposer: "boss",
      proposerProfile: { grants: { proposeSavedAgent: true } },
      spec: { name: "target", rationale: "retire" },
      base: base(root),
      target: targetFacts(),
      nowMs: 60_000,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const notices: Array<{ agent: string; line: string }> = [];
    const result = await approveSavedAgentRemovalProposal({
      workspaceRoot: root,
      proposalId: recorded.proposal.id,
      approvedDigest: recorded.proposal.digest,
      approvedBy: "human",
      nowMs: 61_000,
      ports: {
        forgetSavedAgent: async (input) => ({ txid: "tx-1", revision: input.expectedRevision }),
        readTargetIdentity: async () => ({ agentId: AGENT_ID, revision: REVISION }),
        readProposerGrants: () => ({ proposeSavedAgent: true }),
        currentConfigSha256: () => workspaceConfigSha256(root),
        deliverNotice: async (agent, line) => { notices.push({ agent, line }); },
      },
    });
    expect(result.ok).toBe(true);
    expect(notices).toEqual([{
      agent: "boss",
      line: `[tachyon] Saved Agent proposal ${recorded.proposal.id} to retire 'target' was approved`,
    }]);
  });

  it("t-ea8f78 — deny delivers a notice that names the outcome", async () => {
    const root = workspace();
    profile(root, "boss", { proposeSavedAgent: true });
    const recorded = recordSavedAgentRemovalProposal({
      workspaceRoot: root,
      proposer: "boss",
      proposerProfile: { grants: { proposeSavedAgent: true } },
      spec: { name: "target", rationale: "retire" },
      base: base(root),
      target: targetFacts(),
      nowMs: 70_000,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const notices: Array<{ agent: string; line: string }> = [];
    await denySavedAgentRemovalProposal({
      workspaceRoot: root,
      proposalId: recorded.proposal.id,
      deniedBy: "human",
      reason: "keep it",
      nowMs: 71_000,
      deliverNotice: async (agent, line) => { notices.push({ agent, line }); },
    });
    expect(notices).toEqual([{
      agent: "boss",
      line: `[tachyon] Saved Agent proposal ${recorded.proposal.id} to retire 'target' was denied`,
    }]);
  });
});

describe("Bridge tools — identity and grant", () => {
  function harness(root: string, caller: BridgeDeps["caller"], extras: Partial<BridgeDeps> = {}) {
    const tools = new Map<string, { handler: ToolHandler }>();
    const mcp = {
      registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
        tools.set(name, { handler });
      },
    };
    registerTools(mcp as never, {
      workspaceRoot: root,
      manager: {
        list: async () => [
          { name: "boss", kind: "agent", lifetime: "saved", running: true },
          { name: "target", kind: "agent", lifetime: "saved", running: false },
          { name: "temp", kind: "agent", lifetime: "temporary", running: false },
        ],
        session: () => "sess",
      },
      caller,
      inspectSavedAgentProfile: async (name: string) =>
        name === "target" ? { agentId: AGENT_ID, revision: REVISION } : undefined,
      ...extras,
    } as unknown as BridgeDeps);
    return tools;
  }

  it("refuses non-agent callers and absent grants", async () => {
    const root = workspace();
    profile(root, "boss");
    const tools = harness(root, { kind: "legacy" });
    const propose = tools.get("propose_saved_agent_removal")!.handler;
    const legacy = await propose({ name: "target", rationale: "x" });
    expect(legacy.isError).toBe(true);
    expect(legacy.content[0]!.text).toContain("CALLER_REQUIRED");

    const agentTools = harness(root, { kind: "agent", name: "boss" });
    const noGrant = await agentTools.get("propose_saved_agent_removal")!.handler({ name: "target", rationale: "x" });
    expect(noGrant.isError).toBe(true);
    expect(noGrant.content[0]!.text).toContain("capability_absent");
  });

  it("proposes when grant holds and target is profile-backed; lists and cancels", async () => {
    const root = workspace();
    profile(root, "boss", { proposeSavedAgent: true });
    const tools = harness(root, { kind: "agent", name: "boss" });
    const propose = tools.get("propose_saved_agent_removal")!.handler;
    const ok = await propose({ name: "target", rationale: "no longer needed" });
    expect(ok.isError).toBeFalsy();
    const body = JSON.parse(ok.content[0]!.text) as { id: string; digest: string; state: string };
    expect(body.id).toMatch(/^sr-[0-9a-f]{6}$/);
    expect(body.state).toContain("pending human review");

    const listed = await tools.get("list_saved_agent_removal_proposals")!.handler({});
    expect(listed.isError).toBeFalsy();
    const queue = JSON.parse(listed.content[0]!.text) as { proposals: Array<{ id: string }> };
    expect(queue.proposals).toHaveLength(1);

    const cancelled = await tools.get("cancel_saved_agent_removal_proposal")!.handler({
      id: body.id,
      reason: "n/m",
    });
    expect(cancelled.isError).toBeFalsy();
    expect(cancelled.content[0]!.text).toContain("cancelled");
  });

  it("dismiss_agent still refuses Saved Agents and names the new door", async () => {
    const root = workspace();
    const tools = harness(root, { kind: "agent", name: "boss" });
    const dismiss = tools.get("dismiss_agent")!.handler;
    const result = await dismiss({ name: "target" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("cannot be dismissed");
    expect(result.content[0]!.text).toContain("propose_saved_agent_removal");
  });
});

describe("Human Inbox projection", () => {
  it("surfaces a removal proposal as its own kind with danger list", () => {
    const proposal = {
      id: "sr-abcdef",
      proposer: "boss",
      proposerKind: "agent" as const,
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      spec: { name: "target", rationale: "cleanup after dogfood" },
      base: { configSha256: "c".repeat(64), profileRevision: REVISION, agentId: AGENT_ID },
      digest: "d".repeat(64),
    };
    const review = buildSavedAgentRemovalProposalReview({
      proposal,
      currentConfigSha256: "c".repeat(64),
      nowMs: Date.now(),
    });
    expect(review.dangerous.length).toBeGreaterThan(0);
    expect(review.affected.some((a) => a.includes("worktree"))).toBe(true);

    const items = buildHumanInbox({
      wsHash: "ws",
      folder: "tachyon",
      approvals: [],
      validations: [],
      savedAgentRemovals: [review],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("saved-agent-removal");
    expect(items[0]!.title).toContain("retire Saved Agent");
    expect(humanInboxCounts(items)).toMatchObject({
      total: 1,
      savedAgentRemovals: 1,
      savedAgentProposals: 0,
    });
  });
});

// Silence unused crypto import if tree-shaken paths change.
void crypto;
