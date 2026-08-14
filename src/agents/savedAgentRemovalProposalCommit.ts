import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  SAVED_AGENT_REMOVAL_PROPOSALS_REL_DIR,
  cancelSavedAgentRemovalProposal,
  readSavedAgentRemovalProposal,
  savedAgentRemovalProposalPath,
  appendSavedAgentRemovalProposalWitness,
} from "@tachyon/engine/agents/savedAgentRemovalProposalStore.js";
import {
  savedAgentRemovalProposalIsExpired,
  type SavedAgentRemovalProposal,
} from "@tachyon/engine/agents/savedAgentRemovalProposal.js";
import type { AgentProfileGrants } from "@tachyon/engine/config/agentProfileGrants.js";

/**
 * t-afe120 — host-only path from an approved removal proposal to the canonical forget cascade.
 *
 * Nothing agent-facing calls this. An approval binds to a digest; the proposer's grant is re-read at
 * commit; config + profile identity are re-checked so a TOCTOU edit cannot land. The cascade itself
 * is injected as a single port so this module cannot become a second write path for profile /
 * authority / roster / worktree.
 */

export const SAVED_AGENT_REMOVAL_RECEIPTS_REL_DIR = path.join(SAVED_AGENT_REMOVAL_PROPOSALS_REL_DIR, "receipts");

export type SavedAgentRemovalCommitOutcome = "committing" | "committed" | "failed";

export interface SavedAgentRemovalProposalReceipt {
  digest: string;
  proposalId: string;
  proposer: string;
  approvedBy: string;
  agentName: string;
  approvedAt: string;
  outcome: SavedAgentRemovalCommitOutcome;
  operation: "remove";
  /** Profile revision the cascade was bound to. */
  revision?: string;
  txid?: string;
  /** Present once committed: session stopped, worktree released (if any), profile retired. */
  removed?: "session stopped; profile+authority+roster retired; worktree released if owned";
  reason?: string;
}

export type SavedAgentRemovalCommitRefusalCode =
  | "not_found"
  | "digest_mismatch"
  | "expired"
  | "base_diverged"
  | "identity_diverged"
  | "proposer_grant_revoked"
  | "commit_failed";

export type SavedAgentRemovalCommitResult =
  | { ok: true; receipt: SavedAgentRemovalProposalReceipt; alreadyCommitted?: boolean }
  | { ok: false; code: SavedAgentRemovalCommitRefusalCode; reason: string };

export interface SavedAgentRemovalCommitPorts {
  /**
   * The ONE removal cascade: stop session, release governed worktree, retire profile+authority+roster.
   * Injected so tests can prove fail-closed without a live Workspace, and so this file never grows a
   * parallel implementation.
   */
  forgetSavedAgent(input: {
    agentName: string;
    expectedRevision: string;
  }): Promise<{ txid: string; revision: string }>;
  /** Live identity of the named agent; absent means the target vanished between propose and approve. */
  readTargetIdentity(agentName: string): Promise<{ agentId: string; revision: string } | undefined>;
  readProposerGrants(agentName: string): AgentProfileGrants | undefined;
  currentConfigSha256(): string;
}

