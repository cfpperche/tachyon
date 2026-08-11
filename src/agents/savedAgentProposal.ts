import crypto from "node:crypto";
import type { AgentProfileV1 } from "../config/agentProfileSchema.js";
import {
  defaultClaudeScalarNativeConfigPolicy,
  defaultCodexScalarNativeConfigPolicy,
  defaultGrokNativeConfigPolicy,
  claudeScalarNativeConfigPolicy,
  codexScalarNativeConfigPolicy,
  grokScalarNativeConfigPolicy,
  claudeSelectorNativeConfigPolicy,
  codexSelectorNativeConfigPolicy,
  grokSelectorNativeConfigPolicy,
} from "../config/agentNativeConfigPolicy.js";
import {
  assertOwnershipTargets,
  createProfileFromStudioMutation,
  DEFAULT_NEW_AGENT_WORKTREE_ENABLED,
  type AgentOwnershipRosterV1,
  type AgentProfileStudioMutationV1,
} from "../config/agentProfileStudio.js";

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
  /** Typed runtime selectors. Both are digest-bound and shown before approval. */
  model?: string;
  reasoningEffort?: string;
  /**
   * Explicit, runtime-native permission capabilities the human is being asked to authorize.
   * These are validated by the same closed projector policy as Agent Studio; a runtime cannot carry
   * another runtime's authorization.
   */
  permissionAuthorizations?: readonly string[];
  /** Why this agent should exist. Shown to the human verbatim, never re-summarized. */
  rationale: string;
  /** Non-secret environment values only. A secret reference can never be requested (invariant 8). */
  environment?: Readonly<Record<string, string>>;
  /**
   * A proposal may not reparent existing agents. Kept in the type so that request is refused BY NAME
   * rather than silently dropped.
   */
  ownsSubagents?: readonly string[];
  /** Resource capabilities requested — skills / MCP / hooks by id. */
  capabilities?: {
    skills?: readonly string[];
    mcp?: readonly string[];
    hooks?: readonly string[];
  };
  /** Authority requested. Human approval is the only path that can grant it. */
  grants?: { proposeSavedAgent?: boolean };
  /**
   * Durable roster ownership created with the profile. Absent preserves the v1 behavior.
   * `top-level` creates no declaredOwner edge; it does not imply operational independence or lineage.
   */
  ownership?: "proposer" | "top-level";
  /**
   * t-4071e4 — the workspace isolation policy, and the ONLY workspace decision a proposer may express.
   *
   * Dogfood found the asymmetry this closes: hand-made Claude agents carry
   * `workspace.worktree.enabled: true`, while `grok-builder` and `codex-builder` — both created
   * through this door — were born with it false, because the contract could not carry the field at all
   * and the approval path hardcoded `enabled: false`. The proposer could not ask for isolation and,
   * worse, the human never saw the decision at review.
   *
   * `worktree` is a BOOLEAN and nothing else. `path`, `branch` and `base` are deliberately absent from
   * this type: a proposer that could name a path would choose where the new agent's checkout lands,
   * which is an escape from the governed worktree root rather than a workspace preference. Those keys
   * are refused BY NAME at admission, on the same doctrine as `grants` and `ownsSubagents` — a request
   * the proposer must learn was refused, never silently pruned.
   *
   * Absent means ON. Ratified 2026-07-29 (option b): every proposed Saved Agent is born isolated, the
   * human sees it at review and may turn it off before approving. The default infers nothing from the
   * agent's name or role — it is one declared policy for this door.
   */
  workspace?: { worktree?: boolean };
}

/**
 * t-4071e4 — workspace keys a proposer may never express, refused by name.
 *
 * Kept as data rather than as `if` branches so the refusal message and the check cannot drift, and so
 * adding a key is one edit. These are the fields that would let a proposal choose WHERE the checkout
 * lands; `worktree` (whether it is isolated at all) is the only workspace question a proposer gets.
 */
export const REFUSED_PROPOSAL_WORKSPACE_KEYS = ["path", "branch", "base", "cwd", "worktreeBase"] as const;

/** The isolation a proposal resolves to. Absent means ON — see `SavedAgentProposalSpec.workspace`. */
export function proposedWorktreeEnabled(spec: Pick<SavedAgentProposalSpec, "workspace">): boolean {
  return spec.workspace?.worktree ?? DEFAULT_NEW_AGENT_WORKTREE_ENABLED;
}

