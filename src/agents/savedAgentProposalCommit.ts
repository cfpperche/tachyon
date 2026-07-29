import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  SAVED_AGENT_PROPOSALS_REL_DIR,
  cancelSavedAgentProposal,
  readSavedAgentProposal,
  savedAgentProposalPath,
  appendSavedAgentProposalWitness,
} from "./savedAgentProposalStore.js";
import { savedAgentProposalIsExpired, type SavedAgentProposal } from "./savedAgentProposal.js";
import type { AgentProfileGrants } from "../config/agentProfileGrants.js";

/**
 * SDD 482 phase 4 slice C (`t-5e1113`) — the only path from an approved proposal to a Saved Agent.
 *
 * ## What this is not
 *
 * It is not a second write path to authority. Every durable byte goes through the canonical Agent
 * Studio lifecycle transaction, injected as a port: that transaction is a journaled phase machine
 * with compensation and crash recovery on re-read, and a parallel implementation would be strictly
 * worse than reusing it — which is the reason the SDD gave for reusing it in the first place.
 *
 * ## Approval binds to a DIGEST, and the digest is re-checked here
 *
 * A human approves one exact proposal. The digest they approved is passed back in and compared, so an
 * approval can never be redeemed against different content — not a re-proposed variant, not another
 * proposer's identical request, not the same file after an edit. Everything below is a REFUSAL for the
 * same reason: none of these can be repaired after the fact, because a receipt does not un-create a
 * privileged agent.
 *
 * ## Why the proposer's grant is re-read at commit
 *
 * Revocation. A human who removes `grants.proposeSavedAgent` from an agent has decided that agent may
 * not bring new agents into existence — and a proposal pending from before that decision is exactly
 * the case where the old answer would otherwise survive the new one.
 */
export const SAVED_AGENT_RECEIPTS_REL_DIR = path.join(SAVED_AGENT_PROPOSALS_REL_DIR, "receipts");

export type SavedAgentCommitOutcome = "committing" | "committed" | "failed";

/** Ratified: proposer, approver, digest, transaction/operation id, outcome. */
export interface SavedAgentProposalReceipt {
  digest: string;
  proposalId: string;
  proposer: string;
  /** The HOST-side approver. An agent cannot reach this function, so it can never fill this in. */
  approvedBy: string;
  agentName: string;
  approvedAt: string;
  outcome: SavedAgentCommitOutcome;
  operation: "create";
  /** Present once the canonical transaction reports one. */
  txid?: string;
  revision?: string;
  /** Present when `outcome === "failed"`. */
  reason?: string;
}

export type SavedAgentCommitRefusalCode =
  | "not_found"
  | "digest_mismatch"
  | "expired"
  | "base_diverged"
  | "capability_recursion"
  | "proposer_grant_revoked"
  | "commit_failed";

export type SavedAgentCommitResult =
  | { ok: true; receipt: SavedAgentProposalReceipt; alreadyCommitted?: boolean }
  | { ok: false; code: SavedAgentCommitRefusalCode; reason: string };

export interface SavedAgentCommitPorts {
  /**
   * The canonical Studio transaction. Injected rather than imported so this module cannot become a
   * second write path, and so the commit can be exercised without a live Workspace.
   */
  commitProfileLifecycle(input: {
    agentName: string;
    operation: "create";
    createProfile: Record<string, unknown>;
  }): Promise<{ txid: string; revision: string }>;
  /** Re-read at commit time; this is what makes revocation effective on a pending proposal. */
  readProposerGrants(agentName: string): AgentProfileGrants | undefined;
  /** Live config digest for the CAS check. */
  currentConfigSha256(): string;
}

