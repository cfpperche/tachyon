import type { SavedAgentProposalDanger, SavedAgentProposalReview } from "@tachyon/webview-ui/agents/savedAgentProposalReview";
export type { SavedAgentProposalDanger, SavedAgentProposalReview } from "@tachyon/webview-ui/agents/savedAgentProposalReview";
import type { SavedAgentProposal } from "@tachyon/engine/agents/savedAgentProposal.js";
import { proposedWorktreeEnabled } from "@tachyon/engine/agents/savedAgentProposal.js";
import { savedAgentProposalIsExpired } from "@tachyon/engine/agents/savedAgentProposal.js";

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
  if (spec.grants?.proposeSavedAgent) {
    dangerous.push({
      label: "agent creation authority",
      detail:
        "would grant 'proposeSavedAgent'. The new agent could ask you to create further Saved Agents, "
        + "but every request would still require a separate human approval.",
    });
  }
  if (spec.permissionAuthorizations?.length) {
    dangerous.push({
      label: "permission bypass authority",
      detail:
        `would authorize ${spec.permissionAuthorizations.join(", ")} for this agent. These capabilities can suppress `
        + "runtime permission prompts and apply only to this approved profile.",
    });
  }
  if ((spec.ownership ?? "proposer") === "top-level") {
    dangerous.push({
      label: "top-level ownership",
      detail: "creates no declaredOwner edge. The proposer will not own this Saved Agent in the sidebar roster.",
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
        "asked to use the shared workspace checkout, so its edits and any "
        + "branch switch land where your other work lives. A separate worktree is the default — this "
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
    runtime: {
      adapter: spec.runtimeAdapter,
      ...(spec.executable ? { executable: spec.executable } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
    },
    ownership: spec.ownership ?? "proposer",
    requestedGrants: spec.grants?.proposeSavedAgent ? ["proposeSavedAgent"] : [],
    permissionAuthorizations: [...(spec.permissionAuthorizations ?? [])],
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
      (spec.ownership ?? "proposer") === "proposer"
        ? `${proposal.proposer} → ownership.subagents adds ${spec.name}`
        : `no declaredOwner edge (top-level Saved Agent)`,
      worktreeEnabled
        ? `runs in its OWN git worktree under the governed worktrees root (separate checkout and branch; path and branch not chosen by the proposer)`
        : `runs in the SHARED workspace checkout — no separate worktree`,
      `created enabled; not started (no session, no running worktree, no task assignment)`,
    ],
    baseConfigSha256: proposal.base.configSha256,
    baseDiverged: proposal.base.configSha256 !== input.currentConfigSha256,
  };
}
