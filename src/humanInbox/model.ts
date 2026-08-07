/**
 * Human Inbox — the aggregate read-model over pending work and its read-only decision history.
 *
 * Ratified from `docs/reports/2026-07-27-approvals-validations-human-decision.md`, option B, and the
 * whole design is one sentence from it:
 *
 *   > **The inbox is a router, not a resolver.** It reads every store; it writes to none. Each row's
 *   > action dispatches to that kind's existing typed path, with that path's existing authority checks.
 *
 * Three properties this module exists to keep, in the order they matter:
 *
 *  1. **A validation can never be redeemed as an authorization.** Today that is enforced by the type
 *     system for free — `resolveTrustedRecoveryApproval` takes an `ApprovalRequest`, so handing it a
 *     validation does not compile. The report rejected option C precisely because collapsing the two
 *     records would degrade that into a runtime `intent === "authorize"` check repeated at every
 *     redeem site. So the inbox keeps a DISCRIMINATED UNION: the approval payload is only reachable
 *     through the `approval` arm, and there is no shape in this file that both kinds inhabit.
 *  2. **It writes nothing.** No function here resolves, closes, assigns or cancels. Acting on a row is
 *     the caller's job, through `approval.resolve` / `validation.close` / `validation.assign` — the
 *     paths that already carry the host-only rule, requester scoping and payload-hash checks.
 *  3. **The count is derived from the stores**, never from a shell-side constant. `docs/reports/…`
 *     § 4.1 is the cautionary tale: Overview reported `approvals pending: 0` with requests on disk,
 *     because a bundle producer hardcoded an empty list. A security counter that reads zero is worse
 *     than no counter.
 *
 * Pragmatically scoped to approvals + validations, which is what was ratified; proposals, evolution
 * candidates, prototype reviews and pipeline gates are named in the report as later row kinds and can
 * join by adding an arm here, with no change to their models.
 */
import type { ApprovalViewItem } from "../webview/approval/viewModel.js";
import type { ValidationViewItem } from "../webview/validations/viewModel.js";
import type { ArtifactRef } from "../tasks/types.js";
import type { SavedAgentProposalReview } from "../agents/savedAgentProposalReview.js";
import type { SavedAgentRemovalProposalReview } from "../agents/savedAgentRemovalProposalReview.js";
import type { ScheduleProposal } from "../schedule/ProposalStore.js";

export const HUMAN_INBOX_KINDS = ["approval", "saved-agent-proposal", "saved-agent-removal", "schedule-proposal", "validation"] as const;
export type HumanInboxKind = (typeof HUMAN_INBOX_KINDS)[number];

/**
 * Kind severity, highest first. An approval outranks the rest because an approval BLOCKS an agent
 * that cannot proceed without it (and, once granted, is redeemed by a governed Delivery operation),
 * while a validation is evidence waiting to be read.
 *
 * A Saved Agent proposal sits between the two, and the placement is an argument rather than a guess:
 * it blocks nobody — the proposer carries on without it — but approving one creates DURABLE
 * authority, which no validation does and which outlives the session an approval unblocks. So it
 * ranks below the thing that is stuck and above the thing that is merely waiting to be read. This
 * orders the list; it grants nothing.
 *
 * A removal proposal ranks with create proposals: same durable authority weight, opposite direction.
 * A schedule proposal ranks with them too: it blocks nobody, but approval writes durable fleet
 * authority and may create agents repeatedly through `spawn`.
 */
const KIND_SEVERITY: Record<HumanInboxKind, number> = {
  approval: 0,
  "saved-agent-proposal": 1,
  "saved-agent-removal": 1,
  "schedule-proposal": 1,
  validation: 2,
};

/**
 * The kind-specific half of a row. A discriminated union rather than a flattened record: it is what
 * keeps "a validation is not an authorization" a compile-time fact instead of a rule to remember.
 */
export type HumanInboxDetail =
  | { kind: "approval"; approval: ApprovalViewItem }
  | { kind: "saved-agent-proposal"; proposal: SavedAgentProposalReview }
  | { kind: "saved-agent-removal"; proposal: SavedAgentRemovalProposalReview }
  | { kind: "schedule-proposal"; proposal: ScheduleProposal }
  | { kind: "validation"; validation: ValidationViewItem };

