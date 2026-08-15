/**
 * t-00aa76 / t-ea8f78 — the decided half of a Saved Agent proposal, and the FIXED notice the
 * proposer gets when a human decides.
 *
 * Live queues only list what is still waiting. After a decision the file is gone, so approved /
 * denied / cancelled / expired used to be the same empty list. This record is the durable answer.
 */

export type SavedAgentProposalDecisionOutcome = "approved" | "denied" | "cancelled" | "expired";

export interface SavedAgentProposalDecisionRecord {
  id: string;
  digest: string;
  proposer: string;
  agentName: string;
  outcome: SavedAgentProposalDecisionOutcome;
  resolvedAt: string;
  /** Who or what closed it. Not approval `resolvedBy` — that field is a channel constant (t-86e59a). */
  decidedBy: string;
  operation: "create" | "remove";
  rationale?: string;
  runtimeAdapter?: string;
}

/** FIXED host-owned line — same posture as composeFixedApprovalResponse: one ASCII sentence. */
export function composeSavedAgentProposalDecisionNotice(input: {
  operation: "create" | "remove";
  id: string;
  agentName: string;
  outcome: "approved" | "denied";
}): string {
  const verb = input.operation === "remove" ? "retire" : "create";
  return `[tachyon] Saved Agent proposal ${input.id} to ${verb} '${input.agentName}' was ${input.outcome}`;
}
