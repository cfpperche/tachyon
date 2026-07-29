import type { SavedAgentProposal } from "./savedAgentProposal.js";
import { savedAgentProposalIsExpired } from "./savedAgentProposal.js";

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
  runtime: { adapter: string; executable?: string };
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

export function buildSavedAgentProposalReview(input: {
  proposal: SavedAgentProposal;
  /** Live config digest, so a reviewer sees a stale proposal as stale BEFORE deciding. */
  currentConfigSha256: string;
  nowMs: number;
}): SavedAgentProposalReview {
  const { proposal } = input;
  const spec = proposal.spec;
  const dangerous: SavedAgentProposalDanger[] = [];

  if (spec.ownsSubagents?.length) {
    dangerous.push({
      label: "roster ownership",
      detail:
        `would be recorded as the declared owner of ${spec.ownsSubagents.join(", ")}. Ownership is a durable ` +
        "relationship in tachyon.yml; it confers no operational authority over those agents by itself.",
    });
  }
  // Capability references are REQUESTED but never granted by this approval: a new canonical profile
  // "cannot select capability references before host authorization" — the same rule that applies to a
  // human creating an agent in Agent Studio. Saying so here is the difference between a reviewer who
  // knows a second step is coming and one who believes they just granted MCP access.
  const requestedCapabilities = [
    ...(spec.capabilities?.mcp ?? []).map((id) => `MCP ${id}`),
    ...(spec.capabilities?.hooks ?? []).map((id) => `hook ${id}`),
    ...(spec.capabilities?.skills ?? []).map((id) => `skill ${id}`),
  ];
  if (requestedCapabilities.length > 0) {
    dangerous.push({
      label: "capabilities requested (NOT granted by this approval)",
      detail:
        `asks for ${requestedCapabilities.join(", ")}. Approving does NOT grant these — a new profile cannot ` +
        "select capability references before host authorization, so granting them stays a separate edit in Agent Studio.",
    });
  }
  if (spec.environment && Object.keys(spec.environment).length > 0) {
    dangerous.push({
      label: "environment",
      detail:
        `would receive the environment variables ${Object.keys(spec.environment).sort().join(", ")}. Values are not ` +
        "shown here; inspect the proposal file if you need to see them.",
    });
  }
  if (spec.executable) {
    dangerous.push({
      label: "executable",
      detail: `would launch \`${spec.executable}\`. Confirm this is the runtime you expect for adapter '${spec.runtimeAdapter}'.`,
    });
  }

  return {
    id: proposal.id,
    proposer: proposal.proposer,
    proposerTrust: "bridge-resolved",
    digest: proposal.digest,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    expired: savedAgentProposalIsExpired(proposal, input.nowMs),
    agentName: spec.name,
    runtime: { adapter: spec.runtimeAdapter, ...(spec.executable ? { executable: spec.executable } : {}) },
    ...(spec.displayName ? { displayName: spec.displayName } : {}),
    rationale: spec.rationale,
    environmentNames: Object.keys(spec.environment ?? {}).sort(),
    requestedOwnership: [...(spec.ownsSubagents ?? [])],
    requestedSkills: [...(spec.capabilities?.skills ?? [])],
    requestedMcpServers: [...(spec.capabilities?.mcp ?? [])],
    requestedHooks: [...(spec.capabilities?.hooks ?? [])],
    hasUngrantedCapabilityRequests: requestedCapabilities.length > 0,
    dangerous,
    affected: [
      `.tachyon/agents/${spec.name}/agent.yml (new canonical profile, lifecycle.enabled=true)`,
      `.tachyon/agents/${spec.name}/authority.json (new authority record)`,
      `tachyon.yml → agents.${spec.name} (new roster pointer)`,
      `created enabled; not started (no session, no running worktree, no task assignment)`,
    ],
    baseConfigSha256: proposal.base.configSha256,
    baseDiverged: proposal.base.configSha256 !== input.currentConfigSha256,
  };
}
