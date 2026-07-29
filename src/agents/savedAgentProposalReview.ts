import type { SavedAgentProposal } from "./savedAgentProposal.js";
import { proposedWorktreeEnabled } from "./savedAgentProposal.js";
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
  /**
   * t-4071e4 — whether the approved agent would get its own isolated worktree. A structured field as
   * well as review prose, so a surface that renders a summary rather than the `dangerous` list still
   * shows the decision instead of dropping it.
   */
  /**
   * t-4071e4 — which checkout this proposal would run in. `"unknown"` exists because an unreadable
   * proposal asserts NOTHING: rendering `false` there would state a workspace fact on the strength of
   * a file that failed its digest check, which is the one thing the warned row must not do.
   */
  worktreeEnabled: boolean | "unknown";
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

  /**
   * t-4071e4 — the human must see the isolation decision before approving.
   *
   * Only the OPT-OUT goes in `dangerous`. Two existing tests caught the first version of this, and they
   * were right: that list means "grants of authority", so putting the isolated DEFAULT in it would both
   * break "a plain proposal lists nothing dangerous" and teach the reader that a safe default is a
   * risk. Isolation-on is visible through `worktreeEnabled` and the `affected` list, where descriptions
   * of what will happen belong; sharing the human's checkout is the widening, so that is what gets
   * called out.
   */
  const worktreeEnabled = proposedWorktreeEnabled(spec);
  if (!worktreeEnabled) {
    dangerous.push({
      label: "workspace",
      detail:
        "asked NOT to be isolated: it would run in the shared workspace checkout, so its edits and any "
        + "branch switch land where your other work lives. An isolated worktree is the default — this "
        + "proposal deliberately opted out.",
    });
  }

  return {
    id: proposal.id,
    worktreeEnabled,
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
      worktreeEnabled
        ? `runs in its OWN isolated git worktree under the governed worktrees root (path and branch not chosen by the proposer)`
        : `runs in the SHARED workspace checkout — no isolated worktree`,
      `created enabled; not started (no session, no running worktree, no task assignment)`,
    ],
    baseConfigSha256: proposal.base.configSha256,
    baseDiverged: proposal.base.configSha256 !== input.currentConfigSha256,
  };
}
