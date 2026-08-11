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
import {
  savedAgentCreateMutation, SAVED_AGENT_PROPOSAL_TTL_MS } from "../../src/agents/savedAgentProposal.js";
import { extensionCommandSchema } from "../../src/runtime-api/extensionOperations.js";

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
      return { revision: "rev-1", txid: "tx-1" };
    },
    readProposerGrants: () => ({ proposeSavedAgent: true }),
    authorizeSkill: async (input) => {
      calls.push({ kind: "authorize-skill", ...input } as unknown as Record<string, unknown>);
      return { ok: true };
    },
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
      approvedBy: "human:cfpperche", agentName: "importer", revision: "rev-1", txid: "tx-1",
      digest: proposal.digest,
      // RATIFIED 2026-07-29: the proposer becomes the new agent's declared owner, in the SAME
      // transaction — so both authority records carry `lifecycle-tx-1`.
      owner: "claude-runtime",
      // t-ca9086: approval creates enabled; start stays separate.
      created: "enabled; not started",
      // t-4071e4: the receipt records WHICH checkout was authorized. The commit deletes the proposal,
      // so without this the durable record could not answer whether the human let this agent into
      // their working tree.
      workspace: "isolated worktree",
    });
    // ONE canonical transaction carrying both subjects.
    expect(p.calls).toEqual([
      { kind: "create", agentName: "importer", owner: "claude-runtime", spec: expect.objectContaining({ name: "importer" }) },
    ]);
    // The proposal is consumed, and the witness records who approved it.
    expect(listSavedAgentProposals(ws)).toEqual([]);
    expect(readSavedAgentProposalWitness(ws).some((e) => e.kind === "committed")).toBe(true);
  });

  /**
   * t-5498a6 — CALLER A. A proposal's `capabilities.skills` is a REQUEST that grants nothing; these
   * hold the human's answer to it, and that only what they ticked is authorized.
   */
  it("authorizes only the skills the human ticked, after the agent exists", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    const p = ports();
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human:cfpperche", nowMs: NOW, authorizeSkills: ["visual-qa"], ports: p,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.authorizedSkills).toEqual(["visual-qa"]);
    expect(result.receipt.refusedSkills).toBeUndefined();
    // Ordering is load-bearing: the canonical create refuses to select capability references before
    // host authorization, so the agent has to exist before anything can be granted to it.
    const kinds = p.calls.map((call) => call.kind);
    expect(kinds).toEqual(["create", "authorize-skill"]);
    expect(p.calls[1]).toMatchObject({ agentName: "importer", skillName: "visual-qa" });
  });

  it("grants nothing when the human ticked nothing, which is what every approval did before", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    const p = ports();
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human:cfpperche", nowMs: NOW, ports: p,
    });

    expect(result.ok && result.receipt.authorizedSkills).toBeUndefined();
    expect(p.calls.map((call) => call.kind)).toEqual(["create"]);
  });

  it("RECORDS a refused skill instead of undoing an approval that already landed", async () => {
    // The agent was created by a decision the human made. Throwing here would discard it because one
    // capability could not be granted, so the refusal becomes a fact on the receipt instead.
    const ws = workspace();
    const proposal = proposed(ws);
    const p = ports({
      authorizeSkill: async () => ({ ok: false, error: "plugin 'product-foundation@0.1.1' does not declare runtime 'codex'" }),
    });
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human:cfpperche", nowMs: NOW, authorizeSkills: ["product-foundation"], ports: p,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.outcome).toBe("committed");
    expect(result.receipt.authorizedSkills).toBeUndefined();
    expect(result.receipt.refusedSkills).toEqual([
      "product-foundation: plugin 'product-foundation@0.1.1' does not declare runtime 'codex'",
    ]);
  });

  it("creates a top-level agent without writing an owner edge", async () => {
    const ws = workspace();
    const proposal = proposed(ws, { ownership: "top-level" });
    const p = ports();
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws,
      proposalId: proposal.id,
      approvedDigest: proposal.digest,
      approvedBy: "human",
      nowMs: NOW,
      ports: p,
    });
    expect(result.ok).toBe(true);
    expect(p.calls[0]).not.toHaveProperty("owner");
    if (result.ok) expect(result.receipt).not.toHaveProperty("owner");
  });

  it("records the shared checkout in the receipt when the proposal opted out of isolation", async () => {
    const ws = workspace();
    const proposal = proposed(ws, { workspace: { worktree: false } });
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human:cfpperche", nowMs: NOW, ports: ports(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Read from the same predicate the review pane used, so the receipt cannot claim isolation the
    // human was never shown — and cannot claim it for the one case where it did not happen.
    expect(result.receipt.workspace).toBe("shared checkout");
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

  it("passes the exact human-approved creation grant to the canonical transaction", async () => {
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
    expect(result.ok).toBe(true);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]).toMatchObject({ grants: { proposeSavedAgent: true } });
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
  /**
   * t-ca9086 — "created enabled; not started" as a property of the DATA, pinned where it lives.
   *
   * Human dogfood on 0.56.116: approve created `lifecycle.enabled=false`, so Fleet start was refused
   * until a second Studio visit. Approval now authorizes existence AND enablement; start remains a
   * separate action (no autostart written, no spawn port on this path).
   */
  it("creates the agent ENABLED without autostart, asserted through the canonical helper (t-ca9086)", async () => {
    const { createProfileFromStudioMutation } = await import("../../src/config/agentProfileStudio.js");
    // Exactly what the extension's port sends for Approve and create.
    const profile = createProfileFromStudioMutation({
      schemaVersion: 1,
      kind: "agent-instance",
      agentName: "importer",
      editable: {
        displayName: "",
        runtime: { adapter: "claude", executable: "claude" },
        cwd: "",
        lifecycle: { autostart: false, restart: "never", attention: true },
        worktree: { enabled: false, branch: "", setup: [] },
        instructions: "",
        isolation: "",
        capabilities: { skills: [], mcp: [], hooks: [] },
      },
    } as never);
    expect(profile.lifecycle?.enabled).toBe(true);
    expect(profile.lifecycle?.autostart).toBeUndefined(); // nothing starts it on the next load either
  });

  it("receipt declares created enabled; not started, and the create port never spawns (t-ca9086)", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    const p = ports();
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human", nowMs: NOW, ports: p,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.created).toBe("enabled; not started");
    // Durable on disk so reload/replay cannot lose the declaration.
    expect(readSavedAgentProposalReceipt(ws, proposal.digest)?.created).toBe("enabled; not started");
    // The commit port only creates; there is no start/spawn call shape on this surface.
    expect(p.calls.every((call) => call.kind === "create")).toBe(true);
    expect(p.calls.some((call) => "spawn" in call || call.kind === "start")).toBe(false);
  });

  it("verifies the capability rule against the canonical helper, which now owns it", async () => {
    const { createProfileFromStudioMutation } = await import("../../src/config/agentProfileStudio.js");
    // The exact refusal this module defers to. If the canonical rule ever relaxes, this fails and the
    // drop above becomes a deliberate re-decision instead of stale caution.
    expect(() => createProfileFromStudioMutation({
      schemaVersion: 1,
      kind: "agent-instance",
      agentName: "importer",
      editable: {
        displayName: "",
        runtime: { adapter: "claude", executable: "claude" },
        cwd: "",
        lifecycle: { autostart: false, restart: "never", attention: true },
        worktree: { enabled: false, branch: "", setup: [] },
        instructions: "",
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
    expect(p.calls).toHaveLength(1); // the single transaction ran exactly once
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
        return { revision: "rev-1", txid: "tx-1" };
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
   * The saga is GONE, and its absence is asserted rather than assumed. A failure means nothing
   * landed: the canonical transaction compensates profile, authority and roster for BOTH subjects, so
   * there is no "created but unowned" state for a receipt to describe or a retry to finish.
   */
  it("records a plain failure — there is no half-committed state to describe", async () => {
    const ws = workspace();
    const proposal = proposed(ws);
    const p = ports({ createSavedAgent: async () => { throw new Error("lifecycle companion tuple did not converge"); } });
    const result = await approveSavedAgentProposal({
      workspaceRoot: ws, proposalId: proposal.id, approvedDigest: proposal.digest,
      approvedBy: "human", nowMs: NOW, ports: p,
    });
    expect(result.ok).toBe(false);
    const receipt = readSavedAgentProposalReceipt(ws, proposal.digest);
    expect(receipt?.outcome).toBe("failed");
    expect(receipt?.revision).toBeUndefined();     // nothing was created
    expect(receipt?.reason).not.toContain("ownership was not recorded");
  });

  it("has no intermediate outcome at all", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/agents/savedAgentProposalCommit.ts"), "utf8");
    expect(source).not.toContain('"owning"');
    expect(source).not.toContain("adoptSubagent");
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
    // t-3b47ad — scan the tools surface (orchestrator + capability modules), not only tools.ts.
    const root = path.resolve(__dirname, "../../src/bridge");
    const tools = [
      fs.readFileSync(path.join(root, "tools.ts"), "utf8"),
      ...fs.readdirSync(path.join(root, "tools")).filter((f) => f.endsWith(".ts")).map((f) =>
        fs.readFileSync(path.join(root, "tools", f), "utf8"),
      ),
    ].join("\n");
    expect(tools).not.toContain("approveSavedAgentProposal");
    expect(tools).not.toContain("savedAgentProposalCommit");
    expect(tools).not.toContain("denySavedAgentProposal");
  });
});

/**
 * SDD 482 phase 4 — the door is wired, and it crosses the seam ONCE.
 *
 * Two earlier versions of this comment are gone rather than stacked: one described a review-only
 * deployment where the port was deliberately unsupplied, the other said the door opened with "no new
 * operation, no protocol bump". Both were true when written and both are false now — the port is
 * supplied, and the ratified single transaction added the additive action
 * `agent-profile.saved-agent-create`; SDD 483 preserves that strict action and adds v2 rather than
 * widening it, because one transaction requires one crossing and two existing
 * operations are two transactions by construction.
 *
 * The precise protocol position lives in `spec.md` § Where the creation door is open: no existing
 * `.strict()` payload widened, one additive named action, safe in both skew directions, no version
 * bump. The assertions below are what keep that statement honest.
 */
describe("the commit port is wired to ONE transaction (SDD 482 phase 4C)", () => {
  const extension = fs.readFileSync(path.resolve(__dirname, "../../src/extension.ts"), "utf8");

  it("supplies the port from the extension host, and nowhere else", () => {
    // SDD 485 D4 — the port is a named const in `activate()` rather than an inline property of
    // `makeCockpitDeps`, because Control stopped being its caller: the Human Inbox is the surface an
    // approval is redeemed on, and it became a standalone app. The claim is unchanged — the extension
    // host is where the port is built, and it is handed to exactly one consumer.
    expect(extension).toMatch(/const commitSavedAgentProposal = async/);
    expect(extension).toMatch(/approveSavedAgentProposal: \(input\) => commitSavedAgentProposal\(input\)/);
  });

  it("creates through the single canonical transaction, not two Studio calls", () => {
    expect(extension).toContain("ws.createSavedAgent(");
    // The two-call version is gone: no separate set-subagents, no adopt step.
    expect(extension).not.toContain("operation: \"set-subagents\"");
    expect(extension).not.toContain("adoptSubagent");
  });

  /**
   * The action is ADDITIVE, which is the skew-safe shape in both directions: an older engine refuses
   * an unknown action by name, an older client never sends it. Widening `agent-profile.studio-commit`
   * instead would make a newer engine undecodable to an older shell, because that payload is
   * `.strict()` — the shape that broke 0.56.110 D1.
   */
  it("crosses the seam by a NEW action rather than a widened payload", () => {
    const operations = fs.readFileSync(path.resolve(__dirname, "../../src/runtime-api/extensionOperations.ts"), "utf8");
    expect(operations).toContain('"agent-profile.saved-agent-create-v2"');
    // The pre-existing create payload is untouched.
    expect(operations).toContain('z.object({ action: z.literal("agent-profile.studio-commit"), mutation: agentProfileStudioMutationSchemaV1 }).strict()');
  });

  it("keeps v1 strict while v2 carries only the approved owner and narrow grant", () => {
    const mutation = savedAgentCreateMutation("coordinator", {
      runtimeAdapter: "claude",
      model: "claude-opus-5",
    });
    expect(extensionCommandSchema.safeParse({
      action: "agent-profile.saved-agent-create",
      mutation,
      owner: "builder",
      grants: { proposeSavedAgent: true },
    }).success).toBe(false);
    expect(extensionCommandSchema.safeParse({
      action: "agent-profile.saved-agent-create-v2",
      mutation,
      grants: { proposeSavedAgent: true },
    }).success).toBe(true);
    expect(extensionCommandSchema.safeParse({
      action: "agent-profile.saved-agent-create-v2",
      mutation,
      grants: { proposeSavedAgent: false },
    }).success).toBe(false);
  });

  it("asks for no capability references, leaving that refusal to the canonical validator", () => {
    // t-4071e4 moved this mutation out of the approval closure and into `savedAgentCreateMutation`,
    // so assert the value rather than the source text of `extension.ts`: the old grep would have
    // passed on a commented-out literal and now says nothing about what is actually committed.
    expect(savedAgentCreateMutation("importer", { runtimeAdapter: "claude" }).editable.capabilities)
      .toEqual({ skills: [], mcp: [], hooks: [] });
    expect(extension).toContain("savedAgentCreateMutation(agentName, spec)");
  });

  /**
   * The owner's existing subagents are read INSIDE the transaction, under its own lock — not from a
   * caller's earlier snapshot. `set-subagents` is a whole-list write, so reading it outside the lock
   * is precisely the race the single transaction removes.
   */
  it("reads the owner's subagents inside the transaction, not in the caller", () => {
    const workspaceSource = fs.readFileSync(path.resolve(__dirname, "../../src/workspace/Workspace.ts"), "utf8");
    expect(workspaceSource).toMatch(/new Set\(\[\.\.\.\(ownerSnapshot\.profile\.ownership\?\.subagents \?\? \[\]\), input\.agentName\]\)/);
    expect(workspaceSource).toContain("companion: { agentName: input.owner, ownership: { subagents } }");
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
