import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SavedAgentProposalTamperError,
  cancelSavedAgentProposal,
  listLiveSavedAgentProposals,
  listSavedAgentProposals,
  readSavedAgentProposal,
  readSavedAgentProposalWitness,
  recordSavedAgentProposal,
  savedAgentProposalPath,
  sweepExpiredSavedAgentProposals,
} from "../../src/agents/savedAgentProposalStore.js";
import { SAVED_AGENT_PROPOSAL_PENDING_CEILING, SAVED_AGENT_PROPOSAL_TTL_MS } from "../../src/agents/savedAgentProposal.js";

/**
 * SDD 482 phase 4 slice B (`t-5e1113`) — durability is where ratified decision 4 can actually fail.
 *
 * "Lives 24h, survives a restart, collapses an identical digest, invalidated when the base diverges"
 * was pure logic in slice A. On disk each clause acquires a failure mode: a proposal that outlives its
 * expiry because a sweep never ran, a retry that grows the queue, an edited file that a human already
 * approved the earlier version of. Those are what these tests attack.
 */
const NOW = Date.parse("2026-07-29T00:00:00.000Z");
const GRANTED = { grants: { proposeSavedAgent: true } } as const;
const BASE = { configSha256: "a".repeat(64) };

const dirs: string[] = [];
function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-proposal-store-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function spec(over: Record<string, unknown> = {}) {
  return { name: "helper", runtimeAdapter: "claude", rationale: "runs the nightly import", ...over } as never;
}

function record(ws: string, over: Record<string, unknown> = {}) {
  return recordSavedAgentProposal({
    workspaceRoot: ws,
    proposer: "claude-runtime",
    proposerProfile: GRANTED,
    spec: spec(),
    base: BASE,
    nowMs: NOW,
    ...over,
  });
}

