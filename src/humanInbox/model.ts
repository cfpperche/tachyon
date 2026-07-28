/**
 * Human Inbox — the aggregate read-model over everything waiting on a human (t-e76acc).
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

export const HUMAN_INBOX_KINDS = ["approval", "validation"] as const;
export type HumanInboxKind = (typeof HUMAN_INBOX_KINDS)[number];

/**
 * Kind severity, highest first. An approval outranks a validation because an approval BLOCKS an agent
 * that cannot proceed without it (and, once granted, is redeemed by a governed Delivery operation),
 * while a validation is evidence waiting to be read. This orders the list; it grants nothing.
 */
const KIND_SEVERITY: Record<HumanInboxKind, number> = { approval: 0, validation: 1 };

/**
 * The kind-specific half of a row. A discriminated union rather than a flattened record: it is what
 * keeps "a validation is not an authorization" a compile-time fact instead of a rule to remember.
 */
export type HumanInboxDetail =
  | { kind: "approval"; approval: ApprovalViewItem }
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
  /** pending approvals, already read from disk by `listPendingApprovalViewItems` */
  approvals: readonly ApprovalViewItem[];
  /** every validation in the workspace; this module decides which ones still await a human */
  validations: readonly ValidationViewItem[];
}

export interface HumanInboxOptions {
  /** ISO instant used as "now" for staleness; passed in so the projection stays pure and testable */
  now?: string;
  /** hours after which a row is MARKED stale (display only). Default 24. */
  staleAfterHours?: number;
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

/**
 * Project both stores into one ordered list: kind severity first, then oldest-first within a kind,
 * because the thing that has waited longest is the thing a human is most likely to have forgotten.
 */
export function buildHumanInbox(input: HumanInboxInput, options: HumanInboxOptions = {}): HumanInboxItem[] {
  const now = options.now ?? new Date().toISOString();
  const staleAfterHours = options.staleAfterHours ?? 24;
  const items: HumanInboxItem[] = [];

  for (const approval of input.approvals) {
    items.push({
      id: approval.id,
      kind: "approval",
      // The reason is the human-facing sentence the requester wrote; the verbatim payload (and its
      // tamper state) travels on the detail arm, to be shown in full BEFORE any decision.
      title: approval.payload.reason || approval.id,
      requester: approval.requester,
      requesterTrust: "bridge-resolved",
      createdAt: approval.createdAt,
      wsHash: input.wsHash,
      folder: input.folder,
      stale: hoursBetween(approval.createdAt, now) >= staleAfterHours,
      artifacts: [],
      ...(approval.warning ? { warning: approval.warning } : {}),
      detail: { kind: "approval", approval },
    });
  }

  for (const validation of input.validations) {
    if (!validationAwaitsHuman(validation)) continue;
    items.push({
      id: validation.id,
      kind: "validation",
      title: validation.title,
      requester: validation.assignee ?? "human",
      requesterTrust: "self-declared",
      createdAt: validation.createdAt,
      wsHash: input.wsHash,
      folder: input.folder,
      stale: hoursBetween(validation.createdAt, now) >= staleAfterHours,
      artifacts: validationArtifacts(validation),
      detail: { kind: "validation", validation },
    });
  }

  return items.sort((a, b) => {
    const bySeverity = KIND_SEVERITY[a.kind] - KIND_SEVERITY[b.kind];
    if (bySeverity !== 0) return bySeverity;
    const byAge = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    return Number.isFinite(byAge) && byAge !== 0 ? byAge : a.id.localeCompare(b.id);
  });
}

export interface HumanInboxCounts {
  total: number;
  approvals: number;
  validations: number;
  stale: number;
}

/** The aggregate answer to "how much is waiting on me", derived from the rows themselves. */
export function humanInboxCounts(items: readonly HumanInboxItem[]): HumanInboxCounts {
  return {
    total: items.length,
    approvals: items.filter((i) => i.kind === "approval").length,
    validations: items.filter((i) => i.kind === "validation").length,
    stale: items.filter((i) => i.stale).length,
  };
}