/** One row. The shared fields are only what a LIST needs; anything else lives on the `detail` arm. */
export interface HumanInboxItem {
  id: string;
  kind: HumanInboxKind;
  /** one line naming the decision, in that kind's own words */
  title: string;
  /**
   * Who is waiting. For an approval this is the Bridge-resolved requester (unforgeable by
   * construction); for a validation it is the self-declared author. The distinction is real and is
   * why the field carries `requesterTrust` beside it rather than pretending both are the same.
   */
  requester: string;
  requesterTrust: "bridge-resolved" | "self-declared";
  createdAt: string;
  state: "waiting" | "resolved";
  /** Kind-specific terminal result; absent while waiting or on older incomplete records. */
  outcome?: "approved" | "denied" | "cancelled" | "passed" | "failed" | "skipped";
  resolvedAt?: string;
  /** Verbatim proven actor/channel when present; explicit `unattributed` when the store proves none. */
  resolvedBy?: string;
  wsHash: string;
  folder: string;
  /** display-only staleness mark; nothing here auto-approves, auto-denies or auto-closes */
  stale: boolean;
  /** visual evidence to preview inline on the detail route; empty is NOT "validated" */
  artifacts: readonly ArtifactRef[];
  /** something is wrong with the record itself (tampered payload, unreadable) — surface, never drop */
  warning?: string;
  detail: HumanInboxDetail;
}

export interface HumanInboxInput {
  wsHash: string;
  folder: string;
  /** every authoritative approval record, already read from disk by `listApprovalViewItems` */
  approvals: readonly ApprovalViewItem[];
  /** every validation in the workspace; this module decides which ones still await a human */
  validations: readonly ValidationViewItem[];
  /** live Saved Agent proposals, already reviewed into their human-facing shape (SDD 482 phase 4C) */
  savedAgentProposals?: readonly SavedAgentProposalReview[];
  /**
   * Proposal files that exist but could not be trusted. Surfaced as rows rather than counted
   * elsewhere: a corrupt proposal is a thing a human must SEE, and the row is the only place where
   * "someone edited this" is distinguishable from "it was withdrawn".
   */
  untrustedSavedAgentProposals?: readonly { id: string; reason: string }[];
  /** t-afe120 — live Saved Agent removal proposals */
  savedAgentRemovals?: readonly SavedAgentRemovalProposalReview[];
  untrustedSavedAgentRemovals?: readonly { id: string; reason: string }[];
  /** Pending schedules share the Inbox as the sole owner of human decisions. */
  scheduleProposals?: readonly ScheduleProposal[];
}

/** The product's answer when a workspace configures nothing. */
export const DEFAULT_STALE_AFTER_HOURS = 24;

/**
 * t-e4f662 — how long a row may wait before it is MARKED stale, or `"never"`.
 *
 * `"never"` is a real answer, not a disabled feature: a fleet that parks approvals for days on
 * purpose would see every row marked, and a mark that is always on has stopped being a signal. It is
 * spelled as a word rather than as `0` because `0` reads literally as "stale after zero hours" — the
 * OPPOSITE of off — and this loader refuses ambiguity rather than picking the friendlier reading.
 */
export type StaleAfter = number | "never";

export interface HumanInboxOptions {
  /** ISO instant used as "now" for staleness; passed in so the projection stays pure and testable */
  now?: string;
  /** hours after which a row is MARKED stale (display only), or "never". Default 24. */
  staleAfterHours?: StaleAfter;
}

/**
 * Is this validation still waiting on a HUMAN?
 *
 * `closed` is done. An agent-executor validation is work for an agent, not a human decision, so it
 * does not belong in a human's inbox — but a human-executor one does from the moment it exists,
 * which is the signal the report found missing entirely (§1.1: validations have no human signal).
 */
export function validationAwaitsHuman(validation: Pick<ValidationViewItem, "status" | "executor">): boolean {
  return validation.status !== "closed" && validation.executor === "human";
}

function hoursBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return (to - from) / 3_600_000;
}

/** The artifacts a validation offers for inline preview: what it was built from, plus every round's evidence. */
function validationArtifacts(validation: ValidationViewItem): ArtifactRef[] {
  return [...validation.sourceRefs, ...validation.rounds.flatMap((round) => round.evidenceRefs)];
}

