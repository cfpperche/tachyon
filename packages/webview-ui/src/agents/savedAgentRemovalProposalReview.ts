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
