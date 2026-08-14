import type { SavedAgentRemovalProposal } from "@tachyon/engine/agents/savedAgentRemovalProposal.js";
import { savedAgentRemovalProposalIsExpired } from "@tachyon/engine/agents/savedAgentRemovalProposal.js";

/**
 * t-afe120 — what the human sees before approving a Saved Agent removal.
 *
 * Removal is irreversible for the roster entry (the profile home is quarantined, not deleted), so the
 * review names consequences rather than soft-pedaling them. Values from the agent are not echoed as
 * secrets-safe by assumption — only the rationale and identity facts the digest already bound.
 */

export interface SavedAgentRemovalProposalDanger {
  label: string;
  detail: string;
}

export interface SavedAgentRemovalProposalReview {
  id: string;
  proposer: string;
  proposerTrust: "bridge-resolved";
  digest: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  agentName: string;
  agentId: string;
  profileRevision: string;
  rationale: string;
  dangerous: SavedAgentRemovalProposalDanger[];
  affected: string[];
  baseConfigSha256: string;
  baseDiverged: boolean;
}

export function buildSavedAgentRemovalProposalReview(input: {
  proposal: SavedAgentRemovalProposal;
  currentConfigSha256: string;
  nowMs: number;
}): SavedAgentRemovalProposalReview {
  const { proposal } = input;
  const dangerous: SavedAgentRemovalProposalDanger[] = [
    {
      label: "session stopped first",
      detail:
        `any live session for '${proposal.spec.name}' is stopped before retirement, so the process cannot outlive ` +
        "its roster entry",
    },
    {
      label: "governed worktree release",
      detail:
        "if the agent owns a managed worktree, it is released through the same governed cascade as Agent Studio " +
        "Forget — never by direct filesystem delete; a unique branch is kept when it holds unmerged commits",
    },
    {
      label: "profile + authority + roster",
      detail:
        "the canonical profile is quarantined, its authority record is retired, and the tachyon.yml locator is " +
        "removed in one recoverable transaction — half-removed is refused",
    },
  ];

  return {
    id: proposal.id,
    proposer: proposal.proposer,
    proposerTrust: "bridge-resolved",
    digest: proposal.digest,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    expired: savedAgentRemovalProposalIsExpired(proposal, input.nowMs),
    agentName: proposal.spec.name,
    agentId: proposal.base.agentId,
    profileRevision: proposal.base.profileRevision,
    rationale: proposal.spec.rationale,
    dangerous,
    affected: [
      "canonical profile home (quarantined under agentId)",
      "profile authority record",
      "tachyon.yml agents locator",
      "managed worktree ownership (if any)",
      "live session (stopped if present)",
    ],
    baseConfigSha256: proposal.base.configSha256,
    baseDiverged: input.currentConfigSha256 !== proposal.base.configSha256,
  };
}
