import crypto from "node:crypto";
import type { AgentProfileV1 } from "../config/agentProfileSchema.js";

/**
 * SDD 482 phase 4 (`t-5e1113`) — a Saved Agent proposal is INERT DATA.
 *
 * ## The baseline this changes, stated first because it is what a reviewer needs
 *
 * Today an agent CANNOT create a Saved Agent by any route: `commitAgentProfileLifecycle`,
 * `createProfileFromStudioMutation` and `importAgentProfileBundle` have no caller under `src/bridge/`.
 * The door is shut, not badly guarded. This phase OPENS it — from "impossible" to "possible with a
 * human approval bound to one exact digest". Every control here is therefore preventive by
 * construction: an agent's output is data that does nothing until a human acts on it. A receipt does
 * not un-create a privileged agent, which is why none of this is left to audit-after-the-fact.
 *
 * ## What this slice deliberately does NOT do
 *
 * There is no Bridge tool, no Human Inbox surface and no commit path here. Those are the next slices.
 * A half-open door — where an agent can queue something a human can approve, and approval does
 * nothing — is worse than a shut one, because it teaches the human that approving is harmless. So the
 * data layer lands first, fully refused-by-default, and stays unreachable until the commit path is
 * proven.
 */

/** Ratified decision 4: a pending proposal lives 24h. */
export const SAVED_AGENT_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Per-proposer ceiling on pending proposals. Not arbitrary caution: a confused agent looping on
 * `propose` denies the human's ATTENTION even though nothing is ever approved, and "approval fatigue"
 * as originally written covered an unreadable diff, not a flooded queue.
 */
export const SAVED_AGENT_PROPOSAL_PENDING_CEILING = 3;

/** The narrow, typed thing an agent may ask for. Anything not here cannot be requested at all. */
export interface SavedAgentProposalSpec {
  /** Roster name of the agent being proposed. */
  name: string;
  /** Runtime adapter id — the same vocabulary the profile schema uses. */
  runtimeAdapter: string;
  /** Optional single executable token, matching `runtimeSchema.executable` rules. */
  executable?: string;
  displayName?: string;
  /** Why this agent should exist. Shown to the human verbatim, never re-summarized. */
  rationale: string;
  /** Non-secret environment values only. A secret reference can never be requested (invariant 8). */
  environment?: Readonly<Record<string, string>>;
  /** Roster ownership the proposer is asking the human to grant. */
  ownsSubagents?: readonly string[];
  /** Resource capabilities requested — skills / MCP / hooks by id. */
  capabilities?: {
    skills?: readonly string[];
    mcp?: readonly string[];
    hooks?: readonly string[];
  };
  /** Authority requested. Present only so it can be REFUSED by name rather than silently dropped. */
  grants?: { proposeSavedAgent?: boolean };
}

/** The base state a proposal was computed against — the CAS half of the TOCTOU control. */
export interface SavedAgentProposalBase {
  /** SHA-256 of `tachyon.yml` at proposal time. */
  configSha256: string;
}

export interface SavedAgentProposal {
  id: string;
  /** Bridge-resolved caller. A proposer can never self-declare this. */
  proposer: string;
  proposerKind: "agent";
  createdAt: string;
  /** `createdAt + SAVED_AGENT_PROPOSAL_TTL_MS`, stored rather than derived so a clock change is visible. */
  expiresAt: string;
  spec: SavedAgentProposalSpec;
  base: SavedAgentProposalBase;
  /** Binds proposer + spec + base. Approval is bound to THIS value, never to the proposer. */
  digest: string;
}

export type SavedAgentProposalRefusalCode =
  | "capability_absent"
  | "capability_recursion"
  | "pending_ceiling"
  | "invalid_spec";

export type SavedAgentProposalAdmission =
  | { ok: true; proposal: SavedAgentProposal; collapsedOnto?: string }
  | { ok: false; code: SavedAgentProposalRefusalCode; reason: string };

/**
 * Whether this profile may PROPOSE a Saved Agent. Fail-closed: absent grants, absent flag and an
 * explicit `false` are all the same answer, and a profile that could not be read is not a profile
 * that granted anything.
 */
export function mayProposeSavedAgent(profile: Pick<AgentProfileV1, "grants"> | undefined): boolean {
  return profile?.grants?.proposeSavedAgent === true;
}

/** Recursively key-sorted JSON — a digest must not depend on the order a caller happened to build an object in. */
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

