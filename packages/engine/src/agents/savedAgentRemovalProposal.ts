import crypto from "node:crypto";
import type { AgentProfileV1 } from "../config/agentProfileSchema.js";
import { mayProposeSavedAgent } from "./savedAgentProposal.js";

/**
 * t-afe120 — a Saved Agent REMOVAL proposal is inert data, symmetric with the create door.
 *
 * `dismiss_agent` correctly refuses Saved Agents. This module does not loosen that refusal: it is a
 * separate, host-approved retirement path. An agent may only REQUEST removal; the host executes the
 * existing `forgetAgentProfileAgentCascade` after a human approves one exact digest.
 *
 * Fail-closed posture matches the create proposal door: absent grant refuses by name, digests are
 * recomputed on every read, and nothing here retires profile, authority, roster or worktree.
 */

/** Same TTL as create proposals — a removal that sits unreviewed is not evergreen authority. */
export const SAVED_AGENT_REMOVAL_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Per-proposer ceiling shared in spirit with create; keeps attention floods bounded. */
export const SAVED_AGENT_REMOVAL_PROPOSAL_PENDING_CEILING = 3;

export interface SavedAgentRemovalProposalSpec {
  /** Roster name of the Saved Agent to retire. */
  name: string;
  /** Why this agent should be removed — shown to the human verbatim. */
  rationale: string;
}

/** CAS half: the exact identity + config the human reviewed. */
export interface SavedAgentRemovalProposalBase {
  /** SHA-256 of `tachyon.yml` at proposal time. */
  configSha256: string;
  /** Canonical profile revision the forget cascade will re-check. */
  profileRevision: string;
  /** Immutable agentId captured at proposal time — refuse if the name now names a different identity. */
  agentId: string;
}

export interface SavedAgentRemovalProposal {
  id: string;
  proposer: string;
  proposerKind: "agent";
  createdAt: string;
  expiresAt: string;
  spec: SavedAgentRemovalProposalSpec;
  base: SavedAgentRemovalProposalBase;
  digest: string;
}

export type SavedAgentRemovalProposalRefusalCode =
  | "capability_absent"
  | "pending_ceiling"
  | "target_missing"
  | "target_not_saved"
  | "self_removal"
  | "invalid_spec";

export type SavedAgentRemovalProposalAdmission =
  | { ok: true; proposal: SavedAgentRemovalProposal; collapsedOnto?: string }
  | { ok: false; code: SavedAgentRemovalProposalRefusalCode; reason: string };

/** Live facts about the target, gathered by the Bridge/host before admission. */
export interface SavedAgentRemovalTargetFacts {
  /** Present when the name is a profile-backed Saved Agent. */
  profile?: { agentId: string; revision: string };
  /** True when a Temporary (or non-profile) row owns the name. */
  temporary?: boolean;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) out[key] = canonical(entry);
    }
    return out;
  }
  return value;
}

export function computeSavedAgentRemovalProposalDigest(input: {
  proposer: string;
  spec: SavedAgentRemovalProposalSpec;
  base: SavedAgentRemovalProposalBase;
}): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical({ proposer: input.proposer, spec: input.spec, base: input.base })))
    .digest("hex");
}

export function savedAgentRemovalProposalIsExpired(proposal: SavedAgentRemovalProposal, nowMs: number): boolean {
  const expiry = Date.parse(proposal.expiresAt);
  return Number.isFinite(expiry) ? nowMs >= expiry : true;
}

const AGENT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function invalid(reason: string): SavedAgentRemovalProposalAdmission {
  return { ok: false, code: "invalid_spec", reason };
}

/**
 * Pure admission for a removal proposal. Every refusal has a known fail-open shape, so each is
 * written as a named refusal rather than a silent drop.
 */
export function admitSavedAgentRemovalProposal(input: {
  proposer: string;
  proposerProfile: Pick<AgentProfileV1, "grants"> | undefined;
  spec: SavedAgentRemovalProposalSpec;
  base: Omit<SavedAgentRemovalProposalBase, "profileRevision" | "agentId"> & Partial<Pick<SavedAgentRemovalProposalBase, "profileRevision" | "agentId">>;
  target: SavedAgentRemovalTargetFacts;
  pending: readonly SavedAgentRemovalProposal[];
  untrustedPending?: number;
  nowMs: number;
  id: string;
}): SavedAgentRemovalProposalAdmission {
  // Same grant as create: the authority to ASK for durable roster change, not to enact it.
  if (!mayProposeSavedAgent(input.proposerProfile)) {
    return {
      ok: false,
      code: "capability_absent",
      reason:
        `agent '${input.proposer}' has no 'grants.proposeSavedAgent' capability in its profile, so it cannot ` +
        "propose removing a Saved Agent; a human must grant that capability in Agent Studio first",
    };
  }

  if (!AGENT_NAME_RE.test(input.spec.name)) return invalid(`'${input.spec.name}' is not a valid agent name`);
  if (input.spec.rationale.trim().length === 0) return invalid("a removal proposal must carry a non-empty rationale for the human");
  if (!input.base.configSha256) return invalid("a removal proposal must record the base config digest it was computed against");

  if (input.spec.name === input.proposer) {
    return {
      ok: false,
      code: "self_removal",
      reason:
        `agent '${input.proposer}' cannot propose removing itself; self-removal would leave the proposer without a ` +
        "session to receive the outcome, and the host has no safe half-state for that",
    };
  }

  if (input.target.temporary) {
    return {
      ok: false,
      code: "target_not_saved",
      reason:
        `agent '${input.spec.name}' is Temporary, not a Saved Agent; stop it with kill_agent and remove the row with ` +
        "dismiss_agent — this door only retires profile-backed roster entries",
    };
  }

  if (!input.target.profile) {
    return {
      ok: false,
      code: "target_missing",
      reason:
        `agent '${input.spec.name}' is not a profile-backed Saved Agent in this workspace; nothing durable exists ` +
        "for a removal proposal to retire",
    };
  }

  const base: SavedAgentRemovalProposalBase = {
    configSha256: input.base.configSha256,
    profileRevision: input.target.profile.revision,
    agentId: input.target.profile.agentId,
  };

  const digest = computeSavedAgentRemovalProposalDigest({
    proposer: input.proposer,
    spec: input.spec,
    base,
  });

  const live = input.pending.filter((p) => !savedAgentRemovalProposalIsExpired(p, input.nowMs));
  const twin = live.find((p) => p.digest === digest);
  if (twin) return { ok: true, proposal: twin, collapsedOnto: twin.id };

  const untrusted = input.untrustedPending ?? 0;
  const mine = live.filter((p) => p.proposer === input.proposer);
  if (mine.length + untrusted >= SAVED_AGENT_REMOVAL_PROPOSAL_PENDING_CEILING) {
    return {
      ok: false,
      code: "pending_ceiling",
      reason:
        `agent '${input.proposer}' already has ${mine.length} pending Saved Agent removal proposals` +
        (untrusted > 0 ? `, and ${untrusted} queued file(s) could not be read or failed their digest check` : "") +
        ` (ceiling ${SAVED_AGENT_REMOVAL_PROPOSAL_PENDING_CEILING}); resolve or cancel one before proposing another`,
    };
  }

  const createdAt = new Date(input.nowMs).toISOString();
  return {
    ok: true,
    proposal: {
      id: input.id,
      proposer: input.proposer,
      proposerKind: "agent",
      createdAt,
      expiresAt: new Date(input.nowMs + SAVED_AGENT_REMOVAL_PROPOSAL_TTL_MS).toISOString(),
      spec: input.spec,
      base,
      digest,
    },
  };
}