describe("Saved Agent proposal store (SDD 482 phase 4B)", () => {
  it("survives a restart: a fresh read sees the proposal a previous process wrote", () => {
    const ws = workspace();
    const admitted = record(ws);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    // Nothing is cached here on purpose — this is exactly what a new extension host does.
    const reread = readSavedAgentProposal(ws, admitted.proposal.id);
    expect(reread).toEqual(admitted.proposal);
    expect(listLiveSavedAgentProposals(ws, NOW).map((p) => p.id)).toEqual([admitted.proposal.id]);
  });

  /**
   * The dangerous edit is not deleting a proposal — it is CHANGING one a human already looked at.
   * Recomputing the digest on load would launder precisely that edit, so a mismatch is a hard refusal.
   */
  it("refuses a proposal whose file was edited after it was written", () => {
    const ws = workspace();
    const admitted = record(ws);
    if (!admitted.ok) throw new Error("fixture");
    const file = savedAgentProposalPath(ws, admitted.proposal.id);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

    // Same digest field, different content: the escalation an attacker actually wants.
    fs.writeFileSync(file, JSON.stringify({ ...onDisk, spec: { ...(onDisk.spec as object), name: "root" } }), "utf8");

    expect(() => readSavedAgentProposal(ws, admitted.proposal.id)).toThrow(SavedAgentProposalTamperError);
    // …and it is not merely unreadable: it must not appear in the queue a human decides from.
    expect(listSavedAgentProposals(ws)).toEqual([]);
  });

  it("refuses a record that was moved into another id's file", () => {
    const ws = workspace();
    const admitted = record(ws);
    if (!admitted.ok) throw new Error("fixture");
    const stolen = savedAgentProposalPath(ws, "sp-aaaaaa");
    fs.copyFileSync(savedAgentProposalPath(ws, admitted.proposal.id), stolen);
    expect(() => readSavedAgentProposal(ws, "sp-aaaaaa")).toThrow(SavedAgentProposalTamperError);
  });

  /**
   * A single corrupt file must not blind the human to the whole queue — that would turn one bad write
   * into a denial of the ability to see anything at all. Read-by-id still fails loudly; only listing
   * is tolerant, and only by excluding.
   */
  it("keeps listing the rest of the queue when one file is corrupt", () => {
    const ws = workspace();
    const good = record(ws);
    const other = record(ws, { spec: spec({ name: "second" }) });
    if (!good.ok || !other.ok) throw new Error("fixture");
    fs.writeFileSync(savedAgentProposalPath(ws, other.proposal.id), "{ not json", "utf8");
    expect(listSavedAgentProposals(ws).map((p) => p.id)).toEqual([good.proposal.id]);
  });

  it("refuses a traversal-shaped id instead of turning it into a path", () => {
    const ws = workspace();
    expect(() => readSavedAgentProposal(ws, "../../etc/passwd")).toThrow(/invalid saved agent proposal id/);
    expect(() => cancelSavedAgentProposal({ workspaceRoot: ws, id: "sp-../x", by: "a", reason: "r", nowMs: NOW }))
      .toThrow(/invalid saved agent proposal id/);
  });

  it("collapses a retry onto the same file instead of growing the queue", () => {
    const ws = workspace();
    const first = record(ws);
    const retry = record(ws);
    if (!first.ok || !retry.ok) throw new Error("fixture");
    expect(retry.collapsedOnto).toBe(first.proposal.id);
    expect(listSavedAgentProposals(ws)).toHaveLength(1);

    // The retry still leaves a trace: "nothing changed" and "nothing was attempted" are different
    // facts, and an audit that cannot tell them apart cannot explain a flood.
    const witness = readSavedAgentProposalWitness(ws);
    expect(witness.map((e) => e.kind)).toEqual(["proposed", "collapsed"]);
  });

  it("records a refusal in the witness log without writing a proposal", () => {
    const ws = workspace();
    const refused = record(ws, { proposerProfile: { grants: {} } });
    expect(refused.ok).toBe(false);
    expect(listSavedAgentProposals(ws)).toEqual([]);
    expect(readSavedAgentProposalWitness(ws)).toEqual([
      { kind: "refused", proposer: "claude-runtime", code: "capability_absent", at: new Date(NOW).toISOString() },
    ]);
  });

  /**
   * Expiry is evaluated at READ time, so a host that never sweeps still cannot honour a stale
   * proposal. If the sweep were the control, a crashed sweeper would silently extend every TTL.
   */
  it("stops counting an expired proposal without depending on the sweep having run", () => {
    const ws = workspace();
    for (let index = 0; index < SAVED_AGENT_PROPOSAL_PENDING_CEILING; index++) {
      record(ws, { spec: spec({ name: `filler-${index}` }) });
    }
    const later = NOW + SAVED_AGENT_PROPOSAL_TTL_MS;
    expect(listSavedAgentProposals(ws)).toHaveLength(SAVED_AGENT_PROPOSAL_PENDING_CEILING); // still on disk
    expect(listLiveSavedAgentProposals(ws, later)).toEqual([]);                              // but none are live

    // …so the ceiling admits again even though nothing has been cleaned up.
    const admitted = record(ws, { spec: spec({ name: "after-expiry" }), nowMs: later });
    expect(admitted.ok).toBe(true);
  });

  it("sweeps expired files as housekeeping, leaving live ones alone", () => {
    const ws = workspace();
    const stale = record(ws);
    const fresh = record(ws, { spec: spec({ name: "fresh" }), nowMs: NOW + SAVED_AGENT_PROPOSAL_TTL_MS });
    if (!stale.ok || !fresh.ok) throw new Error("fixture");
    const swept = sweepExpiredSavedAgentProposals(ws, NOW + SAVED_AGENT_PROPOSAL_TTL_MS);
    expect(swept).toEqual([stale.proposal.id]);
    expect(listSavedAgentProposals(ws).map((p) => p.id)).toEqual([fresh.proposal.id]);
  });

  /**
   * A third agent cancelling someone else's proposal would suppress a human decision without ever
   * being seen doing it. Ownership is checked against the stored record, not trusted from the caller.
   */
  it("lets only the proposer withdraw its own proposal", () => {
    const ws = workspace();
    const mine = record(ws);
    if (!mine.ok) throw new Error("fixture");
    expect(() => cancelSavedAgentProposal({ workspaceRoot: ws, id: mine.proposal.id, by: "codex-canonico", reason: "no", nowMs: NOW }))
      .toThrow(/cannot cancel a Saved Agent proposal owned by/);
    expect(listSavedAgentProposals(ws)).toHaveLength(1);

    expect(cancelSavedAgentProposal({ workspaceRoot: ws, id: mine.proposal.id, by: "claude-runtime", reason: "withdrawn", nowMs: NOW }))
      .toEqual({ cancelled: true });
    expect(listSavedAgentProposals(ws)).toEqual([]);
  });

  it("converges on a repeated cancel instead of failing a retry the caller cannot fix", () => {
    const ws = workspace();
    const mine = record(ws);
    if (!mine.ok) throw new Error("fixture");
    const args = { workspaceRoot: ws, id: mine.proposal.id, by: "claude-runtime", reason: "withdrawn", nowMs: NOW };
    expect(cancelSavedAgentProposal(args)).toEqual({ cancelled: true });
    expect(cancelSavedAgentProposal(args)).toEqual({ cancelled: false });
  });

  it("writes the proposal private to the user, like every other credential-adjacent artifact", () => {
    const ws = workspace();
    const mine = record(ws);
    if (!mine.ok) throw new Error("fixture");
    const mode = fs.statSync(savedAgentProposalPath(ws, mine.proposal.id)).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });
});
