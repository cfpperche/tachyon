/**
 * SDD 482 phase 4 slice C (`t-5e1113`) — what the human actually sees before approving.
 *
 * The approval is the ONLY thing standing between a proposal and durable authority, so this view has
 * one job: make the consequences legible, and make nothing look smaller than it is. Two rules follow
 * from that and are enforced here rather than left to the renderer:
 *
 *  1. NO VALUES FROM AN AGENT ARE SHOWN AS SECRETS-SAFE BY ASSUMPTION. Environment entries render as
 *     NAMES ONLY. A proposal cannot reference a secret provider by type, but nothing stops a proposer
 *     pasting a token into an ordinary `environment` value, and a review pane that echoes it would
 *     put the credential into a screenshot, a log and a support thread at once. Names carry the
 *     information a reviewer needs — "this agent wants an ANTHROPIC_API_KEY" — without the value.
 *  2. DANGEROUS THINGS ARE LISTED, NOT INFERRED FROM ABSENCE. Each entry names what is being asked
 *     for and why it matters, so a reviewer who reads only the dangerous list has still seen every
 *     grant of authority in the proposal.
 */
export interface SavedAgentProposalDanger {
  /** Short label, e.g. "roster ownership". */
  label: string;
  /** One sentence naming the consequence in the reviewer's terms. */
  detail: string;
}

export interface SavedAgentProposalReview {
  id: string;
  proposer: string;
  /** Bridge-resolved: the proposer could not have named itself. */
  proposerTrust: "bridge-resolved";
  digest: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  agentName: string;
  /**
   * t-4071e4 — whether the approved agent would get its own separate worktree. A structured field as
   * well as review prose, so a surface that renders a summary rather than the `dangerous` list still
   * shows the decision instead of dropping it.
   */
  /**
   * t-4071e4 — which checkout this proposal would run in. `"unknown"` exists because an unreadable
   * proposal asserts NOTHING: rendering `false` there would state a workspace fact on the strength of
   * a file that failed its digest check, which is the one thing the warned row must not do.
   */
  worktreeEnabled: boolean | "unknown";
  runtime: { adapter: string; executable?: string; model?: string; reasoningEffort?: string };
  ownership: "proposer" | "top-level";
  requestedGrants: string[];
  permissionAuthorizations: string[];
  displayName?: string;
  rationale: string;
  /** Environment variable NAMES the proposal asks for. Never values — see the rule above. */
  environmentNames: string[];
  requestedOwnership: string[];
  requestedSkills: string[];
  requestedMcpServers: string[];
  requestedHooks: string[];
  /** True when the proposal asks for capability references the approval will NOT grant. */
  hasUngrantedCapabilityRequests: boolean;
  dangerous: SavedAgentProposalDanger[];
  /** Durable artifacts this approval would create or change. */
  affected: string[];
  /** The CAS half: what the proposal was computed against, and whether that still holds. */
  baseConfigSha256: string;
  baseDiverged: boolean;
}