function receiptPath(workspaceRoot: string, digest: string): string {
  return path.join(workspaceRoot, SAVED_AGENT_REMOVAL_RECEIPTS_REL_DIR, `${digest}.json`);
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

function writeReceipt(workspaceRoot: string, receipt: SavedAgentRemovalProposalReceipt): void {
  const file = receiptPath(workspaceRoot, receipt.digest);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function readSavedAgentRemovalProposalReceipt(
  workspaceRoot: string,
  digest: string,
): SavedAgentRemovalProposalReceipt | undefined {
  if (!DIGEST_RE.test(digest)) return undefined;
  const file = receiptPath(workspaceRoot, digest);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SavedAgentRemovalProposalReceipt;
  } catch {
    return undefined;
  }
}

/**
 * Approve one removal proposal and run the forget cascade. HOST-SIDE ONLY.
 *
 * Order of checks is deliberate: identity and grant before any mutation. The cascade port is the only
 * thing that may move durable state; if it throws, this layer records `failed` and leaves the
 * proposal on disk so the human can re-approve after fixing the block — or deny.
 */
export async function approveSavedAgentRemovalProposal(input: {
  workspaceRoot: string;
  proposalId: string;
  approvedDigest: string;
  approvedBy: string;
  nowMs: number;
  ports: SavedAgentRemovalCommitPorts;
}): Promise<SavedAgentRemovalCommitResult> {
  const existing = readSavedAgentRemovalProposalReceipt(input.workspaceRoot, input.approvedDigest);
  if (existing?.outcome === "committed") return { ok: true, receipt: existing, alreadyCommitted: true };

  let proposal: SavedAgentRemovalProposal;
  try {
    proposal = readSavedAgentRemovalProposal(input.workspaceRoot, input.proposalId);
  } catch (error) {
    return { ok: false, code: "not_found", reason: error instanceof Error ? error.message : String(error) };
  }

  if (proposal.digest !== input.approvedDigest) {
    return {
      ok: false,
      code: "digest_mismatch",
      reason:
        `the approval names digest ${input.approvedDigest.slice(0, 12)}… but removal proposal '${proposal.id}' now carries ` +
        `${proposal.digest.slice(0, 12)}…; an approval is bound to one exact proposal and is never transferable`,
    };
  }
  if (savedAgentRemovalProposalIsExpired(proposal, input.nowMs)) {
    return { ok: false, code: "expired", reason: `removal proposal '${proposal.id}' expired at ${proposal.expiresAt}` };
  }

  const currentConfig = input.ports.currentConfigSha256();
  if (currentConfig !== proposal.base.configSha256) {
    return {
      ok: false,
      code: "base_diverged",
      reason:
        `the workspace config changed since removal proposal '${proposal.id}' was made (base ` +
        `${proposal.base.configSha256.slice(0, 12)}…, now ${currentConfig.slice(0, 12)}…); ask for a fresh proposal`,
    };
  }

  if (input.ports.readProposerGrants(proposal.proposer)?.proposeSavedAgent !== true) {
    return {
      ok: false,
      code: "proposer_grant_revoked",
      reason:
        `agent '${proposal.proposer}' no longer holds 'grants.proposeSavedAgent', so its pending removal proposal is not ` +
        "honoured; a revoked capability must not survive in work queued before the revocation",
    };
  }

  const live = await input.ports.readTargetIdentity(proposal.spec.name);
  if (!live) {
    return {
      ok: false,
      code: "identity_diverged",
      reason:
        `agent '${proposal.spec.name}' is no longer a profile-backed Saved Agent; refusing rather than inventing a removal`,
    };
  }
  if (live.agentId !== proposal.base.agentId || live.revision !== proposal.base.profileRevision) {
    return {
      ok: false,
      code: "identity_diverged",
      reason:
        `agent '${proposal.spec.name}' no longer matches the identity reviewed with proposal '${proposal.id}' ` +
        `(expected agentId ${proposal.base.agentId.slice(0, 8)}… rev ${proposal.base.profileRevision.slice(0, 12)}…); ` +
        "ask for a fresh proposal",
    };
  }

  const base: SavedAgentRemovalProposalReceipt = {
    digest: proposal.digest,
    proposalId: proposal.id,
    proposer: proposal.proposer,
    approvedBy: input.approvedBy,
    agentName: proposal.spec.name,
    approvedAt: new Date(input.nowMs).toISOString(),
    outcome: "committing",
    operation: "remove",
    revision: proposal.base.profileRevision,
  };
  writeReceipt(input.workspaceRoot, base);

  try {
    const forgotten = await input.ports.forgetSavedAgent({
      agentName: proposal.spec.name,
      expectedRevision: proposal.base.profileRevision,
    });
    const receipt: SavedAgentRemovalProposalReceipt = {
      ...base,
      outcome: "committed",
      txid: forgotten.txid,
      revision: forgotten.revision,
      removed: "session stopped; profile+authority+roster retired; worktree released if owned",
    };
    writeReceipt(input.workspaceRoot, receipt);
    try {
      fs.rmSync(savedAgentRemovalProposalPath(input.workspaceRoot, proposal.id), { force: true });
    } catch { /* receipt is the durable fact */ }
    appendSavedAgentRemovalProposalWitness(input.workspaceRoot, {
      kind: "committed",
      id: proposal.id,
      digest: proposal.digest,
      approvedBy: input.approvedBy,
      at: base.approvedAt,
    });
    return { ok: true, receipt };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The cascade is responsible for not half-retiring profile/authority/roster. This layer must not
    // claim an in-flight commit that already ended, and must leave the proposal for retry or deny.
    writeReceipt(input.workspaceRoot, { ...base, outcome: "failed", reason });
    return { ok: false, code: "commit_failed", reason };
  }
}

export function denySavedAgentRemovalProposal(input: {
  workspaceRoot: string;
  proposalId: string;
  deniedBy: string;
  reason: string;
  nowMs: number;
}): { denied: boolean } {
  let proposal: SavedAgentRemovalProposal;
  try {
    proposal = readSavedAgentRemovalProposal(input.workspaceRoot, input.proposalId);
  } catch {
    return { denied: false };
  }
  cancelSavedAgentRemovalProposal({
    workspaceRoot: input.workspaceRoot,
    id: proposal.id,
    by: proposal.proposer,
    reason: `denied by ${input.deniedBy}: ${input.reason}`,
    nowMs: input.nowMs,
  });
  return { denied: true };
}