function receiptPath(workspaceRoot: string, digest: string): string {
  return path.join(workspaceRoot, SAVED_AGENT_RECEIPTS_REL_DIR, `${digest}.json`);
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

function writeReceipt(workspaceRoot: string, receipt: SavedAgentProposalReceipt): void {
  const file = receiptPath(workspaceRoot, receipt.digest);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function readSavedAgentProposalReceipt(workspaceRoot: string, digest: string): SavedAgentProposalReceipt | undefined {
  if (!DIGEST_RE.test(digest)) return undefined;
  const file = receiptPath(workspaceRoot, digest);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SavedAgentProposalReceipt;
  } catch {
    return undefined;
  }
}

/**
 * The profile the transaction will canonicalize.
 *
 * TWO THINGS ARE DELIBERATELY DROPPED, and both come from rules the canonical path already enforces
 * rather than from caution invented here:
 *
 *  - CAPABILITY REFERENCES (skills / MCP / hooks). `createProfileFromStudioMutation` refuses them on
 *    a create outright — "new canonical profile cannot select capability references before host
 *    authorization". A human using Agent Studio cannot grant them at creation, so a proposal must not
 *    either; doing so would make this a second write path with MORE authority than the first, which
 *    is exactly what reusing the canonical transaction was supposed to prevent. The request is still
 *    shown to the reviewer, and granting it stays a separate, visible edit.
 *  - `grants`. Invariant 9: a created agent can never be a creator. This is the second of the two
 *    enforcement points — admission refuses the request, and this refuses to honour one that reached
 *    the store by any other route.
 *
 * `lifecycle.enabled: false` is the same value the Studio create writes, and it is what "saving does
 * not start the agent" means in the profile itself rather than only in this module's behaviour.
 */
function profileFromProposal(proposal: SavedAgentProposal): Record<string, unknown> {
  const spec = proposal.spec;
  return {
    ...(spec.displayName ? { displayName: spec.displayName } : {}),
    runtime: { adapter: spec.runtimeAdapter, ...(spec.executable ? { executable: spec.executable } : {}) },
    lifecycle: { enabled: false },
    ...(spec.environment && Object.keys(spec.environment).length > 0 ? { environment: { values: { ...spec.environment } } } : {}),
    ...(spec.ownsSubagents?.length ? { ownership: { subagents: [...spec.ownsSubagents] } } : {}),
  };
}

/**
 * Approve one proposal and create the Saved Agent. HOST-SIDE ONLY: nothing agent-facing calls this,
 * and there is deliberately no Bridge tool for it — an approval an agent could reach is not an
 * approval.
 *
 * Saving does not START the agent. There is no spawn here and no port that could perform one; launch
 * stays a separate action with its own policy, which is what the ratified decision requires.
 */
export async function approveSavedAgentProposal(input: {
  workspaceRoot: string;
  proposalId: string;
  /** The digest the human approved. Compared, never trusted. */
  approvedDigest: string;
  approvedBy: string;
  nowMs: number;
  ports: SavedAgentCommitPorts;
}): Promise<SavedAgentCommitResult> {
  // Idempotency first: a retry after a crash, a double-click, or a re-delivered host event must
  // converge on the existing receipt rather than attempting a second create.
  const existing = readSavedAgentProposalReceipt(input.workspaceRoot, input.approvedDigest);
  if (existing?.outcome === "committed") return { ok: true, receipt: existing, alreadyCommitted: true };

  let proposal: SavedAgentProposal;
  try {
    proposal = readSavedAgentProposal(input.workspaceRoot, input.proposalId);
  } catch (error) {
    return { ok: false, code: "not_found", reason: error instanceof Error ? error.message : String(error) };
  }

  if (proposal.digest !== input.approvedDigest) {
    return {
      ok: false,
      code: "digest_mismatch",
      reason:
        `the approval names digest ${input.approvedDigest.slice(0, 12)}… but proposal '${proposal.id}' now carries ` +
        `${proposal.digest.slice(0, 12)}…; an approval is bound to one exact proposal and is never transferable`,
    };
  }
  if (savedAgentProposalIsExpired(proposal, input.nowMs)) {
    return { ok: false, code: "expired", reason: `proposal '${proposal.id}' expired at ${proposal.expiresAt}` };
  }

  // CAS. The proposal describes a roster; if that roster moved, the thing the human reviewed is not
  // the thing that would be committed, and the fix is a fresh proposal rather than a hopeful merge.
  const currentConfig = input.ports.currentConfigSha256();
  if (currentConfig !== proposal.base.configSha256) {
    return {
      ok: false,
      code: "base_diverged",
      reason:
        `the workspace config changed since proposal '${proposal.id}' was made (base ` +
        `${proposal.base.configSha256.slice(0, 12)}…, now ${currentConfig.slice(0, 12)}…); ask for a fresh proposal`,
    };
  }

  if (proposal.spec.grants?.proposeSavedAgent === true) {
    return {
      ok: false,
      code: "capability_recursion",
      reason: "a proposed Saved Agent may never carry 'grants.proposeSavedAgent' — refused at commit as well as at admission",
    };
  }

  if (input.ports.readProposerGrants(proposal.proposer)?.proposeSavedAgent !== true) {
    return {
      ok: false,
      code: "proposer_grant_revoked",
      reason:
        `agent '${proposal.proposer}' no longer holds 'grants.proposeSavedAgent', so its pending proposal is not ` +
        "honoured; a revoked capability must not survive in work queued before the revocation",
    };
  }

  // The intent record lands BEFORE the transaction. If the process dies between the two, the receipt
  // says `committing` and names the digest, so recovery is a question with an answer on disk rather
  // than an orphaned agent nobody can attribute.
  const base: SavedAgentProposalReceipt = {
    digest: proposal.digest,
    proposalId: proposal.id,
    proposer: proposal.proposer,
    approvedBy: input.approvedBy,
    agentName: proposal.spec.name,
    approvedAt: new Date(input.nowMs).toISOString(),
    outcome: "committing",
    operation: "create",
  };
  writeReceipt(input.workspaceRoot, base);

  try {
    const committed = await input.ports.commitProfileLifecycle({
      agentName: proposal.spec.name,
      operation: "create",
      createProfile: profileFromProposal(proposal),
    });
    const receipt: SavedAgentProposalReceipt = { ...base, outcome: "committed", txid: committed.txid, revision: committed.revision };
    writeReceipt(input.workspaceRoot, receipt);
    // The proposal is consumed only after the receipt says so. Deleting first would lose the record of
    // what was approved if the write failed.
    try {
      fs.rmSync(savedAgentProposalPath(input.workspaceRoot, proposal.id), { force: true });
    } catch { /* the receipt is the durable fact; a stale proposal file is swept or expires */ }
    appendSavedAgentProposalWitness(input.workspaceRoot, {
      kind: "committed", id: proposal.id, digest: proposal.digest, approvedBy: input.approvedBy, at: base.approvedAt,
    });
    return { ok: true, receipt };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The canonical transaction compensates its own durable state; what this layer must not do is
    // leave the receipt claiming an in-flight commit that already ended.
    writeReceipt(input.workspaceRoot, { ...base, outcome: "failed", reason });
    return { ok: false, code: "commit_failed", reason };
  }
}

/**
 * Deny a proposal. A denial is a decision too: it removes the proposal and records WHO decided, so a
 * proposer that re-proposes is asking again rather than retrying into a void.
 */
export function denySavedAgentProposal(input: {
  workspaceRoot: string;
  proposalId: string;
  deniedBy: string;
  reason: string;
  nowMs: number;
}): { denied: boolean } {
  let proposal: SavedAgentProposal;
  try {
    proposal = readSavedAgentProposal(input.workspaceRoot, input.proposalId);
  } catch {
    return { denied: false };
  }
  // Host-side denial is not the proposer's withdrawal, so it goes through the same removal but is
  // witnessed under the human's name.
  cancelSavedAgentProposal({
    workspaceRoot: input.workspaceRoot,
    id: proposal.id,
    by: proposal.proposer,
    reason: `denied by ${input.deniedBy}: ${input.reason}`,
    nowMs: input.nowMs,
  });
  return { denied: true };
}