function lastClosedValidationRound(validation: ValidationViewItem): ValidationViewItem["rounds"][number] | undefined {
  for (let index = validation.rounds.length - 1; index >= 0; index -= 1) {
    const round = validation.rounds[index];
    if (round?.closedAt) return round;
  }
  return undefined;
}

function validationResolvedBy(validation: ValidationViewItem): string | undefined {
  const actor = lastClosedValidationRound(validation)?.closedBy;
  if (!actor) return validation.status === "closed" ? "unattributed" : undefined;
  if (actor.kind === "unattributed") return actor.name ? `unattributed:${actor.name}` : "unattributed";
  return actor.name ?? actor.kind;
}

/**
 * Project both stores into one ordered list: kind severity first, then oldest-first within a kind,
 * because the thing that has waited longest is the thing a human is most likely to have forgotten.
 */
export function buildHumanInbox(input: HumanInboxInput, options: HumanInboxOptions = {}): HumanInboxItem[] {
  const now = options.now ?? new Date().toISOString();
  const staleAfter = options.staleAfterHours ?? DEFAULT_STALE_AFTER_HOURS;
  // Computed once, here, so the two arms below cannot drift into different staleness rules — the kind
  // of divergence that would make the aggregate count disagree with the rows it counts.
  const isStale = (createdAt: string): boolean =>
    staleAfter !== "never" && hoursBetween(createdAt, now) >= staleAfter;
  const items: HumanInboxItem[] = [];

  for (const approval of input.approvals) {
    const resolved = approval.status === "resolved" && approval.resolution
      ? {
          state: "resolved" as const,
          outcome: approval.resolution.decision,
          resolvedAt: approval.resolution.resolvedAt,
          resolvedBy: approval.resolution.resolvedBy ?? "unattributed",
        }
      : approval.status === "cancelled" && approval.cancellation
        ? {
            state: "resolved" as const,
            outcome: "cancelled" as const,
            resolvedAt: approval.cancellation.cancelledAt,
            resolvedBy: approval.cancellation.cancelledBy,
          }
        : { state: "waiting" as const };
    items.push({
      id: approval.id,
      kind: "approval",
      // The reason is the human-facing sentence the requester wrote; the verbatim payload (and its
      // tamper state) travels on the detail arm, to be shown in full BEFORE any decision.
      title: approval.payload.reason || approval.id,
      requester: approval.requester,
      requesterTrust: "bridge-resolved",
      createdAt: approval.createdAt,
      ...resolved,
      wsHash: input.wsHash,
      folder: input.folder,
      stale: resolved.state === "waiting" && isStale(approval.createdAt),
      artifacts: [],
      ...(approval.warning ? { warning: approval.warning } : {}),
      detail: { kind: "approval", approval },
    });
  }

  for (const proposal of input.savedAgentProposals ?? []) {
    // An expired proposal is not a decision any more; showing it would invite an approval that the
    // commit path would then refuse, which teaches the human that approving does nothing.
    if (proposal.expired) continue;
    items.push({
      id: proposal.id,
      kind: "saved-agent-proposal",
      title: `create Saved Agent '${proposal.agentName}' (${proposal.runtime.adapter})`,
      requester: proposal.proposer,
      // Same trust as an approval, and for the same reason: the Bridge resolved the proposer from the
      // token, so no agent could have named itself here.
      requesterTrust: "bridge-resolved",
      createdAt: proposal.createdAt,
      state: "waiting",
      wsHash: input.wsHash,
      folder: input.folder,
      stale: isStale(proposal.createdAt),
      artifacts: [],
      // The base having moved does not hide the row — it warns on it. The commit path refuses anyway;
      // the human still deserves to know why the button will not work before pressing it.
      ...(proposal.baseDiverged
        ? { warning: "the workspace config changed since this proposal was made — it can no longer be committed as reviewed" }
        : {}),
      detail: { kind: "saved-agent-proposal", proposal },
    });
  }

  for (const untrusted of input.untrustedSavedAgentProposals ?? []) {
    items.push({
      id: untrusted.id,
      kind: "saved-agent-proposal",
      title: `unreadable Saved Agent proposal '${untrusted.id}'`,
      requester: "unknown",
      // Nothing about this file can be attributed, and saying "bridge-resolved" about a record whose
      // proposer field cannot be trusted would be the single most misleading thing on the row.
      requesterTrust: "self-declared",
      createdAt: new Date(0).toISOString(),
      state: "waiting",
      wsHash: input.wsHash,
      folder: input.folder,
      stale: false,
      artifacts: [],
      warning: `this proposal file could not be read or failed its digest check: ${untrusted.reason}`,
      detail: {
        kind: "saved-agent-proposal",
        proposal: {
          id: untrusted.id,
          proposer: "unknown",
          // t-4071e4 — an unreadable proposal asserts NOTHING about isolation, in either direction:
          // `false` would claim it lands in the human's checkout and `true` would claim it does not,
          // both on the strength of a file that failed its digest check. Same reading as the
          // `(unreadable)` name and runtime beside it.
          worktreeEnabled: "unknown",
          proposerTrust: "bridge-resolved",
          digest: "",
          createdAt: new Date(0).toISOString(),
          expiresAt: new Date(0).toISOString(),
          expired: false,
          agentName: "(unreadable)",
          runtime: { adapter: "(unreadable)" },
          ownership: "proposer",
          requestedGrants: [],
          permissionAuthorizations: [],
          rationale: untrusted.reason,
          environmentNames: [],
          requestedOwnership: [],
          requestedSkills: [],
          requestedMcpServers: [],
          requestedHooks: [],
          hasUngrantedCapabilityRequests: false,
          dangerous: [{ label: "unreadable", detail: "this file cannot be trusted and must not be approved" }],
          affected: [],
          baseConfigSha256: "",
          baseDiverged: true,
        },
      },
    });
  }

  for (const proposal of input.savedAgentRemovals ?? []) {
    if (proposal.expired) continue;
    items.push({
      id: proposal.id,
      kind: "saved-agent-removal",
      title: `retire Saved Agent '${proposal.agentName}'`,
      requester: proposal.proposer,
      requesterTrust: "bridge-resolved",
      createdAt: proposal.createdAt,
      state: "waiting",
      wsHash: input.wsHash,
      folder: input.folder,
      stale: isStale(proposal.createdAt),
      artifacts: [],
      ...(proposal.baseDiverged
        ? { warning: "the workspace config changed since this removal proposal was made — it can no longer be committed as reviewed" }
        : {}),
      detail: { kind: "saved-agent-removal", proposal },
    });
  }

  for (const untrusted of input.untrustedSavedAgentRemovals ?? []) {
    items.push({
      id: untrusted.id,
      kind: "saved-agent-removal",
      title: `unreadable Saved Agent removal proposal '${untrusted.id}'`,
      requester: "unknown",
      requesterTrust: "self-declared",
      createdAt: new Date(0).toISOString(),
      state: "waiting",
      wsHash: input.wsHash,
      folder: input.folder,
      stale: false,
      artifacts: [],
      warning: `this removal proposal file could not be read or failed its digest check: ${untrusted.reason}`,
      detail: {
        kind: "saved-agent-removal",
        proposal: {
          id: untrusted.id,
          proposer: "unknown",
          proposerTrust: "bridge-resolved",
          digest: "",
          createdAt: new Date(0).toISOString(),
          expiresAt: new Date(0).toISOString(),
          expired: false,
          agentName: "(unreadable)",
          agentId: "",
          profileRevision: "",
          rationale: untrusted.reason,
          dangerous: [{ label: "unreadable", detail: "this file cannot be trusted and must not be approved" }],
          affected: [],
          baseConfigSha256: "",
          baseDiverged: true,
        },
      },
    });
  }

  for (const validation of input.validations) {
    const waiting = validationAwaitsHuman(validation);
    const resolved = validation.status === "closed" && validation.executor === "human";
    if (!waiting && !resolved) continue;
    const lastClosedRound = lastClosedValidationRound(validation);
    items.push({
      id: validation.id,
      kind: "validation",
      title: validation.title,
      requester: validation.assignee ?? "human",
      requesterTrust: "self-declared",
      createdAt: validation.createdAt,
      state: resolved ? "resolved" : "waiting",
      ...(resolved && lastClosedRound?.outcome ? { outcome: lastClosedRound.outcome } : {}),
      ...(resolved ? { resolvedAt: lastClosedRound?.closedAt ?? validation.updatedAt } : {}),
      ...(resolved ? { resolvedBy: validationResolvedBy(validation) } : {}),
      wsHash: input.wsHash,
      folder: input.folder,
      stale: waiting && isStale(validation.createdAt),
      artifacts: validationArtifacts(validation),
      detail: { kind: "validation", validation },
    });
  }

  for (const proposal of input.scheduleProposals ?? []) {
    // Same rule as Saved Agent proposals: an expired record is no longer an actionable decision.
    const expiry = Date.parse(proposal.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.parse(now)) continue;
    items.push({
      id: proposal.id,
      kind: "schedule-proposal",
      title: `activate schedule '${proposal.name}'`,
      requester: proposal.by,
      requesterTrust: "bridge-resolved",
      createdAt: proposal.createdAt,
      state: "waiting",
      wsHash: input.wsHash,
      folder: input.folder,
      stale: isStale(proposal.createdAt),
      artifacts: [],
      detail: { kind: "schedule-proposal", proposal },
    });
  }

  return items.sort((a, b) => {
    if (a.state !== b.state) return a.state === "waiting" ? -1 : 1;
    if (a.state === "resolved") {
      const byResolved = Date.parse(b.resolvedAt ?? b.createdAt) - Date.parse(a.resolvedAt ?? a.createdAt);
      if (Number.isFinite(byResolved) && byResolved !== 0) return byResolved;
    }
    const bySeverity = KIND_SEVERITY[a.kind] - KIND_SEVERITY[b.kind];
    if (bySeverity !== 0) return bySeverity;
    const byAge = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    return Number.isFinite(byAge) && byAge !== 0 ? byAge : a.id.localeCompare(b.id);
  });
}