/**
 * t-4071e4 — the create mutation an approved proposal commits, as a pure function.
 *
 * This lived inline in the approval closure in `extension.ts`, where no test could reach it, and that
 * is precisely how it came to hardcode `worktree: { enabled: false }`: an agent born through the
 * governed door came out LESS isolated than a hand-made one, and no assertion could notice. Extracted
 * so the host wiring and the tests exercise the same authority.
 *
 * Every field a proposer does NOT get to influence is fixed here rather than read from the spec:
 * `branch` and `cwd` stay empty (a proposal may say whether it is isolated, never where the checkout
 * lands), `autostart` stays false (approving creates, it does not start), and `capabilities` stay empty
 * (the canonical create refuses references before host authorization).
 */
export function savedAgentCreateMutation(
  agentName: string,
  spec: Pick<SavedAgentProposalSpec,
    "displayName" | "runtimeAdapter" | "executable" | "workspace" | "model" | "reasoningEffort"
    | "permissionAuthorizations">,
): AgentProfileStudioMutationV1 {
  const needsNativeConfig = Boolean(spec.model || spec.reasoningEffort || spec.permissionAuthorizations?.length);
  const authorizations = [...(spec.permissionAuthorizations ?? [])];
  const nativeConfig = needsNativeConfig
    ? spec.runtimeAdapter === "claude"
      ? {
          ...defaultClaudeScalarNativeConfigPolicy(),
          permissions: claudeScalarNativeConfigPolicy("global", authorizations),
          ...(spec.model || spec.reasoningEffort ? { selectors: claudeSelectorNativeConfigPolicy() } : {}),
        }
      : spec.runtimeAdapter === "codex"
        ? {
            ...defaultCodexScalarNativeConfigPolicy(),
            permissions: codexScalarNativeConfigPolicy("global", authorizations),
            ...(spec.model || spec.reasoningEffort ? { selectors: codexSelectorNativeConfigPolicy() } : {}),
          }
        : spec.runtimeAdapter === "grok"
          ? {
              ...defaultGrokNativeConfigPolicy(),
              permissions: grokScalarNativeConfigPolicy("global", authorizations),
              ...(spec.model || spec.reasoningEffort ? { selectors: grokSelectorNativeConfigPolicy() } : {}),
            }
          : undefined
    : undefined;
  return {
    schemaVersion: 1,
    kind: "agent-instance",
    agentName,
    editable: {
      displayName: spec.displayName ?? "",
      runtime: {
        adapter: spec.runtimeAdapter,
        executable: spec.executable ?? spec.runtimeAdapter,
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
      },
      cwd: "",
      // t-bd14d8 — no `watch`: the editable schema is strict and an Agent has no file watch.
      lifecycle: { autostart: false, restart: "never", attention: true },
      // t-afc86e — a proposal carries no setup commands: the proposer describes an
      // agent, and workspace-local build steps are the human's to add after approval.
      worktree: { enabled: proposedWorktreeEnabled(spec), branch: "", setup: [] },
      // t-d48775 — and a proposal carries no persistent instructions, for the reason directly above.
      // The Studio field is now writable, so this is the second door onto the same binding: an agent
      // that could fill it would be authoring the durable prompt of an agent a human has not read yet.
      // The human adds them after approval, standing in the form, exactly as with setup commands.
      instructions: "",
      isolation: "",
      ...(nativeConfig ? { nativeConfig } : {}),
      capabilities: { skills: [], mcp: [], hooks: [] },
    },
  };
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
  | "pending_ceiling"
  | "ownership_conflict"
  /** t-4071e4 — a workspace key the proposer may not choose (path/branch/base), refused by name. */
  | "workspace_field_refused"
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
  /**
   * Files in the queue that could not be trusted. They cannot be attributed to a proposer or matched
   * by digest, so they cannot collapse — but they DO occupy the queue, and ignoring them would let a
   * writer corrupt a pending proposal to make it invisible and get a fresh id every time.
   */
  untrustedPending?: number;
  /**
   * The workspace roster, for validating requested ownership against the spec 352 contract. Absent
   * means the caller could not read it — and that is treated as a REFUSAL when ownership is requested,
   * never as permission, because "I could not check" and "it is fine" are different answers.
   */
  roster?: AgentOwnershipRosterV1;
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

  // A recursive grant is no longer rejected here: it is inert proposal data, digest-bound and shown
  // as high-risk authority. It can become durable only through the host-only human approval path.

  // t-4071e4 — a workspace key that would choose WHERE the checkout lands is refused by name, before
  // anything reaches the queue. Silently dropping it would let a proposer believe it had been honored
  // and would let a human approve a request that was quietly different from the one displayed.
  const requestedWorkspace = input.spec.workspace as Record<string, unknown> | undefined;
  if (requestedWorkspace) {
    const refused = REFUSED_PROPOSAL_WORKSPACE_KEYS.filter((key) => key in requestedWorkspace);
    if (refused.length > 0) {
      return {
        ok: false,
        code: "workspace_field_refused",
        reason:
          `a proposal may not request workspace ${refused.map((key) => `'${key}'`).join(", ")}: the checkout `
          + "location is governed by the workspace, not chosen by the proposer. Only 'worktree' (isolated or "
          + "not) may be requested",
      };
    }
    if (requestedWorkspace.worktree !== undefined && typeof requestedWorkspace.worktree !== "boolean") {
      return {
        ok: false,
        code: "workspace_field_refused",
        reason: "'workspace.worktree' must be a boolean: isolated or not is the only workspace choice a proposal carries",
      };
    }
  }

  if (!AGENT_NAME_RE.test(input.spec.name)) return invalid(`'${input.spec.name}' is not a valid agent name`);
  try {
    createProfileFromStudioMutation(savedAgentCreateMutation(input.spec.name, input.spec));
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }

  // 3. Ownership. A proposal that reparents an existing agent is a roster
  //    edit wearing a creation request — a different decision, with a different blast radius, and one
  //    the human would be approving without it being the thing they were asked about.
  if (input.spec.ownsSubagents?.length) {
    return {
      ok: false,
      code: "ownership_conflict",
      reason:
        "a proposal cannot declare subagents: the proposer becomes the new agent's declared owner, and " +
        "reparenting an existing agent is a separate roster edit in Agent Studio, not part of creating one",
    };
  }

  // The edge that WILL be written — proposer owns the new agent — is validated here too, against the
  // same spec 352 rules a Studio edit obeys, so the conflict surfaces before a human approves rather
  // than as an opaque config rollback afterwards. Fail-closed is not the same as well-behaved.
  if ((input.spec.ownership ?? "proposer") === "proposer" && !input.roster) {
    return {
      ok: false,
      code: "ownership_conflict",
      reason:
        "the workspace roster is unavailable, so the ownership this proposal would create cannot be validated; " +
        "refusing rather than deferring the check to after a human approves",
    };
  }
  if ((input.spec.ownership ?? "proposer") === "proposer") try {
    const ownershipRoster = input.roster!;
    // The synthetic entry stands in for the agent that does not exist yet — appended ONLY when the
    // name is free. Appending unconditionally would shadow a REAL entry of the same name (a later
    // key wins in the Map), which would turn a name collision with an owned agent or a terminal into
    // a silent pass — the check defeating itself.
    const roster = ownershipRoster.some((entry) => entry.name === input.spec.name)
      ? ownershipRoster
      : [...ownershipRoster, { name: input.spec.name, kind: "agent" as const, subagents: [] }];
    assertOwnershipTargets(input.proposer, [input.spec.name], roster);
  } catch (error) {
    return { ok: false, code: "ownership_conflict", reason: error instanceof Error ? error.message : String(error) };
  }
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
  const untrusted = input.untrustedPending ?? 0;
  const mine = live.filter((p) => p.proposer === input.proposer);
  if (mine.length + untrusted >= SAVED_AGENT_PROPOSAL_PENDING_CEILING) {
    return {
      ok: false,
      code: "pending_ceiling",
      reason:
        `agent '${input.proposer}' already has ${mine.length} pending Saved Agent proposals` +
        (untrusted > 0 ? `, and ${untrusted} queued file(s) could not be read or failed their digest check` : "") +
        ` (ceiling ${SAVED_AGENT_PROPOSAL_PENDING_CEILING}); resolve or cancel one before proposing another`,
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
