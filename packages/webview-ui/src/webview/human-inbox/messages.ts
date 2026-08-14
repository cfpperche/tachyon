/**
 * Human Inbox — the wire between Control's host and the unified surface (t-e76acc).
 *
 * Every message and action carries its own type strings, distinct from the Approvals and Validations
 * surfaces even where the shape looks identical. That is not ceremony: `board` and
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
import type { ApprovalDecision } from "@tachyon/engine/bridge/approvalRequest.js";
import type { ValidationOutcome } from "@tachyon/engine/validations/types.js";
import type { HumanInboxKind } from "../../humanInbox/model";
import type { HumanInboxViewModel, HumanInboxItemViewModel } from "./viewModel";
import { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export { READY, readyMessage, type ReadyMessage };

export const HUMAN_INBOX = "humanInbox" as const;
export const HUMAN_INBOX_ERROR = "humanInboxError" as const;

/**
 * SDD 485 D4 — the standalone app's own 3s timer, and a DIFFERENT word from `refreshInbox`.
 *
 * Inside Control this model was re-posted by Control's shell poll; standing alone the app owns the timer.
 * The separation is D3's call rather than D2's, and the difference is worth stating because the check that
 * decided it is the one the brief asked for: `refreshInbox`'s host handler is `sendInbox(); sendInboxItem();`
 * — a pure re-read with no side effect — so sharing the word would have been SAFE here, unlike Plugins,
 * whose `refresh` drops every update check it has found (t-0fc9ee by a new road).
 *
 * It is still separated, for one constant: `refreshInbox` is a human pressing the Refresh button on a panel
 * someone is looking at, and the poll is exactly what `PanelWorkGate` exists to suppress behind another tab.
 * Keeping them distinguishable in the gate costs nothing and stops a future side effect on the human action
 * from silently acquiring a 20×/min caller.
 */
export const POLL = "pollInbox" as const;
export interface PollInboxMessage {
  type: typeof POLL;
}
export function pollInboxAction(): PollInboxMessage {
  return { type: POLL };
}

/**
 * t-58f9e9 — one RECEIPT of a host refusal, not the refusal's text.
 *
 * The detail route clears its pending state when this changes, and a bare `string` cannot say
 * "refused again" when the reason is the same one as last time: `useState` bails out on an equal
 * value, so no re-render happens, so the effect watching it never runs. Measured in the shipped
 * preact/hooks: the dispatcher is `t !== r && (…setState({}))`.
 *
 * That is not academic. A repeated refusal is the LIKELY case — it is what happens whenever the
 * cause was not fixed between two attempts — and it left Approve and Deny disabled until the human
 * navigated away, which is the same dead-button symptom this whole task was filed about.
 *
 * The object is rebuilt on every receipt so identity always changes. The type exists to stop a later
 * simplification back to `string`, which would look tidier and restore the bug.
 */
export interface HumanInboxErrorReceipt {
  message: string;
}
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
  | PollInboxMessage
  | { type: "refreshInbox" }
  | { type: "openInboxItem"; kind: HumanInboxKind; id: string }
  /**
   * SDD 485 D4 — back to the list, from an opened item.
   *
   * Inside Control this was not a message at all: `cockpit/App.tsx` rendered a `← Inbox` breadcrumb that
   * posted `onSetSection("inbox")`, so the affordance belonged to the EMBED HOST rather than to this
   * surface. Standing alone there is no host to own it, and an item route with no way back is a dead end —
   * so the app carries its own, and the host owns the subroute the same way Control's router did.
   */
  | { type: "closeInboxItem" }
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
  | { type: "decideSavedAgentProposal"; id: string; digest: string; decision: "approve" | "deny"; reason?: string }
  /** t-afe120 — same digest binding as create, opposite durable effect */
  | { type: "decideSavedAgentRemoval"; id: string; digest: string; decision: "approve" | "deny"; reason?: string }
  | { type: "decideScheduleProposal"; id: string; decision: "approve" | "deny" };

export const humanInboxMessage = (vm: HumanInboxViewModel): HumanInboxMessage => ({ type: HUMAN_INBOX, vm });
export const humanInboxErrorMessage = (message: string): HumanInboxErrorMessage => ({ type: HUMAN_INBOX_ERROR, message });
export const humanInboxItemMessage = (vm: HumanInboxItemViewModel): HumanInboxItemMessage => ({ type: HUMAN_INBOX_ITEM, vm });
export const humanInboxItemMissingMessage = (kind: HumanInboxKind, id: string): HumanInboxItemMissingMessage => ({
  type: HUMAN_INBOX_ITEM_MISSING,
  kind,
  id,
});

export const refreshInboxAction = (): HumanInboxAction => ({ type: "refreshInbox" });
export const closeInboxItemAction = (): HumanInboxAction => ({ type: "closeInboxItem" });
export const decideSavedAgentProposalAction = (
  id: string,
  digest: string,
  decision: "approve" | "deny",
  reason?: string,
): HumanInboxAction => ({ type: "decideSavedAgentProposal", id, digest, decision, ...(reason ? { reason } : {}) });
export const decideSavedAgentRemovalAction = (
  id: string,
  digest: string,
  decision: "approve" | "deny",
  reason?: string,
): HumanInboxAction => ({ type: "decideSavedAgentRemoval", id, digest, decision, ...(reason ? { reason } : {}) });
export const decideScheduleProposalAction = (id: string, decision: "approve" | "deny"): HumanInboxAction =>
  ({ type: "decideScheduleProposal", id, decision });
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
