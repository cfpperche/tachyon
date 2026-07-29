/**
 * Human Inbox — the wire between Control's host and the unified surface (t-e76acc).
 *
 * Every message and action carries its own type strings, distinct from the Approvals and Validations
 * surfaces even where the shape looks identical. That is not ceremony: `mission-control` and
 * `task-detail` both shipped a `"taskError"` message and Control's single client had to keep a route
 * ref around just to tell whose error it was (see cockpit/main.tsx's `activeRouteRef` comment). One
 * more surface reusing a neighbour's wire string would repeat exactly that.
 *
 * ACTING on a row is never expressed here as a generic "resolve". Each action names the kind it
 * belongs to, so the host dispatches into that kind's existing typed path — `approval.resolve` for an
 * approval, `closeValidation`/`assignValidation` for a validation — and a validation has no wire
 * shape at all that could reach the approval path. "A validation is not an authorization" holds on
 * the wire for the same reason it holds in the model: there is no message that says otherwise.
 */
import type { ApprovalDecision } from "../../bridge/approvalRequest";
import type { ValidationOutcome } from "../../validations/types";
import type { HumanInboxKind } from "../../humanInbox/model";
import type { HumanInboxViewModel, HumanInboxItemViewModel } from "./viewModel";
import { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export { READY, readyMessage, type ReadyMessage };

export const HUMAN_INBOX = "humanInbox" as const;
export const HUMAN_INBOX_ERROR = "humanInboxError" as const;
export const HUMAN_INBOX_ITEM = "humanInboxItem" as const;
/** the opened item is gone (resolved/closed elsewhere, or never existed) — its own state, not an error */
export const HUMAN_INBOX_ITEM_MISSING = "humanInboxItemMissing" as const;

export interface HumanInboxMessage {
  type: typeof HUMAN_INBOX;
  vm: HumanInboxViewModel;
}

export interface HumanInboxErrorMessage {
  type: typeof HUMAN_INBOX_ERROR;
  message: string;
}

export interface HumanInboxItemMessage {
  type: typeof HUMAN_INBOX_ITEM;
  vm: HumanInboxItemViewModel;
}

export interface HumanInboxItemMissingMessage {
  type: typeof HUMAN_INBOX_ITEM_MISSING;
  kind: HumanInboxKind;
  id: string;
}

export type HumanInboxHostMessage =
  | HumanInboxMessage
  | HumanInboxErrorMessage
  | HumanInboxItemMessage
  | HumanInboxItemMissingMessage;

export type HumanInboxAction =
  | ReadyMessage
  | { type: "refreshInbox" }
  | { type: "openInboxItem"; kind: HumanInboxKind; id: string }
  /** approval-only: the capability path the Delivery later redeems */
  | { type: "resolveInboxApproval"; id: string; decision: ApprovalDecision }
  /** validation-only: evidence being read and closed out; can never authorize anything */
  | { type: "closeInboxValidation"; id: string; outcome: ValidationOutcome; note: string }
  | { type: "assignInboxValidation"; id: string; assignee: string; expect: { assignee: string | null; updatedAt: string } }
  /**
   * SDD 482 phase 4C — the approval carries the DIGEST the human was shown, not just the id. The
   * commit path compares it, so a proposal that changed between render and click is refused rather
   * than approved on the strength of a stale pane.
   */
  | { type: "decideSavedAgentProposal"; id: string; digest: string; decision: "approve" | "deny"; reason?: string };

export const humanInboxMessage = (vm: HumanInboxViewModel): HumanInboxMessage => ({ type: HUMAN_INBOX, vm });
export const humanInboxErrorMessage = (message: string): HumanInboxErrorMessage => ({ type: HUMAN_INBOX_ERROR, message });
export const humanInboxItemMessage = (vm: HumanInboxItemViewModel): HumanInboxItemMessage => ({ type: HUMAN_INBOX_ITEM, vm });
export const humanInboxItemMissingMessage = (kind: HumanInboxKind, id: string): HumanInboxItemMissingMessage => ({
  type: HUMAN_INBOX_ITEM_MISSING,
  kind,
  id,
});

export const refreshInboxAction = (): HumanInboxAction => ({ type: "refreshInbox" });
export const decideSavedAgentProposalAction = (
  id: string,
  digest: string,
  decision: "approve" | "deny",
  reason?: string,
): HumanInboxAction => ({ type: "decideSavedAgentProposal", id, digest, decision, ...(reason ? { reason } : {}) });
export const openInboxItemAction = (kind: HumanInboxKind, id: string): HumanInboxAction => ({ type: "openInboxItem", kind, id });
export const resolveInboxApprovalAction = (id: string, decision: ApprovalDecision): HumanInboxAction => ({
  type: "resolveInboxApproval",
  id,
  decision,
});
export const closeInboxValidationAction = (id: string, outcome: ValidationOutcome, note: string): HumanInboxAction => ({
  type: "closeInboxValidation",
  id,
  outcome,
  note,
});
export const assignInboxValidationAction = (
  id: string,
  assignee: string,
  expect: { assignee: string | null; updatedAt: string },
): HumanInboxAction => ({ type: "assignInboxValidation", id, assignee, expect });