export interface HumanInboxCounts {
  total: number;
  approvals: number;
  /** SDD 482 phase 4C — counted separately because approving one creates durable authority. */
  savedAgentProposals: number;
  /** t-afe120 — counted separately because approving one retires durable authority. */
  savedAgentRemovals: number;
  scheduleProposals: number;
  validations: number;
  stale: number;
}

export type HumanInboxStateFilter = "waiting" | "resolved" | "all";
export type HumanInboxOutcomeFilter = NonNullable<HumanInboxItem["outcome"]> | "all";
export type HumanInboxPeriodFilter = "day" | "week" | "month" | "all";

export interface HumanInboxFilters {
  state: HumanInboxStateFilter;
  kind: HumanInboxKind | "all";
  outcome: HumanInboxOutcomeFilter;
  period: HumanInboxPeriodFilter;
  query: string;
}

const PERIOD_MS: Record<Exclude<HumanInboxPeriodFilter, "all">, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

/** Pure client-side query over the authoritative rows; filtering never changes the waiting counter. */
export function filterHumanInboxItems(
  items: readonly HumanInboxItem[],
  filters: HumanInboxFilters,
  now = new Date().toISOString(),
): HumanInboxItem[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const cutoff = filters.period === "all" ? undefined : Date.parse(now) - PERIOD_MS[filters.period];
  return items.filter((item) => {
    if (filters.state !== "all" && item.state !== filters.state) return false;
    if (filters.kind !== "all" && item.kind !== filters.kind) return false;
    if (filters.outcome !== "all" && item.outcome !== filters.outcome) return false;
    if (cutoff !== undefined && item.state === "resolved") {
      const resolvedAt = Date.parse(item.resolvedAt ?? "");
      if (!Number.isFinite(resolvedAt) || resolvedAt < cutoff) return false;
    }
    if (!query) return true;
    return [item.id, item.title, item.requester, item.outcome, item.resolvedBy]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(query));
  });
}

/** The aggregate answer to "how much is waiting on me", derived from the rows themselves. */
export function humanInboxCounts(items: readonly HumanInboxItem[]): HumanInboxCounts {
  const waiting = items.filter((item) => item.state === "waiting");
  return {
    total: waiting.length,
    approvals: waiting.filter((i) => i.kind === "approval").length,
    savedAgentProposals: waiting.filter((i) => i.kind === "saved-agent-proposal").length,
    savedAgentRemovals: waiting.filter((i) => i.kind === "saved-agent-removal").length,
    scheduleProposals: waiting.filter((i) => i.kind === "schedule-proposal").length,
    validations: waiting.filter((i) => i.kind === "validation").length,
    stale: waiting.filter((i) => i.stale).length,
  };
}
