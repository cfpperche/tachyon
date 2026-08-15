import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cancelSavedAgentProposal,
  listSavedAgentProposalDecisions,
  recordSavedAgentProposal,
  SAVED_AGENT_RECEIPTS_REL_DIR,
  sweepExpiredSavedAgentProposals,
} from "@tachyon/engine/agents/savedAgentProposalStore.js";
import {
  cancelSavedAgentRemovalProposal,
  listSavedAgentRemovalProposalDecisions,
  recordSavedAgentRemovalProposal,
  SAVED_AGENT_REMOVAL_RECEIPTS_REL_DIR,
  sweepExpiredSavedAgentRemovalProposals,
} from "@tachyon/engine/agents/savedAgentRemovalProposalStore.js";
import { workspaceConfigSha256 } from "@tachyon/engine/config/agentProfileGrants.js";
import { SAVED_AGENT_PROPOSAL_TTL_MS } from "@tachyon/engine/agents/savedAgentProposal.js";

/**
 * t-ea8f78 — the four terminal outcomes must be distinguishable. Live-queue-only listing
 * collapsed them all into "empty".
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-proposal-decisions-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "tachyon.yml"), "agents:\n  boss:\n    cmd: claude\n  target:\n    cmd: grok\n", "utf8");
  return dir;
}

function profile(root: string, agent: string, grants?: Record<string, unknown>): void {
  const dir = path.join(root, ".tachyon", "agents", agent);
  fs.mkdirSync(dir, { recursive: true });
  const grantBlock = grants ? `grants:\n${Object.entries(grants).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`).join("\n")}\n` : "";
  fs.writeFileSync(path.join(dir, "agent.yml"), `schemaVersion: 1\nagentId: 123e4567-e89b-42d3-a456-426614174000\nruntime:\n  adapter: claude\n${grantBlock}`);
}

describe("t-ea8f78 — create proposal outcomes are distinguishable", () => {
  it("lists approved, denied, cancelled and expired as four different answers", () => {
    const ws = workspace();
    profile(ws, "claude-runtime", { proposeSavedAgent: true });
    const roster = [{ name: "helper", kind: "agent" as const, subagents: [] }];
    const granted = { grants: { proposeSavedAgent: true } } as const;
    const base = { configSha256: "a".repeat(64) };
    const now = Date.parse("2026-07-29T00:00:00.000Z");

    const propose = (id: string, name: string) => {
      const admitted = recordSavedAgentProposal({
        workspaceRoot: ws, proposer: "claude-runtime", proposerProfile: granted,
        spec: { name, runtimeAdapter: "claude", rationale: id } as never,
        base, nowMs: now, roster, id,
      });
      if (!admitted.ok) throw new Error(`fixture ${id}: ${admitted.reason}`);
      return admitted.proposal;
    };

    const approved = propose("sp-aaa001", "approved-agent");
    const receiptDir = path.join(ws, SAVED_AGENT_RECEIPTS_REL_DIR);
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(receiptDir, `${approved.digest}.json`), JSON.stringify({
      digest: approved.digest,
      proposalId: approved.id,
      proposer: "claude-runtime",
      approvedBy: "human",
      agentName: "approved-agent",
      approvedAt: new Date(now + 1_000).toISOString(),
      outcome: "committed",
    }));
    fs.rmSync(path.join(ws, ".tachyon", "agent-proposals", `${approved.id}.json`), { force: true });

    const denied = propose("sp-ddd001", "denied-agent");
    fs.rmSync(path.join(ws, ".tachyon", "agent-proposals", `${denied.id}.json`), { force: true });
    fs.appendFileSync(path.join(ws, ".tachyon", "agent-proposals.jsonl"), `${JSON.stringify({
      kind: "denied",
      id: denied.id,
      digest: denied.digest,
      proposer: "claude-runtime",
      deniedBy: "human",
      reason: "no",
      agentName: "denied-agent",
      at: new Date(now + 2_000).toISOString(),
    })}\n`);

    const cancelled = propose("sp-ccc001", "cancelled-agent");
    cancelSavedAgentProposal({
      workspaceRoot: ws, id: cancelled.id, by: "claude-runtime", reason: "changed mind", nowMs: now + 3_000,
    });

    propose("sp-eee001", "expired-agent");
    sweepExpiredSavedAgentProposals(ws, now + SAVED_AGENT_PROPOSAL_TTL_MS + 1);

    const decided = listSavedAgentProposalDecisions(ws, now + SAVED_AGENT_PROPOSAL_TTL_MS + 1);
    const byId = Object.fromEntries(decided.map((d) => [d.id, d.outcome]));
    expect(byId["sp-aaa001"]).toBe("approved");
    expect(byId["sp-ddd001"]).toBe("denied");
    expect(byId["sp-ccc001"]).toBe("cancelled");
    expect(byId["sp-eee001"]).toBe("expired");
    expect(new Set(Object.values(byId)).size).toBe(4);
  });
});

describe("t-ea8f78 — removal proposal outcomes are distinguishable", () => {
  const AGENT_ID = "11111111-1111-4111-8111-111111111111";
  const REVISION = "rev-target";

  it("lists approved, denied, cancelled and expired as four different answers", () => {
    const ws = workspace();
    profile(ws, "boss", { proposeSavedAgent: true });
    const now = 80_000;
    const target = {
      profile: { agentId: AGENT_ID, revision: REVISION } as never,
    };

    const propose = (id: string, name: string) => {
      const admitted = recordSavedAgentRemovalProposal({
        workspaceRoot: ws, proposer: "boss", proposerProfile: { grants: { proposeSavedAgent: true } },
        spec: { name, rationale: id }, base: { configSha256: workspaceConfigSha256(ws) },
        target, nowMs: now, id,
      });
      if (!admitted.ok) throw new Error(`fixture ${id}: ${admitted.reason}`);
      return admitted.proposal;
    };

    const approved = propose("sr-aaa001", "target-a");
    const receiptDir = path.join(ws, SAVED_AGENT_REMOVAL_RECEIPTS_REL_DIR);
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(receiptDir, `${approved.digest}.json`), JSON.stringify({
      digest: approved.digest,
      proposalId: approved.id,
      proposer: "boss",
      approvedBy: "human",
      agentName: "target-a",
      approvedAt: new Date(now + 10).toISOString(),
      outcome: "committed",
    }));
    fs.rmSync(path.join(ws, ".tachyon", "agent-removal-proposals", `${approved.id}.json`), { force: true });

    const denied = propose("sr-ddd001", "target-d");
    fs.rmSync(path.join(ws, ".tachyon", "agent-removal-proposals", `${denied.id}.json`), { force: true });
    fs.appendFileSync(path.join(ws, ".tachyon", "agent-removal-proposals.jsonl"), `${JSON.stringify({
      kind: "denied",
      id: denied.id,
      digest: denied.digest,
      proposer: "boss",
      deniedBy: "human",
      reason: "keep",
      agentName: "target-d",
      at: new Date(now + 20).toISOString(),
    })}\n`);

    const cancelled = propose("sr-ccc001", "target-c");
    cancelSavedAgentRemovalProposal({
      workspaceRoot: ws, id: cancelled.id, by: "boss", reason: "changed mind", nowMs: now + 30,
    });

    propose("sr-eee001", "target-e");
    sweepExpiredSavedAgentRemovalProposals(ws, now + SAVED_AGENT_PROPOSAL_TTL_MS + 1);

    const decided = listSavedAgentRemovalProposalDecisions(ws, now + SAVED_AGENT_PROPOSAL_TTL_MS + 1);
    const byId = Object.fromEntries(decided.map((d) => [d.id, d.outcome]));
    expect(byId["sr-aaa001"]).toBe("approved");
    expect(byId["sr-ddd001"]).toBe("denied");
    expect(byId["sr-ccc001"]).toBe("cancelled");
    expect(byId["sr-eee001"]).toBe("expired");
    expect(new Set(Object.values(byId)).size).toBe(4);
  });
});
