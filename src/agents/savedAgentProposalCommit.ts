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
import { proposedWorktreeEnabled, savedAgentProposalIsExpired, type SavedAgentProposal } from "./savedAgentProposal.js";
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

/**
 * There is no intermediate state, because there is no intermediate. Ratified 2026-07-29: creating the
 * agent and recording its owner are ONE canonical transaction, so the only states are "an approval is
 * in flight", "it landed", and "it did not". An earlier version of this file carried an `owning`
 * state for a two-transaction design; that design was rejected on audit, and keeping its state would
 * have preserved the ambiguity the single transaction exists to remove.
 */
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
  /** Revision of the created profile, once the canonical transaction reports one. */
  revision?: string;
  /** The proposer, recorded as the new agent's declared owner in the SAME transaction. */
  owner?: string;
  /** Transaction id. Both authority records carry `lifecycle-<txid>` — one transaction, one identity. */
  txid?: string;
  /**
   * t-ca9086: present once `outcome === "committed"`. Approval authorizes existence and enablement;
   * it never starts a session. Human Inbox copy uses the same phrase.
   */
  created?: "enabled; not started";
  /**
   * t-4071e4: which checkout the approval committed the new agent to. Present with `created`, from the
   * same predicate the review pane showed the human, so the receipt answers "was this thing allowed
   * into my working tree?" without reopening the profile — and answers it for a proposal file that the
   * commit has already deleted.
   */
  workspace?: "isolated worktree" | "shared checkout";
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
   * Create the Saved Agent AND record its owner, in ONE canonical transaction.
   *
   * A single port because it is a single transaction: two ports would invite a caller to perform half
   * of it. Injected rather than imported so this module cannot become a second write path, and so the
   * commit can be exercised without a live Workspace. The canonical path is also what enforces "a new
   * profile cannot select capability references before host authorization" — this module inherits
   * that rule rather than re-implementing it.
   */
  createSavedAgent(input: {
    agentName: string;
    spec: SavedAgentProposal["spec"];
    owner: string;
  }): Promise<{ revision: string; txid: string }>;
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
 * Approve one proposal and create the Saved Agent. HOST-SIDE ONLY: nothing agent-facing calls this,
 * and there is deliberately no Bridge tool for it — an approval an agent could reach is not an
 * approval.
 *
 * Approval creates the agent ENABLED and does not START it. There is no spawn here and no port that
 * could perform one; launch stays a separate action with its own policy (t-ca9086 / SDD 482 decision 9).
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
    // RATIFIED 2026-07-29: the proposer becomes the new agent's declared owner, written by the SAME
    // transaction. There is nothing to resume between two commits because there are not two commits;
    // the lifecycle machine's own journal recovers a crash inside this one.
    const created = await input.ports.createSavedAgent({
      agentName: proposal.spec.name,
      spec: proposal.spec,
      owner: proposal.proposer,
    });
    const receipt: SavedAgentProposalReceipt = {
      ...base,
      outcome: "committed",
      revision: created.revision,
      txid: created.txid,
      owner: proposal.proposer,
      created: "enabled; not started",
      workspace: proposedWorktreeEnabled(proposal.spec) ? "isolated worktree" : "shared checkout",
    };
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
    // The canonical transaction compensates its own durable state — profile, authority and roster for
    // BOTH subjects — so a failure here means nothing landed. What this layer must not do is leave a
    // receipt claiming an in-flight commit that already ended.
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