/**
 * The digest an approval is bound to.
 *
 * It covers the PROPOSER as well as the spec and the base state, and that is deliberate: approving
 * "create agent X with this config" for one proposer must not silently authorize a different agent to
 * get the same thing committed. Two proposers asking for identical agents are two decisions.
 */
export function computeSavedAgentProposalDigest(input: {
  proposer: string;
  spec: SavedAgentProposalSpec;
  base: SavedAgentProposalBase;
}): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical({ proposer: input.proposer, spec: input.spec, base: input.base })))
    .digest("hex");
}

export function savedAgentProposalIsExpired(proposal: SavedAgentProposal, nowMs: number): boolean {
  const expiry = Date.parse(proposal.expiresAt);
  return Number.isFinite(expiry) ? nowMs >= expiry : true; // unparseable expiry fails closed: expired
}

const AGENT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function invalid(reason: string): SavedAgentProposalAdmission {
  return { ok: false, code: "invalid_spec", reason };
}

/**
 * The single admission point for a proposal. Every refusal below has a known way of failing OPEN, so
 * each is written as a refusal rather than as a validation nicety.
 */
export function admitSavedAgentProposal(input: {
  proposer: string;
  proposerProfile: Pick<AgentProfileV1, "grants"> | undefined;
  spec: SavedAgentProposalSpec;
  base: SavedAgentProposalBase;
  /** Pending proposals ALREADY held for this workspace, of every proposer. */
  pending: readonly SavedAgentProposal[];
  nowMs: number;
  id: string;
}): SavedAgentProposalAdmission {
  // 1. Capability. Absence refuses BY NAME — a silent no teaches nothing and looks like a bug.
  if (!mayProposeSavedAgent(input.proposerProfile)) {
    return {
      ok: false,
      code: "capability_absent",
      reason:
        `agent '${input.proposer}' has no 'grants.proposeSavedAgent' capability in its profile, so it cannot ` +
        "propose a Saved Agent; a human must grant that capability in Agent Studio first",
    };
  }

  // 2. Capability recursion (invariant 9). If an approved proposal could itself carry the proposing
  //    capability, one human approval becomes a TREE of creators and the control silently changes
  //    from per-creation to per-principal — which is the alternative this SDD discards by name. The
  //    refusal is here AND at commit, and the proposal FAILS rather than being quietly pruned: a
  //    proposer that asked for this must learn it was refused, not receive a stripped agent.
  if (input.spec.grants?.proposeSavedAgent === true) {
    return {
      ok: false,
      code: "capability_recursion",
      reason:
        "a proposed Saved Agent may never carry 'grants.proposeSavedAgent': one approval would become a tree " +
        "of creators. Granting it stays a separate, visible human edit in Agent Studio",
    };
  }

  if (!AGENT_NAME_RE.test(input.spec.name)) return invalid(`'${input.spec.name}' is not a valid agent name`);
  if (input.spec.rationale.trim().length === 0) return invalid("a proposal must carry a non-empty rationale for the human");
  if (!input.base.configSha256) return invalid("a proposal must record the base config digest it was computed against");

  const digest = computeSavedAgentProposalDigest({ proposer: input.proposer, spec: input.spec, base: input.base });

  // 3. Identical re-proposals COLLAPSE onto the live one instead of queueing. Without this, a retry
  //    loop is indistinguishable from a flood, and the ceiling below would refuse an agent that is
  //    merely retrying rather than misbehaving.
  const live = input.pending.filter((p) => !savedAgentProposalIsExpired(p, input.nowMs));
  const twin = live.find((p) => p.digest === digest);
  if (twin) return { ok: true, proposal: twin, collapsedOnto: twin.id };

  // 4. Per-proposer ceiling, counted AFTER collapse so a retry never consumes a slot.
  const mine = live.filter((p) => p.proposer === input.proposer);
  if (mine.length >= SAVED_AGENT_PROPOSAL_PENDING_CEILING) {
    return {
      ok: false,
      code: "pending_ceiling",
      reason:
        `agent '${input.proposer}' already has ${mine.length} pending Saved Agent proposals ` +
        `(ceiling ${SAVED_AGENT_PROPOSAL_PENDING_CEILING}); resolve or cancel one before proposing another`,
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
      expiresAt: new Date(input.nowMs + SAVED_AGENT_PROPOSAL_TTL_MS).toISOString(),
      spec: input.spec,
      base: input.base,
      digest,
    },
  };
}
